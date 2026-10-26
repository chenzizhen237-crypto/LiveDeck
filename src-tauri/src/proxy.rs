use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use bytes::Bytes;
use futures_util::TryStreamExt;
use reqwest::Client;
use crate::flv_relay;
use crate::StreamUrlStore;
use serde::Deserialize;
use std::time::Duration;
use tauri::State;
use tokio::sync::mpsc;

/// The local proxy. Started once at launch on an OS-assigned loopback port
/// (upstream used fixed ports 34719/34721 and rebuilt the server per stream).
pub struct ProxyServer {
    port: u16,
}

impl ProxyServer {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Proxy URL for a stream key; the default key keeps upstream's `/live.flv`.
    pub fn stream_url(&self, key: &str) -> String {
        if key == StreamUrlStore::DEFAULT_KEY {
            format!("{}/live.flv", self.base_url())
        } else {
            format!("{}/live/{}.flv", self.base_url(), key)
        }
    }

    pub fn spawn(store: StreamUrlStore) -> std::io::Result<Self> {
        let store_data = web::Data::new(store);
        let server = HttpServer::new(move || {
            App::new()
                .app_data(store_data.clone())
                .app_data(web::Data::new(build_client()))
                .app_data(web::Data::new(ImageClient(build_image_client())))
                .wrap(actix_cors::Cors::permissive())
                .route("/live.flv", web::get().to(default_flv_handler))
                .route("/live/{key}.flv", web::get().to(keyed_flv_handler))
                .route("/image", web::get().to(image_proxy_handler))
        })
        .keep_alive(Duration::from_secs(120))
        .bind(("127.0.0.1", 0))?;
        let port = server
            .addrs()
            .first()
            .map(|a| a.port())
            .ok_or_else(|| std::io::Error::other("proxy bound to no address"))?;
        let server = server.run();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = server.await {
                eprintln!("[Rust/proxy.rs] Proxy server run error: {}", e);
            }
        });
        println!("[Rust/proxy.rs] Proxy listening on 127.0.0.1:{}", port);
        Ok(Self { port })
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
        .expect("failed to build client")
}

// Align with pure_live-master's Huya playback UA
const HUYA_HYSDK_UA: &str =
    "HYSDK(Windows,30000002)_APP(pc_exe&7080000&official)_SDK(trans&2.34.0.5795)";


#[derive(Deserialize)]
struct ImageQuery {
    url: String,
}

/// Image fetches get their own client: short timeouts (the media client allows
/// 2h reads) and redirects re-checked against the same address rules.
pub struct ImageClient(Client);

const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;
const IMAGE_MAX_CONCURRENT: usize = 8;

fn image_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| tokio::sync::Semaphore::new(IMAGE_MAX_CONCURRENT))
}

/// Only public http(s) hosts: `/image` takes any URL from the page, so without
/// this it could be pointed at localhost or the LAN.
fn is_allowed_image_url(url: &url::Url) -> bool {
    use std::net::IpAddr;
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let ip_is_public = |ip: IpAddr| match ip {
        IpAddr::V4(v4) => !(v4.is_loopback()
            || v4.is_private()
            || v4.is_link_local()
            || v4.is_unspecified()
            || v4.is_broadcast()
            || v4.is_multicast()
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64), // CGNAT 100.64/10
        IpAddr::V6(v6) => !(v6.is_loopback()
            || v6.is_unspecified()
            || v6.is_multicast()
            || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique local
            || (v6.segments()[0] & 0xffc0) == 0xfe80 // link local
            || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_private())),
    };
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip_is_public(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => ip_is_public(IpAddr::V6(ip)),
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            !(d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || d.ends_with(".internal"))
        }
        None => false,
    }
}

/// Reads a body but gives up past `max` bytes (Content-Length can be absent or wrong).
async fn read_capped(resp: reqwest::Response, max: usize) -> Result<bytes::Bytes, String> {
    let mut body = bytes::BytesMut::new();
    let mut stream = std::pin::pin!(resp.bytes_stream());
    while let Some(chunk) = stream.try_next().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > max {
            return Err(format!("image larger than {} bytes", max));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}

fn build_image_client() -> Client {
    Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_allowed_image_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .expect("failed to build image client")
}

async fn image_proxy_handler(
    query: web::Query<ImageQuery>,
    client: web::Data<ImageClient>,
) -> impl Responder {
    let url = query.url.clone();
    if url.is_empty() {
        return HttpResponse::BadRequest().body("Missing url query parameter");
    }
    match url::Url::parse(&url) {
        Ok(parsed) if is_allowed_image_url(&parsed) => {}
        _ => return HttpResponse::Forbidden().body("URL not allowed"),
    }
    let Ok(_permit) = image_permits().acquire().await else {
        return HttpResponse::ServiceUnavailable().finish();
    };

    let mut req = client
        .0
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5",
        );

    // Set a Referer to bypass hotlink protections
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

    match req.send().await {
        Ok(upstream_response) => {
            let content_type = upstream_response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();

            // 为避免 Windows 下 chunked 传输的 Early-EOF，改为一次性读取 bytes 并返回
            if upstream_response.status().is_success() {
                if upstream_response
                    .content_length()
                    .is_some_and(|len| len as usize > IMAGE_MAX_BYTES)
                {
                    return HttpResponse::PayloadTooLarge().finish();
                }
                match read_capped(upstream_response, IMAGE_MAX_BYTES).await {
                    Ok(bytes) => HttpResponse::Ok()
                        .content_type(content_type)
                        .insert_header(("Content-Length", bytes.len().to_string()))
                        // Allow the WebView to cache proxied images to avoid re-downloading covers/avatars
                        // when switching routes or scrolling lists.
                        .insert_header(("Cache-Control", "public, max-age=86400, immutable"))
                        .body(bytes),
                    Err(e) => {
                        eprintln!("[Rust/proxy.rs image] Failed to read bytes: {}", e);
                        HttpResponse::InternalServerError()
                            .body(format!("Failed to read image bytes: {}", e))
                    }
                }
            } else {
                let status_from_reqwest = upstream_response.status();
                let error_text = upstream_response
                    .text()
                    .await
                    .unwrap_or_else(|e| format!("Failed to read error body from upstream: {}", e));
                eprintln!(
                    "[Rust/proxy.rs image] Upstream request to {} failed with status: {}. Body: {}",
                    url, status_from_reqwest, error_text
                );
                let actix_status_code =
                    actix_web::http::StatusCode::from_u16(status_from_reqwest.as_u16())
                        .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR);

                HttpResponse::build(actix_status_code).body(format!(
                    "Error fetching IMAGE from upstream (reqwest): {}. Status: {}. Details: {}",
                    url, status_from_reqwest, error_text
                ))
            }
        }
        Err(e) => {
            eprintln!(
                "[Rust/proxy.rs image] Failed to send request to upstream {}: {}",
                url, e
            );
            HttpResponse::InternalServerError()
                .body(format!("Error connecting to upstream IMAGE {}: {}", url, e))
        }
    }
}

const DEFAULT_STREAM_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async fn default_flv_handler(
    _req: HttpRequest,
    stream_url_store: web::Data<StreamUrlStore>,
    client: web::Data<Client>,
) -> HttpResponse {
    flv_proxy_handler(StreamUrlStore::DEFAULT_KEY, &stream_url_store, &client).await
}

async fn keyed_flv_handler(
    path: web::Path<String>,
    stream_url_store: web::Data<StreamUrlStore>,
    client: web::Data<Client>,
) -> HttpResponse {
    flv_proxy_handler(&path.into_inner(), &stream_url_store, &client).await
}

async fn flv_proxy_handler(key: &str, stream_url_store: &StreamUrlStore, client: &Client) -> HttpResponse {
    let Some(entry) = stream_url_store.get(key).filter(|e| !e.url.is_empty()) else {
        return HttpResponse::NotFound().body(format!("Stream URL for '{}' is not set.", key));
    };
    let url = entry.url;
    // 仅斗鱼会登记续流上下文；为空时 relay 退化为一次性直通，行为与改造前一致。
    let renew_ctx = entry.renew;

    println!(
        "[Rust/proxy.rs handler] Incoming FLV proxy request -> {} (renew: {})",
        url,
        if renew_ctx.is_some() { "on" } else { "off" }
    );

    // 首次连接同步完成，便于把上游的错误状态原样透传给前端。
    let first_body =
        match flv_relay::open_stream(client, &url, DEFAULT_STREAM_UA, HUYA_HYSDK_UA).await {
            Ok(body) => body,
            Err(flv_relay::OpenError::Status { status, body }) => {
                eprintln!(
                    "[Rust/proxy.rs handler] Upstream request to {} failed with status: {}. Body: {}",
                    url, status, body
                );
                let actix_status_code = actix_web::http::StatusCode::from_u16(status.as_u16())
                    .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR);
                return HttpResponse::build(actix_status_code).body(format!(
                    "Error fetching FLV stream from upstream (reqwest): {}. Status: {}. Details: {}",
                    url, status, body
                ));
            }
            Err(flv_relay::OpenError::Connect(e)) => {
                eprintln!(
                    "[Rust/proxy.rs handler] Failed to send request to upstream {} with reqwest: {}",
                    url, e
                );
                return HttpResponse::InternalServerError().body(format!(
                    "Error connecting to upstream FLV stream {} with reqwest: {}",
                    url, e
                ));
            }
        };

    // 每个 item 是一个上游字节块。容量不宜大，否则会在播放器之前多压一层缓冲、推高直播延迟。
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    tauri::async_runtime::spawn(flv_relay::run(
        tx,
        first_body,
        renew_ctx,
        client.clone(),
        DEFAULT_STREAM_UA.to_string(),
        HUYA_HYSDK_UA.to_string(),
    ));

    let byte_stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    })
    .map_err(|e| {
        eprintln!("[Rust/proxy.rs handler] Relay stream error: {}", e);
        actix_web::error::ErrorInternalServerError(format!("Upstream stream error: {}", e))
    });

    HttpResponse::Ok()
        .content_type("video/x-flv")
        .insert_header(("Connection", "keep-alive"))
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Accept-Ranges", "bytes"))
        .streaming(byte_stream)
}

/// Returns the proxy URL for a stream registered with `set_stream_url_cmd`.
/// The server is already running; this no longer restarts it.
#[tauri::command]
pub async fn start_proxy(
    key: Option<String>,
    proxy: State<'_, ProxyServer>,
    stream_url_store: State<'_, StreamUrlStore>,
) -> Result<String, String> {
    let key = StreamUrlStore::key_or_default(key);
    if stream_url_store.get(&key).filter(|e| !e.url.is_empty()).is_none() {
        return Err("Stream URL is not set in store. Cannot start proxy.".to_string());
    }
    Ok(proxy.stream_url(&key))
}

/// Base URL for `/image` proxying. Kept for the frontend's existing calls.
#[tauri::command]
pub async fn start_static_proxy_server(proxy: State<'_, ProxyServer>) -> Result<String, String> {
    Ok(proxy.base_url())
}

/// Unregisters a stream. The server stays up (it also serves images and other rooms).
#[tauri::command]
pub async fn stop_proxy(key: Option<String>, stream_url_store: State<'_, StreamUrlStore>) -> Result<(), String> {
    stream_url_store.remove(&StreamUrlStore::key_or_default(key));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_proxy_only_allows_public_http_hosts() {
        let ok = |u: &str| is_allowed_image_url(&url::Url::parse(u).unwrap());
        assert!(ok("https://i0.hdslb.com/bfs/live/cover.jpg"));
        assert!(ok("http://8.8.8.8/a.png"));
        for bad in [
            "file:///etc/passwd",
            "http://localhost:3000/",
            "http://127.0.0.1:63386/live.flv",
            "http://192.168.1.10/",
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.100.1.1/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://printer.local/",
        ] {
            assert!(!ok(bad), "{bad} should be rejected");
        }
    }

    #[test]
    fn store_keys_are_independent() {
        let store = StreamUrlStore::default();
        store.set_url("douyu-1", "https://a.example/1.flv".into());
        store.set_url("huya-2", "https://b.example/2.flv".into());
        assert_eq!(store.get("douyu-1").unwrap().url, "https://a.example/1.flv");
        assert_eq!(store.get("huya-2").unwrap().url, "https://b.example/2.flv");

        store.remove("douyu-1");
        assert!(store.get("douyu-1").is_none());
        assert!(store.get("huya-2").is_some(), "removing one room must not touch another");
    }

    #[test]
    fn missing_or_blank_key_falls_back_to_default() {
        assert_eq!(StreamUrlStore::key_or_default(None), StreamUrlStore::DEFAULT_KEY);
        assert_eq!(StreamUrlStore::key_or_default(Some("  ".into())), StreamUrlStore::DEFAULT_KEY);
        assert_eq!(StreamUrlStore::key_or_default(Some("douyu-9".into())), "douyu-9");
    }

    #[test]
    fn new_url_clears_renew_context() {
        let store = StreamUrlStore::default();
        store.set_url("k", "https://a.example/1.flv".into());
        store.set_renew(
            "k",
            Some(flv_relay::StreamRenewContext {
                room_id: "1".into(),
                quality: "原画".into(),
                line: None,
            }),
        );
        assert!(store.get("k").unwrap().renew.is_some());
        store.set_url("k", "https://a.example/2.flv".into());
        assert!(store.get("k").unwrap().renew.is_none());
    }

    #[test]
    fn stream_urls_keep_legacy_path_for_default_key() {
        let proxy = ProxyServer { port: 4000 };
        assert_eq!(proxy.stream_url(StreamUrlStore::DEFAULT_KEY), "http://127.0.0.1:4000/live.flv");
        assert_eq!(proxy.stream_url("douyu-1"), "http://127.0.0.1:4000/live/douyu-1.flv");
    }

    #[test]
    fn server_binds_a_free_port_and_routes_by_key() {
        tauri::async_runtime::block_on(async {
            let store = StreamUrlStore::default();
            let a = ProxyServer::spawn(store.clone()).expect("spawn a");
            let b = ProxyServer::spawn(store.clone()).expect("spawn b");
            assert_ne!(a.port, 0);
            assert_ne!(a.port, b.port, "each server gets its own OS-assigned port");

            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let res = client.get(a.stream_url("nope")).send().await.unwrap();
            assert_eq!(res.status(), reqwest::StatusCode::NOT_FOUND);
            let res = client.get(a.stream_url(StreamUrlStore::DEFAULT_KEY)).send().await.unwrap();
            assert_eq!(res.status(), reqwest::StatusCode::NOT_FOUND);
        });
    }
}
