//! 斗鱼直链续流。
//!
//! 斗鱼下发给第三方的 flv 直链寿命固定 300 秒，到点 CDN 主动 EOF，与网络、
//! 主播、CDN、清晰度无关（实测 hw-h5 / hs-h5 / scdn 各线路误差均 < 0.5s，
//! 部分线路的 URL 甚至不带 `expire` 参数但同样准时断开，说明这是服务端策略）。
//! 斗鱼官方网页端的做法是每 ~300 秒重新调一次取流接口续签，本模块做的是同一件事：
//! 在旧流到期前预取下一条流，在 FLV tag 边界上接续，对播放器表现为一条不中断的流。
//!
//! 接续之所以成立，是因为斗鱼 flv tag 用的是推流会话的绝对时间戳，重新取流后
//! 时间轴延续而非归零，因此无需改写时间戳，只要丢掉新流的文件头与初始化 tag，
//! 并从第一个时间戳大于已转发位置的关键帧接上即可。

use bytes::{Bytes, BytesMut};
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use std::io::{Error as IoError, ErrorKind};
use std::pin::Pin;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// 斗鱼直链的硬性寿命。
const STREAM_TTL: Duration = Duration::from_secs(300);
/// 提前多久预取下一条流。实测取流 ~650ms + 首个关键帧 ~220ms，5 秒余量充足；
/// 留得过长会让预取连接在切换前积压过多数据。
const RENEW_LEAD: Duration = Duration::from_secs(5);
/// 预取失败后的重试间隔。
const RETRY_DELAY: Duration = Duration::from_millis(500);
/// 连续取流失败多少次后放弃，交给前端走原有的错误提示。
const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// 解析缓冲的上限。单个 FLV tag 远小于此值，超过即说明字节流无法按 FLV 解析。
const MAX_PENDING_BUFFER: usize = 8 * 1024 * 1024;
/// 上游多久没有任何数据就视为断流（直播流正常每秒都有数据）。
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
/// 一次取流（解析地址 + 建立连接）的总期限。
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);
/// 接续时新旧时间戳相差超过此值即视为时间轴中断（主播重推后时间戳归零等）。
const DISCONTINUITY_THRESHOLD_MS: i64 = 10_000;
/// 时间轴中断时，接续点放在旧位置之后多少毫秒（约一帧）。
const DISCONTINUITY_GAP_MS: i64 = 40;

pub type ByteStream = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>;

/// 重新取流所需的上下文。仅斗鱼会设置，其余平台为 None 并因此保持原有的直通行为。
#[derive(Clone, Debug)]
pub struct StreamRenewContext {
    pub room_id: String,
    pub quality: String,
    pub line: Option<String>,
}

#[derive(Debug)]
struct FlvTag {
    /// 完整 tag 字节：11 字节 tag 头 + data + 4 字节 PreviousTagSize。
    raw: Bytes,
    tag_type: u8,
    timestamp: u32,
    is_keyframe: bool,
    is_sequence_header: bool,
}

impl FlvTag {
    /// tag 的 data 部分（不含 11 字节头与 PreviousTagSize）。
    fn payload(&self) -> &[u8] {
        &self.raw[11..self.raw.len() - 4]
    }

    /// 返回改写了时间戳的副本。
    fn retimed(&self, timestamp: u32) -> FlvTag {
        let mut raw = BytesMut::from(&self.raw[..]);
        raw[4] = (timestamp >> 16) as u8;
        raw[5] = (timestamp >> 8) as u8;
        raw[6] = timestamp as u8;
        raw[7] = (timestamp >> 24) as u8;
        FlvTag {
            raw: raw.freeze(),
            tag_type: self.tag_type,
            timestamp,
            is_keyframe: self.is_keyframe,
            is_sequence_header: self.is_sequence_header,
        }
    }
}

const TAG_TYPE_AUDIO: u8 = 8;
const TAG_TYPE_VIDEO: u8 = 9;
const TAG_TYPE_SCRIPT: u8 = 18;

/// 增量 FLV 解析：喂入任意大小的字节块，按需吐出完整 tag。
#[derive(Default)]
struct FlvDemuxer {
    buf: BytesMut,
    header: Option<Bytes>,
    header_parsed: bool,
    /// 文件头以 "FLV" 开头（与 header 是否已被取走无关）。
    is_flv: bool,
}

impl FlvDemuxer {
    fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// 解析文件头（"FLV" + 版本 + 标志 + dataOffset，后随 PreviousTagSize0）。
    /// 返回 false 表示数据还不够，下次再试。
    fn try_parse_header(&mut self) -> bool {
        if self.header_parsed {
            return true;
        }
        if self.buf.len() < 13 {
            return false;
        }
        if &self.buf[..3] == b"FLV" {
            let data_offset =
                u32::from_be_bytes([self.buf[5], self.buf[6], self.buf[7], self.buf[8]]) as usize;
            let total = data_offset.saturating_add(4);
            if self.buf.len() < total {
                return false;
            }
            self.header = Some(self.buf.split_to(total).freeze());
            self.is_flv = true;
        }
        self.header_parsed = true;
        true
    }

    /// 必须自行触发解析：调用方会先取文件头再取 tag，
    /// 若等到 next_tag 才解析，文件头就会排到首批 tag 之后发出。
    fn take_header(&mut self) -> Option<Bytes> {
        self.try_parse_header();
        self.header.take()
    }

    /// 缓冲越积越多却吐不出 tag，说明上游不是能按 FLV 解析的字节流。
    /// 用于兜底，避免在非预期容器上无限占用内存。
    fn is_desynced(&self) -> bool {
        self.buf.len() > MAX_PENDING_BUFFER
    }

    /// 文件头已解析且确实是 FLV。
    fn is_flv(&self) -> bool {
        self.header_parsed && self.is_flv
    }

    /// 取走尚未解析的剩余字节（退化为直通时使用）。
    fn take_pending(&mut self) -> Bytes {
        self.buf.split().freeze()
    }

    fn next_tag(&mut self) -> Option<FlvTag> {
        if !self.try_parse_header() {
            return None;
        }
        if self.buf.len() < 11 {
            return None;
        }
        let data_size = ((self.buf[1] as usize) << 16)
            | ((self.buf[2] as usize) << 8)
            | (self.buf[3] as usize);
        let total = 11 + data_size + 4;
        if self.buf.len() < total {
            return None;
        }

        let tag_type = self.buf[0] & 0x1f;
        // 时间戳是 3 字节小端序拼 1 字节高位扩展。
        let timestamp = ((self.buf[7] as u32) << 24)
            | ((self.buf[4] as u32) << 16)
            | ((self.buf[5] as u32) << 8)
            | (self.buf[6] as u32);

        let (is_keyframe, is_sequence_header) = if data_size >= 2 {
            let first = self.buf[11];
            let second = self.buf[12];
            match tag_type {
                // 视频：高 4 位为帧类型（1 = 关键帧），后一字节为 0 表示 sequence header。
                TAG_TYPE_VIDEO => (first >> 4 == 1, second == 0),
                // 音频：后一字节为 0 表示 sequence header。
                TAG_TYPE_AUDIO => (false, second == 0),
                _ => (false, false),
            }
        } else {
            (false, false)
        };

        let raw = self.buf.split_to(total).freeze();
        Some(FlvTag {
            raw,
            tag_type,
            timestamp,
            is_keyframe,
            is_sequence_header,
        })
    }
}

/// 记录已转发到的时间轴位置，用于在接续时丢弃新流回吐的重复 tag。
/// 音视频分开记录，避免交错导致误丢。
#[derive(Default)]
struct Timeline {
    last_video_ts: Option<u32>,
    last_audio_ts: Option<u32>,
    /// 播放器当前使用的解码配置（首段的 sequence header 内容）。
    video_config: Option<Bytes>,
    audio_config: Option<Bytes>,
}

impl Timeline {
    fn observe(&mut self, tag: &FlvTag) {
        if tag.is_sequence_header {
            let config = Bytes::copy_from_slice(tag.payload());
            match tag.tag_type {
                TAG_TYPE_VIDEO => self.video_config = Some(config),
                TAG_TYPE_AUDIO => self.audio_config = Some(config),
                _ => {}
            }
            return;
        }
        match tag.tag_type {
            TAG_TYPE_VIDEO => self.last_video_ts = Some(tag.timestamp),
            TAG_TYPE_AUDIO => self.last_audio_ts = Some(tag.timestamp),
            _ => {}
        }
    }

    /// 新流的 sequence header 与播放器正在使用的是否不同（编码参数变化）。
    fn config_changed(&self, tag: &FlvTag) -> bool {
        let current = match tag.tag_type {
            TAG_TYPE_VIDEO => &self.video_config,
            TAG_TYPE_AUDIO => &self.audio_config,
            _ => return false,
        };
        matches!(current, Some(c) if c.as_ref() != tag.payload())
    }

    /// 接续用的时间戳偏移：新段首个关键帧与旧位置相差过大（时间轴中断）时，
    /// 把新段平移到旧位置之后；否则不改写（斗鱼正常续流时间轴是连续的）。
    fn offset_for(&self, keyframe_ts: u32) -> i64 {
        match self.last_video_ts {
            Some(prev) if (keyframe_ts as i64 - prev as i64).abs() > DISCONTINUITY_THRESHOLD_MS => {
                prev as i64 + DISCONTINUITY_GAP_MS - keyframe_ts as i64
            }
            _ => 0,
        }
    }

    /// 新流的 tag 是否已经越过旧流转发到的位置。
    fn is_ahead(&self, tag: &FlvTag) -> bool {
        let last = match tag.tag_type {
            TAG_TYPE_VIDEO => self.last_video_ts,
            TAG_TYPE_AUDIO => self.last_audio_ts,
            _ => None,
        };
        match last {
            Some(prev) => tag.timestamp > prev,
            None => true,
        }
    }
}

/// 一条上游流的读取状态。
struct Segment {
    body: ByteStream,
    demuxer: FlvDemuxer,
    started_at: Instant,
    /// 是否为接续段。接续段需要丢弃文件头、初始化 tag 和重复的 GOP。
    continuation: bool,
    /// 接续段在遇到第一个可用关键帧之前不转发任何内容。
    waiting_for_keyframe: bool,
    /// 时间轴中断时施加到本段每个 tag 上的时间戳偏移（毫秒）。
    ts_offset: i64,
}

impl Segment {
    /// `continuation` 为 true 表示这是接续段而非首段。
    fn new(body: ByteStream, continuation: bool) -> Self {
        Self {
            body,
            demuxer: FlvDemuxer::default(),
            started_at: Instant::now(),
            continuation,
            waiting_for_keyframe: continuation,
            ts_offset: 0,
        }
    }

    fn should_prefetch(&self) -> bool {
        self.started_at.elapsed() + RENEW_LEAD >= STREAM_TTL
    }
}

/// 按平台补齐防盗链所需的请求头，与 proxy.rs 中的直通路径保持一致。
pub fn apply_stream_headers(
    builder: reqwest::RequestBuilder,
    url: &str,
    default_ua: &str,
    huya_ua: &str,
) -> reqwest::RequestBuilder {
    let builder = builder
        .header("User-Agent", default_ua)
        .header("Accept", "video/x-flv,application/octet-stream,*/*")
        .header("Range", "bytes=0-")
        .header("Connection", "keep-alive");

    if url.contains("huya.com") || url.contains("hy-cdn.com") || url.contains("huyaimg.com") {
        builder
            .header("User-Agent", huya_ua)
            .header("Referer", "https://www.huya.com/")
            .header("Origin", "https://www.huya.com")
    } else if url.contains("bilivideo") || url.contains("bilibili.com") || url.contains("hdslb.com")
    {
        builder.header("Referer", "https://live.bilibili.com/")
    } else {
        builder
    }
}

/// 打开一条上游流。首次连接由 handler 同步调用，以便把上游的错误状态原样透传给前端。
pub async fn open_stream(
    client: &Client,
    url: &str,
    default_ua: &str,
    huya_ua: &str,
) -> Result<ByteStream, OpenError> {
    let request = apply_stream_headers(client.get(url), url, default_ua, huya_ua);
    let response = request.send().await.map_err(OpenError::Connect)?;
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("读取上游错误响应失败: {}", e));
        return Err(OpenError::Status { status, body });
    }
    Ok(Box::pin(response.bytes_stream()))
}

#[derive(Debug)]
pub enum OpenError {
    Connect(reqwest::Error),
    Status {
        status: reqwest::StatusCode,
        body: String,
    },
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Connect(e) => write!(f, "连接上游失败: {}", e),
            OpenError::Status { status, body } => {
                write!(f, "上游返回 {}: {}", status, body)
            }
        }
    }
}

async fn resolve_douyu_url(ctx: &StreamRenewContext) -> Result<String, String> {
    crate::platforms::douyu::get_stream_url_with_quality(
        &ctx.room_id,
        &ctx.quality,
        ctx.line.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// 取一条新流并建立连接。预取与兜底重连共用。
async fn acquire_segment(
    ctx: &StreamRenewContext,
    client: &Client,
    default_ua: &str,
    huya_ua: &str,
) -> Result<ByteStream, String> {
    let url = resolve_douyu_url(ctx).await?;
    open_stream(client, &url, default_ua, huya_ua)
        .await
        .map_err(|e| e.to_string())
}

/// 预取任务的句柄；relay 退出（包括播放器断开）时自动取消，避免任务泄漏。
struct Prefetch(Option<tokio::task::JoinHandle<Result<ByteStream, String>>>);

impl Drop for Prefetch {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

type Tx = mpsc::Sender<Result<Bytes, IoError>>;

/// 取下一段流的方式。正式运行时是斗鱼取流，测试里换成假数据。
type Acquire = std::sync::Arc<
    dyn Fn() -> Pin<Box<dyn std::future::Future<Output = Result<ByteStream, String>> + Send>>
        + Send
        + Sync,
>;

/// 取一条新流，带总期限；播放器断开时立即放弃。返回 None 表示下游已离开。
async fn acquire_or_cancel(tx: &Tx, acquire: &Acquire) -> Option<Result<ByteStream, String>> {
    tokio::select! {
        _ = tx.closed() => None,
        r = tokio::time::timeout(ACQUIRE_TIMEOUT, acquire()) => {
            Some(r.unwrap_or_else(|_| Err("取流超时".to_string())))
        }
    }
}

/// 结束这条流：通知播放器出错（播放器会按出错处理并重新加载），然后退出。
async fn fail(tx: &Tx, kind: ErrorKind, msg: impl Into<String>) {
    let _ = tx.send(Err(IoError::new(kind, msg.into()))).await;
}

/// 持续向 `tx` 输出一条逻辑上不中断的 FLV 流。
///
/// `ctx` 为 None 时退化为单段直通：上游结束即结束。
/// 需要续流时（斗鱼），从首段起就只按完整 tag 输出，保证上游在 tag 中间断开时
/// 播放器手里不会留下半个 tag，接续段得以在干净的边界上接上。
pub async fn run(
    tx: Tx,
    key: String,
    first_body: ByteStream,
    ctx: Option<StreamRenewContext>,
    client: Client,
    default_ua: String,
    huya_ua: String,
) {
    let label = key;
    let acquire = ctx.map(|ctx| {
        std::sync::Arc::new(move || {
            let (ctx, client, default_ua, huya_ua) =
                (ctx.clone(), client.clone(), default_ua.clone(), huya_ua.clone());
            Box::pin(async move { acquire_segment(&ctx, &client, &default_ua, &huya_ua).await })
                as Pin<Box<dyn std::future::Future<Output = _> + Send>>
        }) as Acquire
    });
    relay(tx, first_body, acquire, label).await
}

async fn relay(tx: Tx, first_body: ByteStream, acquire: Option<Acquire>, label: String) {
    let _connection = crate::playback_stats::ConnectionGuard::open(&label);
    let mut segment = Segment::new(first_body, false);
    let mut timeline = Timeline::default();
    // 不需要续流的平台（虎牙、B 站）走纯直通，连解析都省掉。
    let mut track_timeline = acquire.is_some();
    let mut prefetch = Prefetch(None);
    let mut failures: u32 = 0;

    loop {
        // 旧流临近到期时，提前取好下一条。
        if let Some(ref acquire) = acquire {
            if prefetch.0.is_none() && segment.should_prefetch() {
                let next = acquire();
                prefetch.0 = Some(tokio::spawn(async move {
                    tokio::time::timeout(ACQUIRE_TIMEOUT, next)
                        .await
                        .unwrap_or_else(|_| Err("预取超时".to_string()))
                }));
            }
        }

        // 同时等待：上游数据、上游空闲超时、播放器断开。
        // Err(None) 表示空闲超时，Err(Some(e)) 为上游读取错误。
        let item: Option<Result<Bytes, Option<reqwest::Error>>> = tokio::select! {
            _ = tx.closed() => return,
            r = tokio::time::timeout(IDLE_TIMEOUT, segment.body.next()) => match r {
                Ok(item) => item.map(|res| res.map_err(Some)),
                Err(_) => Some(Err(None)),
            },
        };

        match item {
            Some(Ok(chunk)) => {
                crate::playback_stats::add_upstream_bytes(&label, chunk.len());
                let out = if !track_timeline {
                    // 纯直通：原样转发（Bytes 克隆是 O(1)，不复制数据）。
                    chunk
                } else if !segment.continuation {
                    // 首段：按完整 tag 聚合后输出，残缺的 tag 留在缓冲里等下一块。
                    segment.demuxer.push(&chunk);
                    let mut out = BytesMut::new();
                    if let Some(header) = segment.demuxer.take_header() {
                        out.extend_from_slice(&header);
                    }
                    if segment.demuxer.try_parse_header() && !segment.demuxer.is_flv() {
                        // 不是 FLV（文件头不对），无法续流，退化为直通。
                        eprintln!("[flv_relay] 上游不是 FLV，退化为直通");
                        track_timeline = false;
                        out.extend_from_slice(&segment.demuxer.take_pending());
                    } else {
                        while let Some(tag) = segment.demuxer.next_tag() {
                            timeline.observe(&tag);
                            out.extend_from_slice(&tag.raw);
                        }
                        if segment.demuxer.is_desynced() {
                            eprintln!("[flv_relay] FLV 解析失步，退化为直通");
                            track_timeline = false;
                            out.extend_from_slice(&segment.demuxer.take_pending());
                        }
                    }
                    out.freeze()
                } else {
                    segment.demuxer.push(&chunk);
                    // 接续段的文件头必须丢弃，播放器只认首段那一个。
                    segment.demuxer.take_header();

                    let mut out = BytesMut::new();
                    while let Some(tag) = segment.demuxer.next_tag() {
                        if tag.tag_type == TAG_TYPE_SCRIPT {
                            continue;
                        }
                        if tag.is_sequence_header {
                            // 编码参数没变就丢掉（播放器已初始化过）；变了则无法无缝接续，
                            // 结束这条流让播放器重建媒体会话。
                            if timeline.config_changed(&tag) {
                                eprintln!("[flv_relay] 新流编码参数已变化，通知播放器重新加载");
                                fail(&tx, ErrorKind::InvalidData, "stream codec changed").await;
                                return;
                            }
                            continue;
                        }
                        if segment.waiting_for_keyframe {
                            if !(tag.tag_type == TAG_TYPE_VIDEO && tag.is_keyframe) {
                                continue;
                            }
                            let offset = timeline.offset_for(tag.timestamp);
                            if offset == 0 && !timeline.is_ahead(&tag) {
                                // CDN 回吐的旧 GOP。
                                continue;
                            }
                            if offset != 0 {
                                eprintln!(
                                    "[flv_relay] 时间轴中断（{} -> {}），平移 {}ms 后接续",
                                    timeline.last_video_ts.unwrap_or(0),
                                    tag.timestamp,
                                    offset
                                );
                            }
                            segment.ts_offset = offset;
                            segment.waiting_for_keyframe = false;
                        }

                        let tag = if segment.ts_offset != 0 {
                            let ts = (tag.timestamp as i64 + segment.ts_offset).max(0) as u32;
                            tag.retimed(ts)
                        } else {
                            tag
                        };
                        if !timeline.is_ahead(&tag) {
                            // 重复部分直接丢弃。
                            continue;
                        }
                        timeline.observe(&tag);
                        out.extend_from_slice(&tag.raw);
                    }
                    out.freeze()
                };

                if !out.is_empty() && tx.send(Ok(out)).await.is_err() {
                    return;
                }
            }
            other => {
                match &other {
                    Some(Err(Some(e))) => eprintln!("[flv_relay] 上游读取错误: {}", e),
                    Some(Err(None)) => eprintln!("[flv_relay] 上游 {}s 无数据，视为断流", IDLE_TIMEOUT.as_secs()),
                    _ => {}
                }

                let Some(ref acquire) = acquire else {
                    // 非斗鱼：上游结束即结束；异常结束要告诉播放器，而不是当作正常 EOF。
                    if matches!(other, Some(Err(_))) {
                        fail(&tx, ErrorKind::TimedOut, "upstream stalled or failed").await;
                    }
                    return;
                };
                if !track_timeline {
                    // 无法按 tag 接续（非 FLV / 失步），只能让播放器重新加载。
                    fail(&tx, ErrorKind::BrokenPipe, "upstream ended").await;
                    return;
                }

                let elapsed = segment.started_at.elapsed().as_secs_f32();
                // 预取已就绪就直接用，否则说明是提前故障，同步补取一条。
                let next = match prefetch.0.take() {
                    Some(handle) => tokio::select! {
                        _ = tx.closed() => return,
                        r = handle => match r {
                            Ok(r) => r,
                            Err(e) => Err(format!("预取任务异常: {}", e)),
                        },
                    },
                    None => match acquire_or_cancel(&tx, acquire).await {
                        Some(r) => r,
                        None => return,
                    },
                };

                match next {
                    Ok(body) => {
                        println!(
                            "[flv_relay] 上一段存活 {:.1}s，已接续新流（房间 {}）",
                            elapsed, label
                        );
                        failures = 0;
                        crate::playback_stats::renewed(&label);
                        segment = Segment::new(body, true);
                    }
                    Err(e) => {
                        failures += 1;
                        crate::playback_stats::failed(&label);
                        eprintln!(
                            "[flv_relay] 续流失败 {}/{}: {}",
                            failures, MAX_CONSECUTIVE_FAILURES, e
                        );
                        if failures >= MAX_CONSECUTIVE_FAILURES {
                            fail(&tx, ErrorKind::BrokenPipe, e).await;
                            return;
                        }
                        tokio::select! {
                            _ = tx.closed() => return,
                            _ = tokio::time::sleep(RETRY_DELAY) => {}
                        }
                        match acquire_or_cancel(&tx, acquire).await {
                            None => return,
                            Some(Ok(body)) => {
                                failures = 0;
                                segment = Segment::new(body, true);
                            }
                            // 下一轮循环里当前段仍处于结束状态，会再次进入重试分支。
                            Some(Err(_)) => continue,
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼出一个最小 FLV tag：11 字节头 + data + 4 字节 PreviousTagSize。
    fn make_tag(tag_type: u8, timestamp: u32, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(tag_type);
        let size = data.len() as u32;
        out.extend_from_slice(&size.to_be_bytes()[1..]);
        out.extend_from_slice(&timestamp.to_be_bytes()[1..]);
        out.push((timestamp >> 24) as u8);
        out.extend_from_slice(&[0, 0, 0]);
        out.extend_from_slice(data);
        out.extend_from_slice(&(11 + size).to_be_bytes());
        out
    }

    fn flv_header() -> Vec<u8> {
        let mut out = b"FLV\x01\x05".to_vec();
        out.extend_from_slice(&9u32.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out
    }

    #[test]
    fn parses_header_and_tags() {
        let mut d = FlvDemuxer::default();
        let mut bytes = flv_header();
        bytes.extend_from_slice(&make_tag(TAG_TYPE_VIDEO, 30678210, &[0x17, 0x01, 0xaa]));
        bytes.extend_from_slice(&make_tag(TAG_TYPE_AUDIO, 30678211, &[0xaf, 0x01, 0xbb]));
        d.push(&bytes);

        assert!(d.take_header().is_some());

        let v = d.next_tag().expect("video tag");
        assert_eq!(v.tag_type, TAG_TYPE_VIDEO);
        assert_eq!(v.timestamp, 30678210);
        assert!(v.is_keyframe);
        assert!(!v.is_sequence_header);

        let a = d.next_tag().expect("audio tag");
        assert_eq!(a.tag_type, TAG_TYPE_AUDIO);
        assert_eq!(a.timestamp, 30678211);
        assert!(!a.is_sequence_header);

        assert!(d.next_tag().is_none());
    }

    #[test]
    fn handles_split_chunks() {
        let mut full = flv_header();
        full.extend_from_slice(&make_tag(TAG_TYPE_VIDEO, 1000, &[0x17, 0x01, 0x00, 0x01]));

        let mut d = FlvDemuxer::default();
        // 逐字节喂入，确认不会因为分片而解析错位。
        for b in &full {
            d.push(&[*b]);
        }
        assert!(d.take_header().is_some());
        let tag = d.next_tag().expect("tag");
        assert_eq!(tag.timestamp, 1000);
    }

    #[test]
    fn detects_sequence_headers() {
        let mut d = FlvDemuxer::default();
        let mut bytes = flv_header();
        bytes.extend_from_slice(&make_tag(TAG_TYPE_VIDEO, 0, &[0x17, 0x00, 0x00]));
        bytes.extend_from_slice(&make_tag(TAG_TYPE_AUDIO, 0, &[0xaf, 0x00]));
        d.push(&bytes);
        d.take_header();

        let v = d.next_tag().expect("video seq header");
        assert!(v.is_sequence_header);
        let a = d.next_tag().expect("audio seq header");
        assert!(a.is_sequence_header);
    }

    #[test]
    fn timeline_drops_replayed_tags() {
        let mut t = Timeline::default();
        let mut d = FlvDemuxer::default();
        let mut bytes = flv_header();
        bytes.extend_from_slice(&make_tag(TAG_TYPE_VIDEO, 500, &[0x17, 0x01, 0x00]));
        bytes.extend_from_slice(&make_tag(TAG_TYPE_VIDEO, 400, &[0x17, 0x01, 0x00]));
        bytes.extend_from_slice(&make_tag(TAG_TYPE_VIDEO, 600, &[0x17, 0x01, 0x00]));
        d.push(&bytes);
        d.take_header();

        let first = d.next_tag().unwrap();
        assert!(t.is_ahead(&first));
        t.observe(&first);

        // 新流回吐的旧 GOP 应被丢弃。
        let replayed = d.next_tag().unwrap();
        assert!(!t.is_ahead(&replayed));

        // 音频时间轴独立，不受视频影响。
        let ahead = d.next_tag().unwrap();
        assert!(t.is_ahead(&ahead));
    }

    // ---- relay end-to-end tests with fake upstream segments ----

    fn video(ts: u32, keyframe: bool) -> Vec<u8> {
        make_tag(TAG_TYPE_VIDEO, ts, &[if keyframe { 0x17 } else { 0x27 }, 0x01, 0xaa, 0xbb])
    }
    fn audio(ts: u32) -> Vec<u8> {
        make_tag(TAG_TYPE_AUDIO, ts, &[0xaf, 0x01, 0xcc])
    }
    fn seq_headers(avc: &[u8]) -> Vec<u8> {
        let mut v = make_tag(TAG_TYPE_SCRIPT, 0, b"meta");
        let mut data = vec![0x17, 0x00, 0x00, 0x00, 0x00];
        data.extend_from_slice(avc);
        v.extend(make_tag(TAG_TYPE_VIDEO, 0, &data));
        v.extend(make_tag(TAG_TYPE_AUDIO, 0, &[0xaf, 0x00, 0x12, 0x10]));
        v
    }
    fn stream_of(chunks: Vec<Vec<u8>>) -> ByteStream {
        Box::pin(futures_util::stream::iter(
            chunks.into_iter().map(|c| Ok(Bytes::from(c))),
        ))
    }

    /// Runs the relay with one renewal and returns (output bytes, ended with error).
    fn run_relay(first: Vec<Vec<u8>>, second: Vec<Vec<u8>>) -> (Vec<u8>, bool) {
        tauri::async_runtime::block_on(async move {
            let (tx, mut rx) = mpsc::channel(64);
            let second = std::sync::Mutex::new(Some(second));
            let acquire: Acquire = std::sync::Arc::new(move || {
                // After the one renewal, the next "upstream" never answers; the
                // test ends by dropping the receiver.
                let next = second.lock().unwrap().take();
                Box::pin(async move {
                    match next {
                        Some(chunks) => Ok(stream_of(chunks)),
                        None => futures_util::future::pending().await,
                    }
                })
            });
            let task = tokio::spawn(relay(tx, stream_of(first), Some(acquire), "test".into()));
            let mut out = Vec::new();
            let mut errored = false;
            while let Ok(Some(item)) =
                tokio::time::timeout(Duration::from_millis(300), rx.recv()).await
            {
                match item {
                    Ok(b) => out.extend_from_slice(&b),
                    Err(_) => {
                        errored = true;
                        break;
                    }
                }
            }
            drop(rx);
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .expect("relay must exit once the player disconnects")
                .unwrap();
            (out, errored)
        })
    }

    /// Parses relay output; every byte must belong to a whole tag.
    fn parse_all(bytes: &[u8]) -> Vec<FlvTag> {
        let mut d = FlvDemuxer::default();
        d.push(bytes);
        assert!(d.take_header().is_some(), "output must start with the FLV header");
        let mut tags = Vec::new();
        while let Some(t) = d.next_tag() {
            tags.push(t);
        }
        assert!(d.take_pending().is_empty(), "output ends in a partial tag");
        tags
    }

    fn video_timestamps(tags: &[FlvTag]) -> Vec<u32> {
        tags.iter()
            .filter(|t| t.tag_type == TAG_TYPE_VIDEO && !t.is_sequence_header)
            .map(|t| t.timestamp)
            .collect()
    }

    #[test]
    fn upstream_cut_mid_tag_still_yields_whole_tags() {
        let mut first = flv_header();
        first.extend(seq_headers(b"cfg"));
        first.extend(video(1000, true));
        first.extend(audio(1010));
        let cut = video(1040, false);
        first.extend_from_slice(&cut[..cut.len() / 2]); // EOF in the middle of a tag

        let mut second = flv_header();
        second.extend(seq_headers(b"cfg"));
        second.extend(video(1000, true)); // replayed GOP
        second.extend(video(1080, true));
        second.extend(audio(1090));

        // Deliver in odd-sized chunks too.
        let first_chunks = first.chunks(7).map(|c| c.to_vec()).collect();
        let (out, errored) = run_relay(first_chunks, vec![second]);
        assert!(!errored);
        let tags = parse_all(&out);
        assert_eq!(video_timestamps(&tags), vec![1000, 1080]);
    }

    #[test]
    fn timestamp_reset_is_shifted_onto_the_old_timeline() {
        let mut first = flv_header();
        first.extend(seq_headers(b"cfg"));
        first.extend(video(500_000, true));
        first.extend(video(500_040, false));

        let mut second = flv_header();
        second.extend(seq_headers(b"cfg"));
        second.extend(video(0, true)); // streamer re-pushed: timeline restarted
        second.extend(audio(10));
        second.extend(video(40, false));

        let (out, errored) = run_relay(vec![first], vec![second]);
        assert!(!errored);
        let tags = parse_all(&out);
        let ts = video_timestamps(&tags);
        assert_eq!(ts, vec![500_000, 500_040, 500_080, 500_120]);
        assert!(ts.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn codec_change_ends_the_stream_with_an_error() {
        let mut first = flv_header();
        first.extend(seq_headers(b"cfg-720p"));
        first.extend(video(1000, true));

        let mut second = flv_header();
        second.extend(seq_headers(b"cfg-1080p"));
        second.extend(video(1040, true));

        let (out, errored) = run_relay(vec![first], vec![second]);
        assert!(errored, "player must be told to rebuild");
        assert_eq!(video_timestamps(&parse_all(&out)), vec![1000]);
    }

    #[test]
    fn relay_exits_when_player_disconnects_while_upstream_is_silent() {
        tauri::async_runtime::block_on(async {
            let (tx, rx) = mpsc::channel(4);
            let silent: ByteStream = Box::pin(futures_util::stream::pending());
            let task = tokio::spawn(relay(tx, silent, None, "test".into()));
            drop(rx);
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .expect("relay kept running after the player left")
                .unwrap();
        });
    }
}
