use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::mpsc as tokio_mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::platforms::bilibili::auth::{init_server_no_cookie, init_server_with_cookie};
use crate::platforms::bilibili::models::BiliMessage;
use crate::platforms::bilibili::websocket::{gen_damu_list, make_packet, parse_frame, Operation};
use crate::platforms::common::DanmakuFrontendPayload;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// The server sends at least a popularity packet per heartbeat; silence this long means a dead link.
const IDLE_TIMEOUT: Duration = Duration::from_secs(70);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BACKOFF_SECS: u64 = 30;

enum Outcome {
    Stop,
    /// `bool`: the session got far enough to receive data (resets the backoff).
    Retry(String, bool),
}

/// One connection: fetch the auth token, connect, then read until stopped or broken.
/// Upstream ran a blocking socket on an OS thread that slept 50ms per message
/// (capping it at ~20 msg/s) and couldn't be interrupted while blocked in read.
async fn run_session(
    room_id: &str,
    cookie: Option<&str>,
    emit: &(dyn Fn(DanmakuFrontendPayload) + Send + Sync),
    shutdown: &mut tokio_mpsc::Receiver<()>,
) -> Outcome {
    let (room, cookie) = (room_id.to_string(), cookie.map(str::to_string));
    // The auth helpers use blocking HTTP and unwrap(); a panic surfaces as a JoinError here.
    let init = tokio::task::spawn_blocking(move || match cookie {
        Some(c) => init_server_with_cookie(&c, &room),
        None => init_server_no_cookie(&room),
    });
    let (server_info, auth) = tokio::select! {
        _ = shutdown.recv() => return Outcome::Stop,
        r = init => match r {
            Ok(v) => v,
            Err(e) => return Outcome::Retry(format!("auth info failed: {e}"), false),
        },
    };
    let auth_json = match serde_json::to_string(&auth) {
        Ok(j) => j,
        Err(e) => return Outcome::Retry(format!("auth encode failed: {e}"), false),
    };

    let server = gen_damu_list(&server_info["host_list"]).into_iter().next().unwrap_or_default();
    let url = format!("wss://{}:{}/sub", server.host, server.wss_port);
    let ws = tokio::select! {
        _ = shutdown.recv() => return Outcome::Stop,
        r = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url.as_str())) => match r {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => return Outcome::Retry(format!("connect {url} failed: {e}"), false),
            Err(_) => return Outcome::Retry(format!("connect {url} timed out"), false),
        },
    };
    let (mut sink, mut stream) = ws.split();
    if let Err(e) = sink.send(Message::Binary(make_packet(&auth_json, Operation::AUTH))).await {
        return Outcome::Retry(format!("send auth failed: {e}"), false);
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await; // first tick is immediate; the auth reply triggers the first heartbeat
    let mut received = false;

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                let _ = sink.close().await;
                return Outcome::Stop;
            }
            _ = heartbeat.tick() => {
                if let Err(e) = sink.send(Message::Binary(make_packet("{}", Operation::HEARTBEAT))).await {
                    return Outcome::Retry(format!("heartbeat failed: {e}"), received);
                }
            }
            next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => {
                let data = match next {
                    Err(_) => return Outcome::Retry("no data, reconnecting".into(), received),
                    Ok(None) => return Outcome::Retry("server closed the connection".into(), received),
                    Ok(Some(Err(e))) => return Outcome::Retry(format!("read failed: {e}"), received),
                    Ok(Some(Ok(Message::Binary(data)))) => data,
                    Ok(Some(Ok(Message::Ping(p)))) => {
                        let _ = sink.send(Message::Pong(p)).await;
                        continue;
                    }
                    Ok(Some(Ok(_))) => continue,
                };
                received = true;
                let frame = parse_frame(&data);
                if frame.auth_reply {
                    let _ = sink.send(Message::Binary(make_packet("{}", Operation::HEARTBEAT))).await;
                }
                for msg in frame.messages {
                    let (user, content) = match msg {
                        BiliMessage::Danmu { user, text } => (user, text),
                        BiliMessage::Gift { user, gift } => (user, format!("[礼物] {}", gift)),
                        BiliMessage::Unsupported { .. } => continue,
                    };
                    emit(DanmakuFrontendPayload {
                        room_id: room_id.to_string(),
                        user,
                        content,
                        user_level: 0,
                        fans_club_level: 0,
                        color: None,
                    });
                }
            }
        }
    }
}

#[tauri::command]
pub async fn start_bilibili_danmaku_listener(
    payload: crate::platforms::common::GetStreamUrlPayload,
    cookie: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::platforms::common::BilibiliDanmakuState>,
) -> Result<(), String> {
    let room_id = payload.args.room_id_str.clone();

    // Restarting a room replaces its listener; other rooms keep running.
    let (tx_shutdown, mut rx_shutdown) = tokio_mpsc::channel::<()>(1);
    if let Some(tx) = state.insert(&room_id, tx_shutdown) {
        let _ = tx.send(()).await;
    }

    tokio::spawn(async move {
        let emit = move |p: DanmakuFrontendPayload| {
            let _ = app_handle.emit("danmaku-message", p);
        };
        let mut backoff = 1u64;
        loop {
            match run_session(&room_id, cookie.as_deref(), &emit, &mut rx_shutdown).await {
                Outcome::Stop => break,
                Outcome::Retry(reason, had_data) => {
                    if had_data {
                        backoff = 1;
                    }
                    eprintln!("[Bilibili Danmaku] room {}: {}; retrying in {}s", room_id, reason, backoff);
                }
            }
            tokio::select! {
                _ = rx_shutdown.recv() => break,
                _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
            }
            backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
        }
    });

    Ok(())
}

/// Stops one room's listener, or all Bilibili listeners when `room_id` is omitted.
#[tauri::command]
pub async fn stop_bilibili_danmaku_listener(
    room_id: Option<String>,
    state: tauri::State<'_, crate::platforms::common::BilibiliDanmakuState>,
) -> Result<(), String> {
    for tx in state.take(room_id.as_deref().filter(|r| !r.is_empty())) {
        // An exited listener has dropped its receiver; that's already "stopped".
        let _ = tx.send(()).await;
    }
    Ok(())
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Talks to Bilibili for real: `cargo test bilibili_live -- --ignored`.
    /// Set BILI_ROOM to a busy live room to also see danmaku throughput.
    #[test]
    #[ignore]
    fn bilibili_live_session_connects_and_stops_promptly() {
        let room = std::env::var("BILI_ROOM").unwrap_or_else(|_| "6".into());
        tauri::async_runtime::block_on(async move {
            let count = Arc::new(AtomicUsize::new(0));
            let c = count.clone();
            let emit = move |_p: DanmakuFrontendPayload| {
                c.fetch_add(1, Ordering::Relaxed);
            };
            let (tx, mut rx) = tokio_mpsc::channel(1);
            let stopper = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(20)).await;
                let _ = tx.send(()).await;
                std::time::Instant::now()
            });
            let outcome = run_session(&room, None, &emit, &mut rx).await;
            let ended = std::time::Instant::now();
            let stop_sent = stopper.await.unwrap();
            match outcome {
                Outcome::Stop => {}
                Outcome::Retry(reason, _) => panic!("session failed before stop: {reason}"),
            }
            assert!(ended.duration_since(stop_sent) < Duration::from_secs(1), "stop took too long");
            println!("room {room}: {} danmaku in 20s", count.load(Ordering::Relaxed));
        });
    }
}
