use reqwest::header::{HeaderMap, HeaderValue, COOKIE, REFERER, USER_AGENT};

use crate::proxy::Proxy;

use crate::platforms::common::errors::DtvError;

pub async fn get_bilibili_live_stream_url_with_quality(
    proxy: &Proxy,
    payload: crate::platforms::common::GetStreamUrlPayload,
    quality: String,
    cookie: Option<String>,
) -> Result<crate::platforms::common::LiveStreamInfo, DtvError> {
    let room_id = payload.args.room_id_str.clone();
    
    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

    // Build headers
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_str(ua).unwrap());
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://live.bilibili.com/"),
    );
    if let Some(c) = cookie.as_ref() {
        let c_trimmed = c.trim();
        if !c_trimmed.is_empty() {
            match HeaderValue::from_str(c_trimmed) {
                Ok(val) => {
                    headers.insert(COOKIE, val);
                    tracing::debug!("[Bilibili] Cookie header set (content: {})", crate::platforms::common::logging::mask_sensitive(c_trimmed));
                }
                Err(err) => {
                    tracing::warn!("[Bilibili] Invalid cookie header, skipping. Error: {}", err);
                }
            }
        }
    }

    headers.insert(
        reqwest::header::ORIGIN,
        HeaderValue::from_static("https://live.bilibili.com"),
    );
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .http1_only()
        .connect_timeout(std::time::Duration::from_secs(15))
        .no_proxy()
        .build()
        .map_err(|e| DtvError::internal(format!("Failed to build client: {}", e)))?;

    let mut info = livedeck_core::platforms::bilibili::stream_url::get_bilibili_stream_url(
        &client,
        &room_id,
        &quality,
        cookie.as_deref()
    ).await?;

    // FLV goes through the proxy (needs Referer); HLS plays directly.
    if let Some(real_url) = info.stream_url.clone() {
        if real_url.contains(".flv") {
            info.stream_url = Some(proxy.register_stream("bilibili", &room_id, real_url, None));
        }
    }

    Ok(info)
}
