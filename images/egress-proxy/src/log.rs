//! Log lines, for `docker logs`: `<UTC timestamp> <message>` on stdout.

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// Writes `line` to stdout after the current time. Never fails: a log line
/// that cannot be written is dropped.
pub fn stdout(line: &str) {
    let _ = writeln!(std::io::stdout().lock(), "{} {line}", timestamp(SystemTime::now()));
}

/// `time` in ISO 8601 UTC with milliseconds, e.g. `2026-11-17T16:29:52.944Z`.
pub fn timestamp(time: SystemTime) -> String {
    let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since_epoch.as_secs();
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    let time_of_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time_of_day / 3600,
        time_of_day / 60 % 60,
        time_of_day % 60,
        since_epoch.subsec_millis(),
    )
}

/// The proleptic Gregorian date `days` after 1970-01-01, from Howard Hinnant's
/// `civil_from_days` (<https://howardhinnant.github.io/date_algorithms.html>).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(millis: u64) -> String {
        timestamp(UNIX_EPOCH + Duration::from_millis(millis))
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(at(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(at(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(at(951_868_799_999), "2000-02-29T23:59:59.999Z");
        assert_eq!(at(1_709_251_199_123), "2024-02-29T23:59:59.123Z");
        assert_eq!(at(1_798_761_600_000), "2027-01-01T00:00:00.000Z");
        assert_eq!(at(1_795_019_392_944), "2026-11-18T16:29:52.944Z");
        assert_eq!(at(4_107_542_400_000), "2100-03-01T00:00:00.000Z");
    }
}
