// src/websocket.rs
use serde_json::Value;
use std::sync::OnceLock;

use super::models::{BiliMessage, DanmuServer, MsgHead};

static DEBUG_FLAG: OnceLock<bool> = OnceLock::new();

pub fn is_debug_enabled() -> bool {
    *DEBUG_FLAG.get_or_init(|| {
        std::env::var("DMF_DEBUG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

macro_rules! ws_debug {
    ($($arg:tt)*) => {
        if crate::platforms::bilibili::websocket::is_debug_enabled() {
            println!($($arg)*);
        }
    }
}

/// Messages decoded from one websocket frame.
#[derive(Default)]
pub struct ParsedFrame {
    pub messages: Vec<BiliMessage>,
    /// The server acknowledged our auth packet (op 8).
    pub auth_reply: bool,
}

/// Decodes one websocket frame. A frame may hold several packets, and a
/// brotli packet (ver 3) wraps further packets. Every length is checked, so
/// malformed input is skipped instead of panicking on a slice index.
pub fn parse_frame(data: &[u8]) -> ParsedFrame {
    let mut out = ParsedFrame::default();
    parse_packets(data, &mut out, false);
    out
}

fn parse_packets(data: &[u8], out: &mut ParsedFrame, nested: bool) {
    let mut offset = 0usize;
    while offset + 16 <= data.len() {
        let h = get_msg_header(&data[offset..offset + 16]);
        let len = h.pack_len as usize;
        let header_len = h.raw_header_size as usize;
        if len < 16 || header_len < 16 || header_len > len || offset + len > data.len() {
            ws_debug!("[websocket] malformed packet at {}, dropping rest of frame", offset);
            break;
        }
        let body = &data[offset + header_len..offset + len];
        match h.operation {
            5 => match h.ver {
                3 if !nested => match decompress(body) {
                    Ok(inner) => parse_packets(&inner, out, true),
                    Err(e) => ws_debug!("[websocket] decompress error: {:?}", e),
                },
                0 | 1 => match serde_json::from_slice::<Value>(body) {
                    Ok(json) => match {
                        ws_debug!("[websocket] cmd={}", json["cmd"].as_str().unwrap_or("?"));
                        handle(json)
                    } {
                        Some(BiliMessage::Unsupported { .. }) | None => {}
                        Some(m) => out.messages.push(m),
                    },
                    Err(e) => ws_debug!("[websocket] json parse error: {:?}", e),
                },
                v => ws_debug!("[websocket] unsupported body ver={}, skip", v),
            },
            8 => out.auth_reply = true,
            _ => {} // 3 = popularity, ignored
        }
        offset += len;
    }
}

pub fn gen_damu_list(list: &serde_json::Value) -> Vec<DanmuServer> {
    let mut res: Vec<DanmuServer> = Vec::new();
    if let Some(server_list) = list.as_array() {
        ws_debug!("[websocket] host_list size={}", server_list.len());
        if server_list.is_empty() {
            ws_debug!("[websocket] host_list empty, using default server");
            res.push(DanmuServer::default());
        } else {
            for s in server_list {
                let host = s["host"]
                    .as_str()
                    .unwrap_or("broadcastlv.chat.bilibili.com");
                let port = s["port"].as_i64().unwrap_or(2243) as i32;
                let wss_port = s["wss_port"].as_i64().unwrap_or(443) as i32;
                let ws_port = s["ws_port"].as_i64().unwrap_or(2244) as i32;
                ws_debug!(
                    "[websocket] server {}:{} (wss_port={}, ws_port={})",
                    host,
                    port,
                    wss_port,
                    ws_port
                );
                res.push(DanmuServer {
                    host: host.to_string(),
                    port,
                    wss_port,
                    ws_port,
                });
            }
        }
    } else {
        ws_debug!("[websocket] host_list not an array, using default server");
        res.push(DanmuServer::default());
    }
    res
}

pub enum Operation {
    AUTH,
    HEARTBEAT,
}

pub fn make_packet(body: &str, ops: Operation) -> Vec<u8> {
    let json: Value = serde_json::from_str(body).unwrap();
    let temp = json.to_string();
    let body_content: &[u8] = temp.as_bytes();
    let pack_len: [u8; 4] = ((16 + body.len()) as u32).to_be_bytes();
    let raw_header_size: [u8; 2] = (16 as u16).to_be_bytes();
    let ver: [u8; 2] = (1 as u16).to_be_bytes();
    let operation: [u8; 4] = match ops {
        Operation::AUTH => (7 as u32).to_be_bytes(),
        Operation::HEARTBEAT => (2 as u32).to_be_bytes(),
    };
    let seq_id: [u8; 4] = (1 as u32).to_be_bytes();
    let mut res = pack_len.to_vec();
    res.append(&mut raw_header_size.to_vec());
    res.append(&mut ver.to_vec());
    res.append(&mut operation.to_vec());
    res.append(&mut seq_id.to_vec());
    res.append(&mut body_content.to_vec());
    res
}

pub fn get_msg_header(v_s: &[u8]) -> MsgHead {
    let mut pack_len: [u8; 4] = [0; 4];
    let mut raw_header_size: [u8; 2] = [0; 2];
    let mut ver: [u8; 2] = [0; 2];
    let mut operation: [u8; 4] = [0; 4];
    let mut seq_id: [u8; 4] = [0; 4];
    for (i, v) in v_s.iter().enumerate() {
        if i < 4 {
            pack_len[i] = *v;
            continue;
        }
        if i < 6 {
            raw_header_size[i - 4] = *v;
            continue;
        }
        if i < 8 {
            ver[i - 6] = *v;
            continue;
        }
        if i < 12 {
            operation[i - 8] = *v;
            continue;
        }
        if i < 16 {
            seq_id[i - 12] = *v;
            continue;
        }
    }
    MsgHead {
        pack_len: u32::from_be_bytes(pack_len),
        raw_header_size: u16::from_be_bytes(raw_header_size),
        ver: u16::from_be_bytes(ver),
        operation: u32::from_be_bytes(operation),
        seq_id: u32::from_be_bytes(seq_id),
    }
}

pub fn decompress(body: &[u8]) -> std::io::Result<Vec<u8>> {
    use brotlic::DecompressorReader;
    use std::io::Read;
    let mut decompressed_reader: DecompressorReader<&[u8]> = DecompressorReader::new(body);
    let mut decoded_input = Vec::new();
    let _ = decompressed_reader.read_to_end(&mut decoded_input)?;
    Ok(decoded_input)
}

pub fn handle(json: Value) -> Option<BiliMessage> {
    let category = json["cmd"].as_str().unwrap_or("");
    match category {
        "DANMU_MSG" => Some(BiliMessage::Danmu {
            user: json["info"][2][1]
                .as_str()
                .unwrap_or("<unknown>")
                .to_string(),
            text: json["info"][1].as_str().unwrap_or("").to_string(),
        }),
        "SEND_GIFT" => Some(BiliMessage::Gift {
            user: json["info"][2][1]
                .as_str()
                .unwrap_or("<unknown>")
                .to_string(),
            gift: json["info"][1].as_str().unwrap_or("").to_string(),
        }),
        _ => Some(BiliMessage::Unsupported {
            cmd: category.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(op: u32, ver: u16, body: &[u8]) -> Vec<u8> {
        let mut p = ((16 + body.len()) as u32).to_be_bytes().to_vec();
        p.extend_from_slice(&16u16.to_be_bytes());
        p.extend_from_slice(&ver.to_be_bytes());
        p.extend_from_slice(&op.to_be_bytes());
        p.extend_from_slice(&1u32.to_be_bytes());
        p.extend_from_slice(body);
        p
    }

    fn danmu(text: &str) -> Vec<u8> {
        let json = serde_json::json!({"cmd": "DANMU_MSG", "info": [[], text, [1, "user"]]});
        packet(5, 0, json.to_string().as_bytes())
    }

    #[test]
    fn parses_every_packet_in_a_frame() {
        let mut frame = Vec::new();
        for i in 0..50 {
            frame.extend(danmu(&format!("m{i}")));
        }
        frame.extend(packet(5, 0, br#"{"cmd":"ONLINE_RANK_COUNT"}"#));
        frame.extend(packet(8, 1, b"{}"));
        let parsed = parse_frame(&frame);
        assert_eq!(parsed.messages.len(), 50, "all danmaku in one frame are delivered at once");
        assert!(parsed.auth_reply);
    }

    #[test]
    fn malformed_frames_do_not_panic() {
        assert!(parse_frame(&[]).messages.is_empty());
        assert!(parse_frame(&[0u8; 10]).messages.is_empty());
        let mut bad = danmu("ok");
        bad.extend_from_slice(&[0, 0, 0xff, 0xff, 0, 16, 0, 0, 0, 0, 0, 5, 0, 0, 0, 1]); // length past end
        assert_eq!(parse_frame(&bad).messages.len(), 1);
        let mut tiny = packet(5, 0, b"");
        tiny[3] = 4; // pack_len shorter than the header
        assert!(parse_frame(&tiny).messages.is_empty());
    }
}
