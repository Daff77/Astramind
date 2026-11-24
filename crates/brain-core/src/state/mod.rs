pub mod registry;
pub mod vault_state;

use chrono::{SecondsFormat, Utc};

/// Formats current UTC timestamp as RFC3339 with millisecond precision (`DATA_SCHEMA.md` §2).
#[must_use]
pub fn utc_now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
