use std::env;

/// Helper to mask sensitive data like cookies or signed URLs unless LIVEDECK_DEBUG=1
pub fn mask_sensitive(data: &str) -> String {
    if env::var("LIVEDECK_DEBUG").map(|v| v == "1").unwrap_or(false) {
        data.to_string()
    } else {
        "***MASKED***".to_string()
    }
}
