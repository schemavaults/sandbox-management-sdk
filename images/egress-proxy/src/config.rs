//! The proxy's config: JSON in `SANDBOX_EGRESS_PROXY_CONFIG`, written by the
//! SDK's Docker provider (`egressProxyConfig` in `src/docker/egress.ts`).
//! Keep the two in step.

use serde_json::{Map, Value};

use crate::cidr::Cidr;

/// Environment variable the proxy reads its config from.
pub const CONFIG_ENV: &str = "SANDBOX_EGRESS_PROXY_CONFIG";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// Port of the HTTP proxy (plain requests and `CONNECT`).
    pub port: u16,
    pub policy: Allowlist,
    /// Ranges of the clients that may use the HTTP proxy. Loopback always may.
    pub clients: Vec<Cidr>,
    pub forwards: Vec<Forward>,
}

/// A `spec.network` allowlist. A `"deny-all"` sandbox with ports gets an empty one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Allowlist {
    pub allow_domains: Vec<String>,
    pub allow_cidrs: Vec<Cidr>,
    pub deny_cidrs: Vec<Cidr>,
}

/// A TCP port the proxy forwards to the sandbox, so it can be published on the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Forward {
    pub port: u16,
    pub host: String,
    pub target_port: u16,
}

const ALLOWLIST_FIELDS: [&str; 3] = ["allowDomains", "allowCidrs", "denyCidrs"];

impl Config {
    /// Parses and checks the config, with the checks the SDK makes before
    /// writing it. The error describes the first problem found.
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let raw = raw.filter(|raw| !raw.is_empty()).ok_or_else(|| format!("{CONFIG_ENV} is not set"))?;
        let config: Value =
            serde_json::from_str(raw).map_err(|error| format!("{CONFIG_ENV} is not valid JSON: {error}"))?;
        let port = port(config.get("port")).ok_or("config.port must be a port number")?;
        let policy = match config.get("policy") {
            Some(Value::Object(policy)) => Allowlist::parse(policy)?,
            Some(Value::Array(_)) => {
                return Err(
                    r#"network must be "allow-all", "deny-all" or { allowDomains?, allowCidrs?, denyCidrs? }"#.into()
                );
            }
            _ => return Err("config.policy must be an allowlist".into()),
        };
        let Some(Value::Array(clients)) = config.get("clients") else {
            return Err("config.clients must be an array of CIDRs".into());
        };
        let clients = clients
            .iter()
            .map(|client| client.as_str().and_then(Cidr::parse).ok_or_else(|| format!("Invalid CIDR {client}")))
            .collect::<Result<_, _>>()?;
        let Some(Value::Array(forwards)) = config.get("forwards") else {
            return Err("config.forwards must be an array".into());
        };
        let forwards = forwards
            .iter()
            .map(forward)
            .collect::<Option<_>>()
            .ok_or("config.forwards entries must be { port, host, targetPort }")?;
        Ok(Self { port, policy, clients, forwards })
    }
}

impl Allowlist {
    /// Checks an allowlist as `validateNetworkPolicy` (`src/network.ts`) does, with its messages.
    pub fn parse(allowlist: &Map<String, Value>) -> Result<Self, String> {
        if let Some(key) = allowlist.keys().find(|key| !ALLOWLIST_FIELDS.contains(&key.as_str())) {
            return Err(format!("Unknown field network.{key}; expected allowDomains, allowCidrs or denyCidrs"));
        }
        let allow_domains = strings(allowlist, "allowDomains")?;
        for domain in &allow_domains {
            if Cidr::parse(domain).is_some() {
                return Err(format!(r#"network.allowDomains has the IP address "{domain}"; put it in allowCidrs"#));
            }
            if domain != "*" && !is_domain(domain) {
                return Err(format!(
                    r#"Invalid domain "{domain}" in network.allowDomains; expected a host name such as "github.com" or "*.github.com""#
                ));
            }
        }
        Ok(Self {
            allow_domains,
            allow_cidrs: cidrs(allowlist, "allowCidrs")?,
            deny_cidrs: cidrs(allowlist, "denyCidrs")?,
        })
    }
}

/// An integer from 1 to 65535.
fn port(value: Option<&Value>) -> Option<u16> {
    let value = value?.as_f64()?;
    (value.fract() == 0.0 && (1.0..=65535.0).contains(&value)).then_some(value as u16)
}

fn forward(value: &Value) -> Option<Forward> {
    Some(Forward {
        port: port(value.get("port"))?,
        host: value.get("host")?.as_str()?.to_owned(),
        target_port: port(value.get("targetPort"))?,
    })
}

fn strings(allowlist: &Map<String, Value>, field: &str) -> Result<Vec<String>, String> {
    let Some(value) = allowlist.get(field) else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .and_then(|items| items.iter().map(|item| item.as_str().map(str::to_owned)).collect())
        .ok_or_else(|| format!("network.{field} must be an array of strings"))
}

fn cidrs(allowlist: &Map<String, Value>, field: &str) -> Result<Vec<Cidr>, String> {
    strings(allowlist, field)?
        .iter()
        .map(|cidr| {
            Cidr::parse(cidr).ok_or_else(|| {
                format!(r#"Invalid IP address or CIDR "{cidr}" in network.{field}; expected e.g. "203.0.113.10" or "10.0.0.0/8""#)
            })
        })
        .collect()
}

/// A host name such as `github.com`, or a wildcard such as `*.github.com`.
fn is_domain(domain: &str) -> bool {
    let name = domain.strip_prefix("*.").unwrap_or(domain);
    domain.len() <= 253 && name.split('.').all(is_label)
}

fn is_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    (1..=63).contains(&bytes.len())
        && bytes.iter().all(|&byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parse(config: Value) -> Result<Config, String> {
        Config::parse(Some(&config.to_string()))
    }

    fn valid() -> Value {
        json!({
            "port": 3128,
            "policy": { "allowDomains": ["github.com"] },
            "clients": ["172.18.0.0/16"],
            "forwards": [{ "port": 3000, "host": "sandbox", "targetPort": 3000 }],
        })
    }

    fn with(field: &str, value: Value) -> Value {
        let mut config = valid();
        config[field] = value;
        config
    }

    fn error(config: Value) -> String {
        parse(config).unwrap_err()
    }

    #[test]
    fn accepts_a_valid_config() {
        assert_eq!(
            parse(valid()).unwrap(),
            Config {
                port: 3128,
                policy: Allowlist { allow_domains: vec!["github.com".into()], ..Allowlist::default() },
                clients: vec![Cidr::parse("172.18.0.0/16").unwrap()],
                forwards: vec![Forward { port: 3000, host: "sandbox".into(), target_port: 3000 }],
            }
        );
        let full = with(
            "policy",
            json!({ "allowDomains": ["*", "*.npmjs.org", "API.Example.com"], "allowCidrs": ["10.0.0.0/8", "2001:db8::1"], "denyCidrs": [] }),
        );
        assert_eq!(parse(full).unwrap().policy.allow_cidrs.len(), 2);
        assert_eq!(parse(with("port", json!(3128.0))).unwrap().port, 3128);
        assert_eq!(parse(with("policy", json!({}))).unwrap().policy, Allowlist::default());
    }

    #[test]
    fn rejects_broken_configs() {
        assert_eq!(Config::parse(None).unwrap_err(), "SANDBOX_EGRESS_PROXY_CONFIG is not set");
        assert_eq!(Config::parse(Some("")).unwrap_err(), "SANDBOX_EGRESS_PROXY_CONFIG is not set");
        assert!(Config::parse(Some("{")).unwrap_err().starts_with("SANDBOX_EGRESS_PROXY_CONFIG is not valid JSON"));
        for port in [json!(0), json!(65536), json!(1.5), json!("3128"), json!(null)] {
            assert_eq!(error(with("port", port)), "config.port must be a port number");
        }
        assert_eq!(error(with("policy", json!("deny-all"))), "config.policy must be an allowlist");
        assert_eq!(error(with("policy", json!(null))), "config.policy must be an allowlist");
        assert!(error(with("policy", json!([]))).starts_with("network must be"));
        assert_eq!(error(with("clients", json!("10.0.0.0/8"))), "config.clients must be an array of CIDRs");
        assert_eq!(error(with("clients", json!(["nope"]))), r#"Invalid CIDR "nope""#);
        assert_eq!(error(with("forwards", json!({}))), "config.forwards must be an array");
        for forward in [json!({ "port": 1 }), json!({ "port": 1, "host": 2, "targetPort": 1 }), json!(null)] {
            assert_eq!(
                error(with("forwards", json!([forward]))),
                "config.forwards entries must be { port, host, targetPort }"
            );
        }
    }

    #[test]
    fn checks_the_allowlist_like_the_sdk() {
        let policy = |policy: Value| error(with("policy", policy));
        assert_eq!(
            policy(json!({ "allow": [] })),
            "Unknown field network.allow; expected allowDomains, allowCidrs or denyCidrs"
        );
        assert_eq!(policy(json!({ "allowDomains": "github.com" })), "network.allowDomains must be an array of strings");
        assert_eq!(policy(json!({ "denyCidrs": [1] })), "network.denyCidrs must be an array of strings");
        assert_eq!(
            policy(json!({ "allowDomains": ["10.0.0.1"] })),
            r#"network.allowDomains has the IP address "10.0.0.1"; put it in allowCidrs"#
        );
        for domain in ["", "-a.com", "a-.com", "a..com", "a.com.", "*.*.com", "a_b.com", "*a.com", "**"] {
            assert!(policy(json!({ "allowDomains": [domain] })).starts_with(&format!(r#"Invalid domain "{domain}""#)));
        }
        let long = format!("{}.com", vec!["a".repeat(63); 4].join("."));
        assert!(policy(json!({ "allowDomains": [long] })).starts_with("Invalid domain"));
        assert!(policy(json!({ "allowDomains": ["a".repeat(64) + ".com"] })).starts_with("Invalid domain"));
        assert_eq!(
            policy(json!({ "allowCidrs": ["10.0.0.0/33"] })),
            r#"Invalid IP address or CIDR "10.0.0.0/33" in network.allowCidrs; expected e.g. "203.0.113.10" or "10.0.0.0/8""#
        );
        assert!(parse(with("policy", json!({ "allowDomains": ["*", "a-b.c0m", "*.x.io", "A.B"] }))).is_ok());
    }
}
