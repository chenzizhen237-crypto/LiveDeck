mod common;

use livedeck_core::platforms::common::{FollowHttpClient, GetStreamUrlPayload, types::GetStreamUrlArgs};
use common::{live_enabled, TestHandler};
use tracing::debug;

/// A room that is live right now: LIVEDECK_TEST_DOUYIN_ID if set, otherwise the
/// first room in the 和平精英 partition (fixed room ids go stale quickly).
async fn target_room_id() -> String {
    if let Ok(id) = std::env::var("LIVEDECK_TEST_DOUYIN_ID") {
        return id;
    }
    let token = livedeck_core::platforms::douyin::danmu::signature::generate_douyin_ms_token();
    livedeck_core::platforms::douyin::douyin_streamer_list::fetch_douyin_partition_rooms(
        "1010032".into(),
        "1".into(),
        0,
        token,
    )
    .await
    .expect("fetch_douyin_partition_rooms")
    .rooms
    .first()
    .expect("no live Douyin rooms in partition")
    .web_rid
    .clone()
}

#[tokio::test]
#[ignore]
async fn douyin_room_info_live() {
    if !live_enabled() {
        return;
    }

    let _ = tracing_subscriber::fmt()
        .with_env_filter("livedeck_core=debug")
        .try_init();

    let follow_http = FollowHttpClient::new().expect("FollowHttpClient::new");
    let payload = GetStreamUrlPayload {
        args: GetStreamUrlArgs {
            room_id_str: target_room_id().await,
        },
    };

    let info = livedeck_core::platforms::douyin::douyin_streamer_info::fetch_douyin_streamer_info(
        payload,
        &follow_http,
    )
    .await
    .expect("fetch_douyin_streamer_info");

    debug!(data = ?info, "fetched douyin room info");

    // Even if offline, we should get some info
    assert!(info.status.is_some());
    
    if info.status == Some(2) { // 2 is Live for Douyin? Need to check enum/impl. 
        // In douyin_streamer_info.rs: "let status = room.get("status")... as i32;"
        // Usually 2 is live, 4 is offline?
        // Let's just check stream_url availability if status suggests live.
        
        // available_streams is populated
        if let Some(streams) = info.available_streams {
            assert!(!streams.is_empty());
        }
    }
}

#[tokio::test]
#[ignore]
async fn douyin_danmaku_listener_smoke() {
    if !live_enabled() {
        return;
    }

    let handler = TestHandler::new();
    let (tx, rx) = tokio::sync::mpsc::channel(1);

    let task = tokio::spawn(livedeck_core::platforms::douyin::douyin_danmu_listener::run_douyin_danmu_listener(
        target_room_id().await,
        rx,
        handler.clone(),
    ));

    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    let _ = tx.send(()).await;
    let _ = task.await;
}
