use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::mpsc as tokio_mpsc;

use crate::platforms::bilibili::models::BiliMessage;
use crate::platforms::bilibili::websocket::BiliLiveClient;

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
        if tx.send(()).await.is_err() {
            eprintln!("[Bilibili Danmaku] 旧任务关闭失败，可能已退出。");
        }
    }

    let app_handle_clone = app_handle.clone();
    let room_id_clone = room_id.clone();
    let cookie_clone = cookie.clone();

    // Use atomic flag to signal std::thread to stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = stop_flag.clone();

    // Spawn std thread to run sync BiliLiveClient loop
    std::thread::spawn(move || {
        let mut client = match cookie_clone.as_ref() {
            Some(c) => BiliLiveClient::new_with_cookie(c.as_str(), room_id_clone.as_str()),
            None => BiliLiveClient::new_without_cookie(room_id_clone.as_str()),
        };
        client.send_auth();

        loop {
            if stop_flag_for_thread.load(Ordering::Relaxed) {
                break;
            }
            if let Some(msg) = client.read_once() {
                match msg {
                    BiliMessage::Danmu { user, text } => {
                        let _ = app_handle_clone.emit(
                            "danmaku-message",
                            crate::platforms::common::DanmakuFrontendPayload {
                                room_id: room_id_clone.clone(),
                                user,
                                content: text,
                                user_level: 0,
                                fans_club_level: 0,
                                color: None,
                            },
                        );
                    }
                    BiliMessage::Gift { user, gift } => {
                        let _ = app_handle_clone.emit(
                            "danmaku-message",
                            crate::platforms::common::DanmakuFrontendPayload {
                                room_id: room_id_clone.clone(),
                                user,
                                content: format!("[礼物] {}", gift),
                                user_level: 0,
                                fans_club_level: 0,
                                color: None,
                            },
                        );
                    }
                    BiliMessage::Unsupported { .. } => {
                        // ignore
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });

    // Spawn a tokio task to listen for shutdown and set stop flag
    let stop_flag_for_task = stop_flag.clone();
    tokio::spawn(async move {
        let _ = rx_shutdown.recv().await; // wait for shutdown signal
        stop_flag_for_task.store(true, Ordering::Relaxed);
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
