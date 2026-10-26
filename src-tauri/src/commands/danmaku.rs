//! One danmaku API for every platform.
//!
//! Each subscription is keyed by (platform, room_id) and streams messages over
//! its own Tauri `Channel`, so several rooms can run at once and the frontend
//! never has to filter a shared global event.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use livedeck_core::danmaku::DanmakuHandler;
use livedeck_core::platforms::common::types::SupportedPlatform;
use livedeck_core::platforms::common::DanmakuFrontendPayload;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};

enum StopHandle {
    Oneshot(oneshot::Sender<()>),
    Mpsc(mpsc::Sender<()>),
}

impl StopHandle {
    fn stop(self) {
        match self {
            StopHandle::Oneshot(tx) => {
                let _ = tx.send(());
            }
            StopHandle::Mpsc(tx) => {
                let _ = tx.try_send(());
            }
        }
    }
}

#[derive(Default)]
pub struct DanmakuSessions(Mutex<HashMap<(SupportedPlatform, String), StopHandle>>);

struct ChannelHandler(Channel<DanmakuFrontendPayload>);

impl DanmakuHandler for ChannelHandler {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        // Platform modules also emit legacy platform-specific events; only the
        // normalized chat payload is forwarded.
        if event != "danmaku-message" {
            return;
        }
        if let Ok(msg) = serde_json::from_value::<DanmakuFrontendPayload>(payload) {
            let _ = self.0.send(msg);
        }
    }
}

#[tauri::command]
pub async fn start_danmaku(
    platform: SupportedPlatform,
    room_id: String,
    cookie: Option<String>,
    on_message: Channel<DanmakuFrontendPayload>,
    sessions: tauri::State<'_, DanmakuSessions>,
) -> Result<(), String> {
    let key = (platform.clone(), room_id.clone());
    if let Some(old) = sessions.0.lock().unwrap().remove(&key) {
        old.stop();
    }

    let handler: Arc<dyn DanmakuHandler> = Arc::new(ChannelHandler(on_message));
    let stop = match platform {
        SupportedPlatform::Douyu => {
            let (tx, rx) = oneshot::channel();
            tauri::async_runtime::spawn(async move {
                let mut client =
                    livedeck_core::platforms::douyu::danmaku::DanmakuClient::new(&room_id, handler, rx);
                if let Err(e) = client.start().await {
                    tracing::warn!("[danmaku] douyu {} stopped: {}", room_id, e);
                }
            });
            StopHandle::Oneshot(tx)
        }
        SupportedPlatform::Douyin => {
            let (tx, rx) = mpsc::channel(1);
            tauri::async_runtime::spawn(
                livedeck_core::platforms::douyin::douyin_danmu_listener::run_douyin_danmu_listener(
                    room_id, rx, handler,
                ),
            );
            StopHandle::Mpsc(tx)
        }
        SupportedPlatform::Huya => {
            let (tx, rx) = mpsc::channel(1);
            tauri::async_runtime::spawn(
                livedeck_core::platforms::huya::danmaku::run_huya_danmaku_listener(room_id, rx, handler),
            );
            StopHandle::Mpsc(tx)
        }
        SupportedPlatform::Bilibili => {
            let (tx, rx) = mpsc::channel(1);
            tauri::async_runtime::spawn(
                livedeck_core::platforms::bilibili::danmaku::run_bilibili_danmaku_listener(
                    room_id, cookie, rx, handler,
                ),
            );
            StopHandle::Mpsc(tx)
        }
    };

    sessions.0.lock().unwrap().insert(key, stop);
    Ok(())
}

#[tauri::command]
pub fn stop_danmaku(
    platform: SupportedPlatform,
    room_id: String,
    sessions: tauri::State<'_, DanmakuSessions>,
) {
    if let Some(handle) = sessions.0.lock().unwrap().remove(&(platform, room_id)) {
        handle.stop();
    }
}
