//! Native evidence for the split playback monitor (docs/split-playback-metrics.md).
//!
//! - Relay counters: bytes read from upstream per proxy key, i.e. at the
//!   Internet boundary. Each player connection opens its own upstream request,
//!   so summing connections of one key is real download, not double counting;
//!   loopback bytes to the player are deliberately not counted here.
//! - App CPU: process user+system time between two calls, as percent of one
//!   core. No GPU / video-engine figures: they aren't available, so they stay
//!   missing rather than estimated.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(Default, Clone, Serialize)]
pub struct RelayKeyStats {
    pub key: String,
    pub upstream_bytes: u64,
    pub connections: u32,
    pub renewals: u32,
    pub failures: u32,
}

fn relay() -> &'static Mutex<HashMap<String, RelayKeyStats>> {
    static R: OnceLock<Mutex<HashMap<String, RelayKeyStats>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

fn with_key(key: &str, f: impl FnOnce(&mut RelayKeyStats)) {
    let mut map = relay().lock().unwrap();
    let entry = map.entry(key.to_string()).or_insert_with(|| RelayKeyStats { key: key.to_string(), ..Default::default() });
    f(entry);
}

pub fn add_upstream_bytes(key: &str, n: usize) {
    with_key(key, |s| s.upstream_bytes += n as u64);
}

pub fn renewed(key: &str) {
    with_key(key, |s| s.renewals += 1);
}

pub fn failed(key: &str) {
    with_key(key, |s| s.failures += 1);
}

/// Counts an open relay connection for as long as it lives.
pub struct ConnectionGuard(String);

impl ConnectionGuard {
    pub fn open(key: &str) -> Self {
        with_key(key, |s| s.connections += 1);
        Self(key.to_string())
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        with_key(&self.0, |s| s.connections = s.connections.saturating_sub(1));
    }
}

/// Process CPU seconds (user + system).
fn process_cpu_seconds() -> Option<f64> {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return None;
    }
    let tv = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    Some(tv(usage.ru_utime) + tv(usage.ru_stime))
}

/// Percent of one core since the previous call; None on the first call.
fn cpu_percent_since_last() -> Option<f64> {
    static LAST: OnceLock<Mutex<Option<(Instant, f64)>>> = OnceLock::new();
    let now = Instant::now();
    let cpu = process_cpu_seconds()?;
    let mut last = LAST.get_or_init(Default::default).lock().unwrap();
    let result = last.and_then(|(t, c)| {
        let wall = now.duration_since(t).as_secs_f64();
        (wall >= 0.2).then(|| ((cpu - c) / wall * 100.0).max(0.0))
    });
    if result.is_some() || last.is_none() {
        *last = Some((now, cpu));
    }
    result
}

#[derive(Serialize)]
pub struct NativeStats {
    pub relay: Vec<RelayKeyStats>,
    pub cpu_percent: Option<f64>,
    pub cpu_cores: Option<usize>,
}

#[tauri::command]
pub fn playback_native_stats() -> NativeStats {
    let relay = relay().lock().unwrap().values().cloned().collect();
    NativeStats {
        relay,
        cpu_percent: cpu_percent_since_last(),
        cpu_cores: std::thread::available_parallelism().ok().map(|n| n.get()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_counters_accumulate_per_key_and_track_open_connections() {
        let key = "test-douyu-1";
        {
            let _a = ConnectionGuard::open(key);
            let _b = ConnectionGuard::open(key);
            add_upstream_bytes(key, 1000);
            add_upstream_bytes(key, 500);
            renewed(key);
            let s = relay().lock().unwrap().get(key).cloned().unwrap();
            assert_eq!(s.upstream_bytes, 1500);
            assert_eq!(s.connections, 2);
            assert_eq!(s.renewals, 1);
        }
        assert_eq!(relay().lock().unwrap().get(key).unwrap().connections, 0);
    }

    #[test]
    fn cpu_percent_is_measured_between_calls() {
        let _ = cpu_percent_since_last();
        let start = Instant::now();
        let mut x = 0u64;
        while start.elapsed().as_millis() < 300 {
            x = x.wrapping_mul(31).wrapping_add(7);
        }
        std::hint::black_box(x);
        let pct = cpu_percent_since_last().expect("second call measures");
        assert!(pct > 30.0, "busy loop should use most of a core, got {pct}");
    }
}
