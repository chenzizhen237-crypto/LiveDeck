//! Local HTTP proxy for live streams and images.
//!
//! Platform CDNs check Referer/User-Agent, which the webview cannot set, so the
//! player and <img> tags load through this proxy instead. A single server is
//! started at launch on a free loopback port and serves:
//!
//! - `/live/{platform}/{room_id}.flv`: one entry per room, so several players can
//!   run at once. Douyu entries carry a renew context so the relay can swap in a
//!   fresh URL before the CDN's 300s cut-off.
//! - `/image?url=...`: avatar/cover images with the right Referer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use bytes::Bytes;
use futures_util::TryStreamExt;
use livedeck_core::platforms::common::flv_relay::{self, StreamRenewContext};
use reqwest::Client;
use serde::Deserialize;
use tokio::sync::mpsc;

const DEFAULT_STREAM_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// Huya's CDN expects the desktop SDK UA (matches pure_live).
const HUYA_HYSDK_UA: &str =
    "HYSDK(Windows,30000002)_APP(pc_exe&7080000&official)_SDK(trans&2.34.0.5795)";

#[derive(Clone)]
struct StreamEntry {
    url: String,
    renew: Option<StreamRenewContext>,
}

type RoomKey = (String, String); // (platform, room_id)

/// Managed Tauri state: the proxy's base URL plus the per-room upstream table.
#[derive(Clone)]
pub struct Proxy {
    base_url: String,
    streams: Arc<Mutex<HashMap<RoomKey, StreamEntry>>>,
}

impl Proxy {
    /// Points `/live/{platform}/{room_id}.flv` at `upstream_url` and returns that proxy URL.
    pub fn register_stream(
        &self,
        platform: &str,
        room_id: &str,
        upstream_url: String,
        renew: Option<StreamRenewContext>,
    ) -> String {
        self.streams.lock().unwrap().insert(
            (platform.to_string(), room_id.to_string()),
            StreamEntry { url: upstream_url, renew },
        );
        format!("{}/live/{}/{}.flv", self.base_url, platform, room_id)
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

fn build_client() -> Client {
    Client::builder()
        .no_proxy()
        .http1_only()
        .gzip(false)
        .brotli(false)
        .no_deflate()
        .pool_idle_timeout(None)
        .pool_max_idle_per_host(4)
        .tcp_keepalive(Duration::from_secs(60))
        .timeout(Duration::from_secs(7200))
        .build()
        .expect("failed to build proxy client")
}

/// Binds an OS-assigned loopback port and runs the proxy in the background.
pub fn start() -> std::io::Result<Proxy> {
    let streams: Arc<Mutex<HashMap<RoomKey, StreamEntry>>> = Arc::default();
    let streams_for_app = web::Data::new(streams.clone());

    let server = HttpServer::new(move || {
        App::new()
            .app_data(streams_for_app.clone())
            .app_data(web::Data::new(build_client()))
            .wrap(actix_cors::Cors::permissive())
            .route("/live/{platform}/{room_id}", web::get().to(flv_proxy_handler))
            .route("/image", web::get().to(image_proxy_handler))
    })
    .keep_alive(Duration::from_secs(120))
    .workers(2)
    .bind(("127.0.0.1", 0))?;

    let port = server
        .addrs()
        .first()
        .map(|a| a.port())
        .ok_or_else(|| std::io::Error::other("proxy bound to no address"))?;
    let server = server.run();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.await {
            tracing::error!("[proxy] server stopped with error: {}", e);
        }
    });

    tracing::info!("[proxy] listening on 127.0.0.1:{}", port);
    Ok(Proxy {
        base_url: format!("http://127.0.0.1:{}", port),
        streams,
    })
}

#[tauri::command]
pub fn get_proxy_base(proxy: tauri::State<'_, Proxy>) -> String {
    proxy.base_url().to_string()
}

async fn flv_proxy_handler(
    path: web::Path<(String, String)>,
    streams: web::Data<Arc<Mutex<HashMap<RoomKey, StreamEntry>>>>,
    client: web::Data<Client>,
) -> impl Responder {
    let (platform, room_file) = path.into_inner();
    let room_id = room_file.trim_end_matches(".flv").to_string();
    let entry = streams
        .lock()
        .unwrap()
        .get(&(platform.clone(), room_id.clone()))
        .cloned();
    let Some(StreamEntry { url, renew }) = entry else {
        return HttpResponse::NotFound().body(format!("No stream registered for {}/{}", platform, room_id));
    };

    // Open the first segment synchronously so upstream errors reach the player as-is.
    let first_body = match flv_relay::open_stream(&client, &url, DEFAULT_STREAM_UA, HUYA_HYSDK_UA).await {
        Ok(body) => body,
        Err(flv_relay::OpenError::Status { status, body }) => {
            tracing::warn!("[proxy] {}/{} upstream returned {}", platform, room_id, status);
            let code = actix_web::http::StatusCode::from_u16(status.as_u16())
                .unwrap_or(actix_web::http::StatusCode::BAD_GATEWAY);
            return HttpResponse::build(code).body(body);
        }
        Err(flv_relay::OpenError::Connect(e)) => {
            tracing::warn!("[proxy] {}/{} connect failed: {}", platform, room_id, e);
            return HttpResponse::BadGateway().body(e.to_string());
        }
    };

    // Small channel: a large buffer here adds latency in front of the player's own buffer.
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    tauri::async_runtime::spawn(flv_relay::run(
        tx,
        first_body,
        renew,
        client.get_ref().clone(),
        DEFAULT_STREAM_UA.to_string(),
        HUYA_HYSDK_UA.to_string(),
    ));

    let byte_stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    })
    .map_err(actix_web::error::ErrorInternalServerError);

    HttpResponse::Ok()
        .content_type("video/x-flv")
        .insert_header(("Cache-Control", "no-store"))
        .streaming(byte_stream)
}

#[derive(Deserialize)]
struct ImageQuery {
    url: String,
}

async fn image_proxy_handler(query: web::Query<ImageQuery>, client: web::Data<Client>) -> impl Responder {
    let url = query.into_inner().url;
    if url.is_empty() {
        return HttpResponse::BadRequest().body("Missing url query parameter");
    }

    let mut req = client
        .get(&url)
        .header("User-Agent", DEFAULT_STREAM_UA)
        .header("Accept", "image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5");
    // Referers that get past each platform's hotlink protection.
    if url.contains("hdslb.com") || url.contains("bilibili.com") {
        req = req
            .header("Referer", "https://live.bilibili.com/")
            .header("Origin", "https://live.bilibili.com");
    } else if url.contains("huya.com") {
        req = req
            .header("Referer", "https://www.huya.com/")
            .header("Origin", "https://www.huya.com");
    } else if url.contains("douyin") || url.contains("douyinpic.com") {
        req = req.header("Referer", "https://www.douyin.com/");
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return HttpResponse::BadGateway().body(e.to_string()),
    };
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    // Read the whole body: chunked image responses hit early-EOF on Windows.
    match resp.bytes().await {
        Ok(bytes) if status.is_success() => HttpResponse::Ok()
            .content_type(content_type)
            .insert_header(("Cache-Control", "max-age=3600"))
            .body(bytes),
        Ok(_) => HttpResponse::build(
            actix_web::http::StatusCode::from_u16(status.as_u16())
                .unwrap_or(actix_web::http::StatusCode::BAD_GATEWAY),
        )
        .finish(),
        Err(e) => HttpResponse::BadGateway().body(e.to_string()),
    }
}
