//! IP ranges, parsed and matched as the SDK's `parseCidr` (`src/network.ts`) does.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// An IPv4 or IPv6 range such as `10.0.0.0/8`. A bare address is a range of one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    /// The range's first address: host bits are cleared.
    network: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parses an IPv4 or IPv6 address (no zone ID) with an optional `/prefix`.
    /// Host bits may be set (`10.1.2.3/8` is `10.0.0.0/8`).
    pub fn parse(value: &str) -> Option<Self> {
        let (address, prefix) = match value.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (value, None),
        };
        let address: IpAddr = address.parse().ok()?;
        let bits = if address.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => bits,
            Some(prefix) => parse_prefix(prefix).filter(|&prefix| prefix <= bits)?,
        };
        Some(Self { network: masked(address, prefix), prefix })
    }

    /// Whether `ip` is in this range. An IPv4-mapped IPv6 address
    /// (`::ffff:a.b.c.d`) counts as the IPv4 address it carries; an address
    /// of the other IP version is never in the range.
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        ip.is_ipv4() == self.network.is_ipv4() && masked(ip, self.prefix) == self.network
    }
}

impl fmt::Display for Cidr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.network, self.prefix)
    }
}

/// Whether `ip` is in one of `ranges`.
pub fn in_ranges(ip: IpAddr, ranges: &[Cidr]) -> bool {
    ranges.iter().any(|range| range.contains(ip))
}

/// A prefix length as `network.ts` accepts it: 1 to 3 digits, without leading zeros.
fn parse_prefix(prefix: &str) -> Option<u8> {
    let digits = (1..=3).contains(&prefix.len()) && prefix.bytes().all(|byte| byte.is_ascii_digit());
    let leading_zero = prefix.len() > 1 && prefix.starts_with('0');
    if digits && !leading_zero { prefix.parse().ok() } else { None }
}

/// `ip` with all but its first `prefix` bits cleared.
fn masked(ip: IpAddr, prefix: u8) -> IpAddr {
    let prefix = u32::from(prefix);
    match ip {
        IpAddr::V4(ip) => {
            let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
            IpAddr::V4(Ipv4Addr::from(u32::from(ip) & mask))
        }
        IpAddr::V6(ip) => {
            let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
            IpAddr::V6(Ipv6Addr::from(u128::from(ip) & mask))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    #[test]
    fn parses_addresses_and_ranges() {
        assert_eq!(Cidr::parse("10.1.2.3/8").unwrap().to_string(), "10.0.0.0/8");
        assert_eq!(Cidr::parse("203.0.113.10").unwrap().to_string(), "203.0.113.10/32");
        assert_eq!(Cidr::parse("2001:DB8::1").unwrap().to_string(), "2001:db8::1/128");
        assert_eq!(Cidr::parse("2001:db8::/32").unwrap().to_string(), "2001:db8::/32");
        assert_eq!(Cidr::parse("0.0.0.0/0").unwrap().to_string(), "0.0.0.0/0");
        assert_eq!(Cidr::parse("::/0").unwrap().to_string(), "::/0");
        for invalid in [
            "",
            "nope",
            "10.0.0.0/",
            "10.0.0.0/33",
            "::/129",
            "10.0.0.0/08",
            "10.0.0.0/8/8",
            "01.2.3.4",
            "1.2.3",
            "fe80::1%eth0",
            "10.0.0.0/+8",
            "10.0.0.0/1000",
        ] {
            assert_eq!(Cidr::parse(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn matches_addresses_of_the_same_version() {
        let range = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(range.contains(ip("10.255.0.1")));
        assert!(!range.contains(ip("11.0.0.1")));
        assert!(range.contains(ip("::ffff:10.1.2.3")));
        assert!(!range.contains(ip("::a01:203")));
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("1.2.3.4")));
        assert!(!Cidr::parse("0.0.0.0/0").unwrap().contains(ip("2001:db8::1")));
        assert!(Cidr::parse("2001:db8::/32").unwrap().contains(ip("2001:db8:ffff::1")));
        assert!(!Cidr::parse("2001:db8::/32").unwrap().contains(ip("2001:db9::1")));
        assert!(in_ranges(
            ip("172.18.0.2"),
            &[Cidr::parse("10.0.0.0/8").unwrap(), Cidr::parse("172.18.0.0/16").unwrap()]
        ));
        assert!(!in_ranges(ip("172.18.0.2"), &[]));
    }
}
