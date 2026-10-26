use crate::js_worker::{self, JsWorker};
use log::debug;
use md5::{Digest, Md5};
use rand::Rng;
use std::collections::HashMap;
use url::Url;

// Load sign.js content at compile time
const SIGN_JS_CONTENT: &str = include_str!("./sign.js");

const BOOTSTRAP_JS: &str = r#"
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = {};
    globalThis.navigator = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
"#;

/// One isolate with sign.js loaded once (upstream rebuilt it on every connect).
fn sign_worker() -> &'static JsWorker {
    static WORKER: std::sync::OnceLock<JsWorker> = std::sync::OnceLock::new();
    WORKER.get_or_init(|| {
        JsWorker::spawn("douyin-js", |rt| {
            js_worker::exec(rt, "[bootstrap]", BOOTSTRAP_JS.to_string())?;
            js_worker::exec(rt, "./sign.js", SIGN_JS_CONTENT.to_string()).map(|_| ())
        })
    })
}

pub async fn generate_signature(
    wss_url: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let parsed_url = Url::parse(wss_url)?;
    let params_to_sign_keys = [
        "live_id",
        "aid",
        "version_code",
        "webcast_sdk_version",
        "room_id",
        "sub_room_id",
        "sub_channel_id",
        "did_rule",
        "user_unique_id",
        "device_platform",
        "device_type",
        "ac",
        "identity",
    ];
    let mut query_params_map = HashMap::new();
    for (key, value) in parsed_url.query_pairs() {
        query_params_map.insert(key.into_owned(), value.into_owned());
    }

    let mut tpl_params_vec: Vec<String> = Vec::new();
    for key_str in params_to_sign_keys {
        let value = query_params_map
            .get(key_str)
            .map(|s| s.as_str())
            .unwrap_or("");
        tpl_params_vec.push(format!("{}={}", key_str, value));
    }
    let to_sign_str = tpl_params_vec.join(",");
    debug!("[Douyin Danmaku] String to MD5 for signature: {}", to_sign_str);

    // Use md_5 crate for MD5 computation
    let mut hasher = Md5::new();
    hasher.update(to_sign_str.as_bytes());
    let digest_bytes = hasher.finalize();
    let md5_param = format!("{:x}", digest_bytes);
    debug!("[Douyin Danmaku] MD5 param for signature: {}", md5_param);

    let call_script = format!("get_sign('{}')", md5_param);
    let signature = sign_worker()
        .run(move |rt| js_worker::exec_string(rt, "[call_get_sign]", call_script))
        .await?;
    debug!("[Douyin Danmaku] Final signature computed.");
    Ok(signature)
}

pub fn generate_ms_token(length: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; // Removed _= as they are not typical for msToken
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

#[tauri::command]
pub fn generate_douyin_ms_token() -> String {
    // For now, let's assume msToken length is always 107, as used elsewhere.
    // If variable length is needed, this command could take a length parameter.
    generate_ms_token(107)
}

// Placeholder for the more complex signature generation if needed later.
// pub async fn generate_signature(wss_url: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
//     // ... (implementation from demo if required)
//     unimplemented!();
// }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_works_repeatedly_on_the_shared_runtime() {
        let url = "wss://webcast.example/webcast/im/push/v2/?live_id=1&aid=6383&room_id=42&user_unique_id=7";
        tauri::async_runtime::block_on(async {
            // sign.js mixes in the current time, so values differ call to call
            // (also with a fresh runtime per call, as upstream did); check the shape.
            for _ in 0..3 {
                let sig = generate_signature(url).await.unwrap();
                assert_eq!(sig.len(), 16, "{sig}");
            }
        });
    }
}
