//! The proxy over loopback, with a fake resolver and a local upstream server.

use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use sandbox_egress_proxy::cidr::Cidr;
use sandbox_egress_proxy::config::{Allowlist, Config, Forward};
use sandbox_egress_proxy::health;
use sandbox_egress_proxy::policy::proxy_local_ranges;
use sandbox_egress_proxy::proxy::{self, Options};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Names the fake resolver knows. They all resolve to loopback, where the upstream listens.
const HOSTS: [&str; 3] = ["allowed.test", "a.wild.test", "wild.test"];

/// Starts an HTTP server on loopback that answers every request with what it
/// received, as JSON, and returns its port.
async fn upstream() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let service = service_fn(|request: Request<Incoming>| async move {
                let (parts, body) = request.into_parts();
                let body = body.collect().await?.to_bytes();
                let headers: Map<String, Value> = parts
                    .headers
                    .keys()
                    .map(|name| {
                        let values: Vec<&str> =
                            parts.headers.get_all(name).iter().map(|value| value.to_str().unwrap()).collect();
                        (name.to_string(), json!(values.join(", ")))
                    })
                    .collect();
                let seen = json!({
                    "method": parts.method.as_str(),
                    "url": parts.uri.to_string(),
                    "headers": headers,
                    "body": String::from_utf8_lossy(&body),
                });
                Ok::<_, hyper::Error>(
                    Response::builder()
                        .header("x-upstream", "yes")
                        .body(Full::new(Bytes::from(seen.to_string())))
                        .unwrap(),
                )
            });
            // Answers requests whose client has closed its side, as most servers do.
            let connection = hyper::server::conn::http1::Builder::new()
                .half_close(true)
                .serve_connection(TokioIo::new(stream), service);
            tokio::spawn(connection);
        }
    });
    port
}

struct TestProxy {
    port: u16,
    forward_port: u16,
    /// Names the proxy asked the resolver for.
    resolved: Arc<Mutex<Vec<String>>>,
    logged: Arc<Mutex<Vec<String>>>,
}

/// Starts a proxy on loopback that may connect to loopback, with a forward to `upstream_port`.
async fn start(upstream_port: u16, policy: Value) -> TestProxy {
    start_with(upstream_port, policy, Vec::new()).await
}

async fn start_with(upstream_port: u16, policy: Value, always_deny: Vec<Cidr>) -> TestProxy {
    let resolved = Arc::new(Mutex::new(Vec::new()));
    let logged = Arc::new(Mutex::new(Vec::new()));
    let config = Config {
        port: 0,
        policy: Allowlist::parse(policy.as_object().unwrap()).unwrap(),
        clients: Vec::new(),
        forwards: vec![Forward { port: 0, host: "127.0.0.1".into(), target_port: upstream_port }],
    };
    let options = Options {
        host: Ipv4Addr::LOCALHOST.into(),
        resolve: {
            let resolved = resolved.clone();
            Arc::new(move |name: String| {
                resolved.lock().unwrap().push(name.clone());
                let result = if HOSTS.contains(&name.as_str()) {
                    Ok(vec![IpAddr::from(Ipv4Addr::LOCALHOST)])
                } else {
                    Err(io::Error::new(io::ErrorKind::NotFound, format!("ENOTFOUND {name}")))
                };
                Box::pin(async move { result })
            })
        },
        always_deny,
        log: {
            let logged = logged.clone();
            Arc::new(move |line: &str| logged.lock().unwrap().push(line.to_owned()))
        },
    };
    let running = proxy::start(&config, options).await.unwrap();
    TestProxy { port: running.port, forward_port: running.forward_ports[0], resolved, logged }
}

/// Sends `request` to `port` and returns everything received until the server closes the connection.
async fn raw(port: u16, request: &str) -> String {
    exchange(port, request, false).await
}

/// Like `raw`, but closes the sending side once the request is written, as busybox nc does.
async fn raw_half_closed(port: u16, request: &str) -> String {
    exchange(port, request, true).await
}

async fn exchange(port: u16, request: &str, half_close: bool) -> String {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    if half_close {
        stream.shutdown().await.unwrap();
    }
    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut received))
        .await
        .expect("the server should close the connection")
        .unwrap();
    String::from_utf8(received).unwrap()
}

fn get(url: &str) -> String {
    let host = url.split('/').nth(2).unwrap();
    format!(
        "GET {url} HTTP/1.1\r\nHost: {host}\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic eDp5\r\nConnection: close\r\n\r\n"
    )
}

/// The JSON body of a response from `upstream`.
fn body_of(response: &str) -> Value {
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}

#[tokio::test]
async fn forwards_plain_http_requests_to_allowed_hosts_without_proxy_headers() {
    let upstream = upstream().await;
    let proxy = start(upstream, json!({ "allowDomains": ["allowed.test"] })).await;

    let response = raw(proxy.port, &get(&format!("http://allowed.test:{upstream}/path?q=1"))).await;
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(response.contains("\r\nx-upstream: yes\r\n"), "{response}");
    let seen = body_of(&response);
    assert_eq!(seen["method"], "GET");
    assert_eq!(seen["url"], "/path?q=1");
    assert_eq!(seen["headers"]["host"], format!("allowed.test:{upstream}"));
    assert_eq!(seen["headers"].get("proxy-connection"), None);
    assert_eq!(seen["headers"].get("proxy-authorization"), None);

    let post = raw(
        proxy.port,
        &format!(
            "POST http://allowed.test:{upstream}/submit HTTP/1.1\r\nHost: allowed.test:{upstream}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"
        ),
    )
    .await;
    assert_eq!(body_of(&post)["method"], "POST");
    assert_eq!(body_of(&post)["url"], "/submit");
    assert_eq!(body_of(&post)["body"], "hello");

    let chunked = raw(
        proxy.port,
        &format!(
            "POST http://allowed.test:{upstream}/chunked HTTP/1.1\r\nHost: allowed.test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nhel\r\n2\r\nlo\r\n0\r\n\r\n"
        ),
    )
    .await;
    assert_eq!(body_of(&chunked)["body"], "hello");

    // busybox nc closes its side as soon as it has sent everything.
    let half_closed = raw_half_closed(proxy.port, &get(&format!("http://allowed.test:{upstream}/half-closed"))).await;
    assert_eq!(body_of(&half_closed)["url"], "/half-closed");
}

#[tokio::test]
async fn keeps_client_connections_alive_across_requests() {
    let upstream = upstream().await;
    let proxy = start(upstream, json!({ "allowDomains": ["allowed.test"] })).await;
    let url = format!("http://allowed.test:{upstream}/");
    let keep_alive = format!("GET {url} HTTP/1.1\r\nHost: allowed.test:{upstream}\r\n\r\n");
    let response = raw(proxy.port, &format!("{keep_alive}{}", get(&url))).await;
    assert_eq!(response.matches("HTTP/1.1 200 OK\r\n").count(), 2, "{response}");
}

#[tokio::test]
async fn refuses_hosts_off_the_allowlist_without_resolving_them() {
    let upstream = upstream().await;
    let proxy = start(upstream, json!({ "allowDomains": ["allowed.test", "*.wild.test"] })).await;
    assert!(raw(proxy.port, &get(&format!("http://a.wild.test:{upstream}/"))).await.starts_with("HTTP/1.1 200 OK"));
    proxy.resolved.lock().unwrap().clear();

    let denied = raw(proxy.port, &get(&format!("http://wild.test:{upstream}/"))).await;
    assert!(denied.starts_with("HTTP/1.1 403 Forbidden\r\n"), "{denied}");
    assert!(denied.contains("\r\nconnection: close\r\n"), "{denied}");
    assert!(denied.contains("\r\ncontent-type: text/plain; charset=utf-8\r\n"), "{denied}");
    assert!(
        denied.ends_with("Blocked by the sandbox egress proxy: wild.test is not on this sandbox's network allowlist\n"),
        "{denied}"
    );
    assert!(proxy.resolved.lock().unwrap().is_empty());
    assert!(raw(proxy.port, &get(&format!("http://127.0.0.1:{upstream}/"))).await.starts_with("HTTP/1.1 403"));
}

#[tokio::test]
async fn allows_ip_addresses_in_allow_cidrs_and_blocks_deny_cidrs_and_by_default_its_own_loopback() {
    let upstream = upstream().await;
    let by_cidr = start(upstream, json!({ "allowCidrs": ["127.0.0.0/8"] })).await;
    assert!(raw(by_cidr.port, &get(&format!("http://127.0.0.1:{upstream}/"))).await.starts_with("HTTP/1.1 200 OK"));
    assert!(raw(by_cidr.port, &get(&format!("http://allowed.test:{upstream}/"))).await.starts_with("HTTP/1.1 200 OK"));

    let denied = start(upstream, json!({ "allowDomains": ["allowed.test"], "denyCidrs": ["127.0.0.1"] })).await;
    let response = raw(denied.port, &get(&format!("http://allowed.test:{upstream}/"))).await;
    assert!(response.contains("allowed.test only resolves to blocked addresses"), "{response}");

    let local = start_with(upstream, json!({ "allowDomains": ["allowed.test"] }), proxy_local_ranges()).await;
    assert!(raw(local.port, &get(&format!("http://allowed.test:{upstream}/"))).await.starts_with("HTTP/1.1 403"));
}

#[tokio::test]
async fn tunnels_connect_to_allowed_hosts_including_bytes_sent_before_the_200() {
    let upstream = upstream().await;
    let proxy = start(upstream, json!({ "allowDomains": ["allowed.test"] })).await;
    let request = format!(
        "CONNECT allowed.test:{upstream} HTTP/1.1\r\nHost: allowed.test:{upstream}\r\n\r\nGET /tunneled HTTP/1.0\r\n\r\n"
    );

    let response = raw(proxy.port, &request).await;
    assert!(response.starts_with("HTTP/1.1 200 Connection Established\r\n"), "{response}");
    let (head, tunneled) = response.split_once("\r\n\r\n").unwrap();
    assert!(!head.contains("content-length") && !head.contains("transfer-encoding"), "{head}");
    assert!(tunneled.starts_with("HTTP/1.0 200 OK\r\n"), "{tunneled}");
    assert_eq!(body_of(tunneled)["url"], "/tunneled");

    // busybox nc closes its side as soon as it has sent everything.
    let half_closed = raw_half_closed(proxy.port, &request).await;
    assert!(half_closed.starts_with("HTTP/1.1 200 Connection Established\r\n"), "{half_closed}");
    assert_eq!(body_of(half_closed.split_once("\r\n\r\n").unwrap().1)["url"], "/tunneled");

    assert!(raw(proxy.port, "CONNECT blocked.test:443 HTTP/1.1\r\n\r\n").await.starts_with("HTTP/1.1 403 Forbidden"));
    assert!(raw(proxy.port, "CONNECT allowed.test HTTP/1.1\r\n\r\n").await.starts_with("HTTP/1.1 400 Bad Request"));
    let unreachable = raw(proxy.port, "CONNECT allowed.test:1 HTTP/1.1\r\n\r\n").await;
    assert!(unreachable.starts_with("HTTP/1.1 502 Bad Gateway"), "{unreachable}");
    assert!(unreachable.contains("Could not reach allowed.test:1: "), "{unreachable}");
    assert!(proxy.logged.lock().unwrap().last().unwrap().starts_with("fail CONNECT allowed.test:1: "));
    assert_eq!(
        proxy.logged.lock().unwrap()[1..3],
        [
            format!("allow CONNECT allowed.test:{upstream} -> 127.0.0.1"),
            "deny CONNECT blocked.test:443: blocked.test is not on this sandbox's network allowlist".to_owned(),
        ]
    );
}

#[tokio::test]
async fn reports_unresolvable_hosts_rejects_non_proxy_requests_and_answers_health_checks() {
    let upstream = upstream().await;
    let proxy = start(upstream, json!({ "allowDomains": ["*"] })).await;
    let missing = raw(proxy.port, &get("http://missing.test/")).await;
    assert!(missing.starts_with("HTTP/1.1 502 Bad Gateway"), "{missing}");
    assert!(missing.contains("could not resolve missing.test"), "{missing}");
    assert_eq!(
        proxy.logged.lock().unwrap().last().unwrap(),
        "deny GET missing.test:80: could not resolve missing.test"
    );

    let https =
        raw(proxy.port, "GET https://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n").await;
    assert!(https.starts_with("HTTP/1.1 400 Bad Request"), "{https}");
    assert!(https.contains("Only http:// URLs can be forwarded; tunnel https: with CONNECT"), "{https}");
    assert!(
        raw(proxy.port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.starts_with("HTTP/1.1 400")
    );
    assert!(raw(proxy.port, "garbage\r\n\r\n").await.starts_with("HTTP/1.1 400"));

    let health = raw(proxy.port, "GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;
    assert!(health.starts_with("HTTP/1.1 200 OK"), "{health}");
    assert!(health.ends_with("\r\n\r\nok\n"), "{health}");
    let port = proxy.port;
    assert!(tokio::task::spawn_blocking(move || health::check(port, Duration::from_secs(2))).await.unwrap());
}

#[tokio::test]
async fn refuses_upgrades_over_plain_http() {
    let upstream = upstream().await;
    let proxy = start(upstream, json!({ "allowDomains": ["allowed.test"] })).await;
    let response = raw(
        proxy.port,
        &format!(
            "GET http://allowed.test:{upstream}/ws HTTP/1.1\r\nHost: allowed.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
        ),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 501 Not Implemented"), "{response}");
    assert!(response.contains("use CONNECT"), "{response}");
}

#[tokio::test]
async fn forwards_published_ports_to_the_sandbox_whatever_the_policy() {
    let upstream = upstream().await;
    let proxy = start(upstream, json!({})).await;
    let response = raw(proxy.forward_port, "GET /inbound HTTP/1.0\r\n\r\n").await;
    assert!(response.starts_with("HTTP/1.0 200 OK"), "{response}");
    assert_eq!(body_of(&response)["url"], "/inbound");
}

#[tokio::test]
async fn health_check_fails_without_a_proxy() {
    let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap().local_addr().unwrap().port();
    assert!(!tokio::task::spawn_blocking(move || health::check(closed, Duration::from_secs(2))).await.unwrap());

    // Something that is not the proxy, which accepts and says nothing.
    let silent = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = silent.local_addr().unwrap().port();
    let started = std::time::Instant::now();
    assert!(!tokio::task::spawn_blocking(move || health::check(port, Duration::from_millis(300))).await.unwrap());
    assert!(started.elapsed() < Duration::from_secs(2));
    drop(silent);
}
