// Keep the console window in debug builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

mod commands;
mod platforms;
mod proxy;

use platforms::common::FollowHttpClient;

#[tauri::command]
async fn search_anchor(keyword: String) -> Result<String, String> {
    platforms::douyu::perform_anchor_search(&keyword)
        .await
        .map_err(|e| e.to_string())
}

fn main() {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .http1_only()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .no_proxy()
        .build()
        .expect("failed to create reqwest client");
    let follow_http_client = FollowHttpClient::new().expect("failed to create follow http client");
    let debug = std::env::var("LIVEDECK_DEBUG").map(|v| v == "1").unwrap_or(false);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if debug { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| {
            use tauri::Manager;
            app.manage(proxy::start()?);

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                if let Err(e) = apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None) {
                    tracing::warn!("vibrancy unavailable: {:?}", e);
                }
            }
            Ok(())
        })
        .manage(client)
        // Separate pool so follow-list refreshes don't starve first-screen loads.
        .manage(follow_http_client)
        .manage(commands::danmaku::DanmakuSessions::default())
        .manage(platforms::bilibili::state::BilibiliState::default())
        .invoke_handler(tauri::generate_handler![
            // Playback + proxy
            commands::live_stream_v2_cmd::get_live_stream_v2,
            proxy::get_proxy_base,
            // Danmaku (all platforms)
            commands::danmaku::start_danmaku,
            commands::danmaku::stop_danmaku,
            // Browse + search
            commands::douyu_categories::fetch_categories,
            commands::douyu_live_list::fetch_live_list,
            commands::douyu_live_list::fetch_live_list_for_cate3,
            commands::douyu_three_cate::fetch_three_cate,
            commands::douyin_ms_token::generate_douyin_ms_token,
            commands::douyin_streamer_list::fetch_douyin_partition_rooms,
            commands::huya_live_list::fetch_huya_live_list,
            commands::huya_search::search_huya_anchors,
            commands::bilibili_live_list::fetch_bilibili_live_list,
            commands::bilibili_search::search_bilibili_rooms,
            search_anchor,
            // Bilibili session
            platforms::bilibili::state::generate_bilibili_w_webid,
            platforms::bilibili::cookie::get_bilibili_cookie,
            platforms::bilibili::cookie::bootstrap_bilibili_cookie,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
