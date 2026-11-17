//! `spec.network` allowlist semantics, shared with the SDK's Vercel provider:
//!
//! - A host name is allowed if it is on `allowDomains`, or if it resolves to an
//!   address in `allowCidrs`. A leading `*.` matches any subdomain (not the
//!   domain itself), and `"*"` matches every name.
//! - An IP address is allowed if it is in `allowCidrs`.
//! - Addresses in `denyCidrs` are never connected to, whatever allowed them.

use std::collections::HashSet;
use std::net::IpAddr;

use crate::cidr::{Cidr, in_ranges};
use crate::config::Allowlist;

/// Destinations the proxy never connects to: its own loopback and the unspecified address.
pub const PROXY_LOCAL_CIDRS: [&str; 4] = ["127.0.0.0/8", "0.0.0.0/8", "::1/128", "::/128"];

/// `PROXY_LOCAL_CIDRS`, parsed.
pub fn proxy_local_ranges() -> Vec<Cidr> {
    PROXY_LOCAL_CIDRS.iter().filter_map(|cidr| Cidr::parse(cidr)).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Connect to this address.
    Allow(IpAddr),
    /// Refuse the connection, for this reason.
    Deny(String),
}

pub struct EgressPolicy {
    any_domain: bool,
    domains: HashSet<String>,
    /// `*.example.com` entries, as `.example.com`.
    suffixes: Vec<String>,
    allow: Vec<Cidr>,
    deny: Vec<Cidr>,
}

impl EgressPolicy {
    /// The policy for `allowlist`, which also refuses every address in `always_deny`.
    pub fn new(allowlist: &Allowlist, always_deny: &[Cidr]) -> Self {
        let domains: Vec<String> = allowlist.allow_domains.iter().map(|domain| domain.to_lowercase()).collect();
        Self {
            any_domain: domains.iter().any(|domain| domain == "*"),
            suffixes: domains
                .iter()
                .filter_map(|domain| domain.strip_prefix("*."))
                .map(|domain| format!(".{domain}"))
                .collect(),
            domains: domains.into_iter().filter(|domain| !domain.starts_with('*')).collect(),
            allow: allowlist.allow_cidrs.clone(),
            deny: allowlist.deny_cidrs.iter().chain(always_deny).copied().collect(),
        }
    }

    /// Whether `name` (a normalized host name, not an IP address) is on the domain allowlist.
    pub fn allows_name(&self, name: &str) -> bool {
        self.any_domain
            || self.domains.contains(name)
            || self.suffixes.iter().any(|suffix| name.ends_with(suffix.as_str()))
    }

    /// Whether `name` must be resolved to decide on it. Names that are neither
    /// allowlisted nor could match `allowCidrs` are refused without a DNS query,
    /// so a sandbox cannot use the proxy to leak data through DNS lookups.
    pub fn needs_resolution(&self, name: &str) -> bool {
        self.allows_name(name) || !self.allow.is_empty()
    }

    /// Picks the address to connect to for `host` (normalized with
    /// `normalize_host`), given what it resolved to. An IP address host
    /// resolves to itself. An IPv4-mapped IPv6 address is picked as the IPv4
    /// address it carries.
    pub fn decide(&self, host: &str, addresses: &[IpAddr]) -> Decision {
        let name_allowed = host.parse::<IpAddr>().is_err() && self.allows_name(host);
        let mut blocked = false;
        for &address in addresses {
            if !name_allowed && !in_ranges(address, &self.allow) {
                continue;
            }
            if in_ranges(address, &self.deny) {
                blocked = true;
                continue;
            }
            return Decision::Allow(address.to_canonical());
        }
        Decision::Deny(if blocked {
            format!("{host} only resolves to blocked addresses")
        } else {
            format!("{host} is not on this sandbox's network allowlist")
        })
    }
}

/// Lowercases a host, and strips IPv6 brackets and a trailing dot.
pub fn normalize_host(host: &str) -> String {
    let unbracketed = host.strip_prefix('[').and_then(|host| host.strip_suffix(']')).unwrap_or(host);
    let lower = unbracketed.to_lowercase();
    match lower.strip_suffix('.') {
        Some(stripped) => stripped.to_owned(),
        None => lower,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cidrs(values: &[&str]) -> Vec<Cidr> {
        values.iter().map(|value| Cidr::parse(value).unwrap()).collect()
    }

    fn ips(values: &[&str]) -> Vec<IpAddr> {
        values.iter().map(|value| value.parse().unwrap()).collect()
    }

    fn allow(address: &str) -> Decision {
        Decision::Allow(address.parse().unwrap())
    }

    fn deny(reason: &str) -> Decision {
        Decision::Deny(reason.into())
    }

    fn policy() -> EgressPolicy {
        EgressPolicy::new(
            &Allowlist {
                allow_domains: vec!["github.com".into(), "*.npmjs.org".into(), "API.Example.com".into()],
                allow_cidrs: cidrs(&["10.0.0.0/8", "2001:db8::/32"]),
                deny_cidrs: cidrs(&["10.9.0.0/16"]),
            },
            &cidrs(&["127.0.0.0/8"]),
        )
    }

    fn domains(domains: &[&str]) -> EgressPolicy {
        EgressPolicy::new(
            &Allowlist {
                allow_domains: domains.iter().map(|domain| domain.to_string()).collect(),
                ..Allowlist::default()
            },
            &[],
        )
    }

    #[test]
    fn allows_names_on_the_allowlist_matching_wildcards_on_subdomains_only() {
        let policy = policy();
        assert_eq!(policy.decide("github.com", &ips(&["140.82.112.3"])), allow("140.82.112.3"));
        assert_eq!(policy.decide("registry.npmjs.org", &ips(&["104.16.0.1"])), allow("104.16.0.1"));
        assert_eq!(policy.decide("a.b.npmjs.org", &ips(&["104.16.0.1"])), allow("104.16.0.1"));
        assert_eq!(policy.decide("api.example.com", &ips(&["93.184.215.14"])), allow("93.184.215.14"));
        assert_eq!(
            policy.decide("npmjs.org", &ips(&["104.16.0.1"])),
            deny("npmjs.org is not on this sandbox's network allowlist")
        );
        assert!(matches!(policy.decide("github.com.evil.dev", &ips(&["1.2.3.4"])), Decision::Deny(_)));
        assert!(matches!(policy.decide("evilgithub.com", &ips(&["1.2.3.4"])), Decision::Deny(_)));
        assert!(matches!(policy.decide("evilnpmjs.org", &ips(&["104.16.0.1"])), Decision::Deny(_)));
    }

    #[test]
    fn allows_addresses_in_allow_cidrs_and_never_denied_or_proxy_local_ones() {
        let policy = policy();
        assert_eq!(policy.decide("10.1.2.3", &ips(&["10.1.2.3"])), allow("10.1.2.3"));
        assert_eq!(policy.decide("2001:db8::5", &ips(&["2001:db8::5"])), allow("2001:db8::5"));
        assert_eq!(policy.decide("db.internal", &ips(&["10.1.2.3"])), allow("10.1.2.3"));
        assert_eq!(policy.decide("::ffff:10.1.2.3", &ips(&["::ffff:10.1.2.3"])), allow("10.1.2.3"));
        assert!(matches!(policy.decide("11.0.0.1", &ips(&["11.0.0.1"])), Decision::Deny(_)));
        assert_eq!(
            policy.decide("github.com", &ips(&["10.9.1.1"])),
            deny("github.com only resolves to blocked addresses")
        );
        assert_eq!(policy.decide("github.com", &ips(&["10.9.1.1", "140.82.112.3"])), allow("140.82.112.3"));
        assert!(matches!(policy.decide("github.com", &ips(&["127.0.0.1"])), Decision::Deny(_)));
        assert!(matches!(policy.decide("github.com", &ips(&["::ffff:127.0.0.1"])), Decision::Deny(_)));
        assert!(matches!(policy.decide("github.com", &[]), Decision::Deny(_)));
    }

    #[test]
    fn only_resolves_names_that_could_be_allowed() {
        let policy = policy();
        assert!(policy.needs_resolution("github.com"));
        assert!(policy.needs_resolution("anything.dev")); // allowCidrs could match it
        let domains_only = domains(&["github.com"]);
        assert!(domains_only.needs_resolution("github.com"));
        assert!(!domains_only.needs_resolution("leak.attacker.dev"));
        assert_eq!(domains(&["*"]).decide("anything.dev", &ips(&["1.2.3.4"])), allow("1.2.3.4"));
        assert!(matches!(domains(&["*"]).decide("1.2.3.4", &ips(&["1.2.3.4"])), Decision::Deny(_)));
    }

    #[test]
    fn refuses_proxy_local_addresses_by_default() {
        let policy = EgressPolicy::new(
            &Allowlist {
                allow_domains: vec!["*".into()],
                allow_cidrs: cidrs(&["0.0.0.0/0", "::/0"]),
                deny_cidrs: Vec::new(),
            },
            &proxy_local_ranges(),
        );
        for local in ["127.0.0.1", "127.255.0.1", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1"] {
            assert!(matches!(policy.decide("localhost", &ips(&[local])), Decision::Deny(_)), "{local}");
            assert!(matches!(policy.decide(local, &ips(&[local])), Decision::Deny(_)), "{local}");
        }
        assert_eq!(policy.decide("example.com", &ips(&["93.184.215.14"])), allow("93.184.215.14"));
    }

    #[test]
    fn normalizes_hosts() {
        assert_eq!(normalize_host("GitHub.COM."), "github.com");
        assert_eq!(normalize_host("[2001:DB8::1]"), "2001:db8::1");
        assert_eq!(normalize_host("github.com"), "github.com");
    }
}
