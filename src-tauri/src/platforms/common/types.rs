use serde::{Deserialize, Serialize};

// Wrapper for payload like { args: { room_id_str: "..." } }
// Used by get_douyin_live_stream_url and start_douyin_danmaku_listener
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct PayloadWrapperForRoomId {
    pub args: RoomIdDetail,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct RoomIdDetail {
    #[serde(alias = "roomIdStr")]
    pub room_id_str: String,
}

// New payload wrapper specifically for get_douyin_live_stream_url
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct GetStreamUrlArgs {
    pub room_id_str: String,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct GetStreamUrlPayload {
    pub args: GetStreamUrlArgs,
}

// 描述一个可用的播放流变体（用于调试/导出所有地址）
#[derive(Serialize, Clone, Debug)]
pub struct StreamVariant {
    pub url: String,
    pub format: Option<String>,   // e.g. flv, ts, mp4
    pub desc: Option<String>,     // e.g. 原画/高清
    pub qn: Option<i32>,          // B 站的清晰度编号
    pub protocol: Option<String>, // e.g. http, https, ws/hls
}

// For the return type of get_douyin_live_stream_url
// Matches LiveStreamInfo interface in DouyinLive.vue
#[derive(Serialize, Clone, Debug)]
pub struct LiveStreamInfo {
    pub title: Option<String>,
    pub anchor_name: Option<String>,
    pub avatar: Option<String>,
    pub stream_url: Option<String>,
    pub status: Option<i32>,
    pub error_message: Option<String>,
    // 新增：上游真实地址（未经过本地代理）
    pub upstream_url: Option<String>,
    // 新增：所有可用的播放地址列表（调试/导出用）
    pub available_streams: Option<Vec<StreamVariant>>,
    // 新增：规范化后的房间ID（例如从 web_id 提取出的 room.id_str）
    pub normalized_room_id: Option<String>,
    // 新增：直播间的 web_rid（用于关注列表以 web_id 为主键）
    pub web_rid: Option<String>,
}

/// Stop handles for running danmaku listeners, keyed by room.
/// Upstream kept a single `Option<Sender>` per platform, so only one room per
/// platform could receive danmaku and any start silently killed the previous one.
pub struct DanmakuSessions<T>(std::sync::Mutex<std::collections::HashMap<String, T>>);

impl<T> Default for DanmakuSessions<T> {
    fn default() -> Self {
        Self(Default::default())
    }
}

impl<T> DanmakuSessions<T> {
    /// Registers `handle` for `room`, returning the handle it replaces (to be stopped).
    pub fn insert(&self, room: &str, handle: T) -> Option<T> {
        self.0.lock().unwrap().insert(room.to_string(), handle)
    }

    /// Removes the handle for `room`, or every handle when `room` is `None`.
    pub fn take(&self, room: Option<&str>) -> Vec<T> {
        let mut map = self.0.lock().unwrap();
        match room {
            Some(room) => map.remove(room).into_iter().collect(),
            None => map.drain().map(|(_, h)| h).collect(),
        }
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

type StopTx = tokio::sync::mpsc::Sender<()>;
pub type DouyinDanmakuState = DanmakuSessions<StopTx>;
pub type BilibiliDanmakuState = DanmakuSessions<StopTx>;
pub type HuyaDanmakuState = DanmakuSessions<StopTx>;
pub type DouyuDanmakuState = DanmakuSessions<tokio::sync::oneshot::Sender<()>>;

#[cfg(test)]
mod danmaku_sessions_tests {
    use super::DanmakuSessions;

    #[test]
    fn rooms_are_tracked_independently() {
        let s = DanmakuSessions::<u32>::default();
        assert!(s.insert("a", 1).is_none());
        assert!(s.insert("b", 2).is_none());
        assert_eq!(s.insert("a", 3), Some(1), "restarting a room returns the old handle");
        assert_eq!(s.take(Some("b")), vec![2]);
        assert_eq!(s.len(), 1);
        assert!(s.take(Some("missing")).is_empty());
        assert_eq!(s.take(None), vec![3]);
        assert_eq!(s.len(), 0);
    }
}

#[derive(Serialize, Clone, Debug, specta::Type)]
pub struct DanmakuFrontendPayload {
    pub room_id: String,
    pub user: String,
    pub content: String,
    pub user_level: i64,
    pub fans_club_level: i32,
    pub color: Option<String>,
}
