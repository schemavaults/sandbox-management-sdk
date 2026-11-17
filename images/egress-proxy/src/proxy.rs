//! The egress proxy server. The sandbox reaches the internet only through it,
//! as an HTTP proxy (`HTTP_PROXY` / `HTTPS_PROXY`): plain `http://` requests
//! are forwarded and everything else is tunneled with `CONNECT`, so TLS stays
//! end to end. It also forwards the sandbox's published ports.

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Bytes, Incoming};
use hyper::ext::ReasonPhrase;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::http::uri::PathAndQuery;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

use crate::cidr::{Cidr, in_ranges};
use crate::config::{Config, Forward};
use crate::policy::{Decision, EgressPolicy, normalize_host, proxy_local_ranges};

/// Resolves a host name to its addresses.
pub type Resolve = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>> + Send + Sync>;

/// Writes a log line.
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Options {
    /// Listen address. Default `0.0.0.0`.
    pub host: IpAddr,
    /// Default: the system resolver.
    pub resolve: Resolve,
    /// Destinations always refused. Default `PROXY_LOCAL_CIDRS` (the proxy's own loopback).
    pub always_deny: Vec<Cidr>,
    /// Gets a line for every connection allowed or refused. Default: none.
    pub log: Log,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            resolve: system_resolver(),
            always_deny: proxy_local_ranges(),
            log: Arc::new(|_| {}),
        }
    }
}

/// Resolves names with the system's `getaddrinfo`, as other programs in the container would.
pub fn system_resolver() -> Resolve {
    Arc::new(|name| {
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((name.as_str(), 0)).await?;
            Ok(addresses.map(|address| address.ip()).collect())
        })
    })
}

pub struct RunningProxy {
    /// Port the HTTP proxy listens on (differs from the config when it asked for port 0).
    pub port: u16,
    /// Listening port of each forward, in config order.
    pub forward_ports: Vec<u16>,
}

const LOOPBACK_CLIENTS: [&str; 2] = ["127.0.0.0/8", "::1/128"];
const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
/// How long to wait before accepting again after `accept` fails, e.g. when out of file descriptors.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);

type Body = BoxBody<Bytes, hyper::Error>;

/// Starts the proxy and its forwards on the current Tokio runtime. They
/// run until the runtime shuts down.
pub async fn start(config: &Config, options: Options) -> io::Result<RunningProxy> {
    let mut clients = config.clients.clone();
    clients.extend(LOOPBACK_CLIENTS.iter().filter_map(|cidr| Cidr::parse(cidr)));
    let proxy = Arc::new(Proxy {
        policy: EgressPolicy::new(&config.policy, &options.always_deny),
        clients,
        resolve: options.resolve,
        log: options.log,
    });

    let listener = listen(options.host, config.port).await?;
    let port = listener.local_addr()?.port();
    let mut forwards = Vec::with_capacity(config.forwards.len());
    let mut forward_ports = Vec::with_capacity(config.forwards.len());
    for forward in &config.forwards {
        let listener = listen(options.host, forward.port).await?;
        forward_ports.push(listener.local_addr()?.port());
        forwards.push((listener, Arc::new(forward.clone())));
    }

    tokio::spawn(proxy.serve(listener));
    for (listener, forward) in forwards {
        tokio::spawn(serve_forward(listener, forward));
    }
    Ok(RunningProxy { port, forward_ports })
}

struct Proxy {
    policy: EgressPolicy,
    clients: Vec<Cidr>,
    resolve: Resolve,
    log: Log,
}

impl Proxy {
    async fn serve(self: Arc<Self>, listener: TcpListener) {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                continue;
            };
            if !in_ranges(peer.ip(), &self.clients) {
                (self.log)(&format!("refuse client {}", peer.ip()));
                continue;
            }
            let _ = stream.set_nodelay(true);
            let proxy = self.clone();
            tokio::spawn(async move {
                let service = service_fn(move |request| {
                    let proxy = proxy.clone();
                    async move { Ok::<_, Infallible>(proxy.handle(request).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    // A client may send its request and close its side, as busybox nc
                    // does: still answer it.
                    .half_close(true)
                    // For the header read timeout, which also ends idle keep-alive connections.
                    .timer(TokioTimer::new())
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    }

    async fn handle(&self, request: Request<Incoming>) -> Response<Body> {
        if request.method() == Method::CONNECT {
            self.tunnel(request).await
        } else if is_upgrade(request.headers()) {
            reply(StatusCode::NOT_IMPLEMENTED, "Upgrades over plain HTTP are not supported; use CONNECT")
        } else {
            self.forward(request).await
        }
    }

    /// Decides on a connection to `target:port`: the address to connect to, or
    /// why not. `method` is for the log (`CONNECT`, `GET`, ...).
    async fn route(&self, method: &str, target: &str, port: u16) -> Result<IpAddr, Refusal> {
        let name = normalize_host(target);
        let addresses = match name.parse::<IpAddr>() {
            Ok(address) => vec![address],
            Err(_) if self.policy.needs_resolution(&name) => match (self.resolve)(name.clone()).await {
                Ok(addresses) => addresses,
                Err(_) => {
                    let reason = format!("could not resolve {name}");
                    (self.log)(&format!("deny {method} {name}:{port}: {reason}"));
                    return Err(Refusal { status: StatusCode::BAD_GATEWAY, reason });
                }
            },
            Err(_) => Vec::new(),
        };
        match self.policy.decide(&name, &addresses) {
            Decision::Allow(address) => {
                (self.log)(&format!("allow {method} {name}:{port} -> {address}"));
                Ok(address)
            }
            Decision::Deny(reason) => {
                (self.log)(&format!("deny {method} {name}:{port}: {reason}"));
                Err(Refusal { status: StatusCode::FORBIDDEN, reason })
            }
        }
    }

    /// Logs and answers a connection that was allowed but failed.
    fn unreachable(&self, method: &str, target: &str, error: &dyn std::fmt::Display) -> Response<Body> {
        (self.log)(&format!("fail {method} {target}: {error}"));
        reply(StatusCode::BAD_GATEWAY, format!("Could not reach {target}: {error}"))
    }

    /// Forwards a plain `http://` request (an absolute URL) to its host.
    async fn forward(&self, request: Request<Incoming>) -> Response<Body> {
        let uri = request.uri();
        match uri.scheme_str() {
            Some("http") => {}
            Some(scheme) => {
                return reply(
                    StatusCode::BAD_REQUEST,
                    format!("Only http:// URLs can be forwarded; tunnel {scheme}: with CONNECT"),
                );
            }
            None => return reply_to_origin_form(uri),
        }
        let Some(host) = uri.host() else {
            return reply(StatusCode::BAD_REQUEST, format!("Invalid request target {uri}"));
        };
        let port = uri.port_u16().unwrap_or(80);
        // The URL's host and port as written, without any user info.
        let authority = match uri.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        let method = request.method().clone();
        let address = match self.route(method.as_str(), host, port).await {
            Ok(address) => address,
            Err(refusal) => return refusal.into_response(),
        };
        let unreachable = |error: &dyn std::fmt::Display| self.unreachable(method.as_str(), &authority, error);

        let upstream = match TcpStream::connect((address, port)).await {
            Ok(upstream) => upstream,
            Err(error) => return unreachable(&error),
        };
        let _ = upstream.set_nodelay(true);
        let (mut sender, connection) =
            match hyper::client::conn::http1::handshake(TokioIo::new(RequestFirst::new(upstream))).await {
                Ok(handshake) => handshake,
                Err(error) => return unreachable(&error),
            };
        tokio::spawn(connection);

        let (parts, body) = request.into_parts();
        let mut upstream_request = Request::new(body);
        *upstream_request.method_mut() = parts.method;
        *upstream_request.uri_mut() =
            Uri::from(parts.uri.path_and_query().cloned().unwrap_or_else(|| PathAndQuery::from_static("/")));
        let headers = upstream_request.headers_mut();
        *headers = without_hop_by_hop(&parts.headers);
        match HeaderValue::from_str(&authority) {
            Ok(value) => headers.insert(header::HOST, value),
            Err(_) => return reply(StatusCode::BAD_REQUEST, format!("Invalid request target {}", parts.uri)),
        };
        // One upstream connection per request, as the request's own client would make it.
        headers.insert(header::CONNECTION, HeaderValue::from_static("close"));

        let upstream_response = match sender.send_request(upstream_request).await {
            Ok(response) => response,
            Err(error) => return unreachable(&error),
        };
        let (upstream, body) = upstream_response.into_parts();
        let mut response = Response::new(body.boxed());
        *response.status_mut() = upstream.status;
        *response.headers_mut() = without_hop_by_hop(&upstream.headers);
        if let Some(reason) = upstream.extensions.get::<ReasonPhrase>() {
            response.extensions_mut().insert(reason.clone());
        }
        response
    }

    /// Answers `CONNECT host:port` and, if it is allowed, splices the client to the host.
    async fn tunnel(&self, mut request: Request<Incoming>) -> Response<Body> {
        let target = request.uri().to_string();
        let Some((host, port)) = parse_authority(&target) else {
            return reply(StatusCode::BAD_REQUEST, format!("Invalid CONNECT target {target}"));
        };
        let address = match self.route("CONNECT", host, port).await {
            Ok(address) => address,
            Err(refusal) => return refusal.into_response(),
        };
        let mut upstream = match TcpStream::connect((address, port)).await {
            Ok(upstream) => upstream,
            Err(error) => return self.unreachable("CONNECT", &target, &error),
        };
        let _ = upstream.set_nodelay(true);
        // Hands over the connection once the 200 is written, along with any
        // bytes the client sent after the CONNECT request.
        let upgrade = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            if let Ok(client) = upgrade.await {
                let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut upstream).await;
            }
        });
        let mut response = Response::new(empty());
        response.extensions_mut().insert(ReasonPhrase::from_static(b"Connection Established"));
        response
    }
}

/// An upstream connection that has nothing to read until the request starts
/// going out. Some servers answer as soon as they accept a connection
/// (`printf '...' | nc -l` does), and hyper refuses bytes that arrive on an
/// idle connection, before it has written a request; this hands them to hyper
/// as the response.
struct RequestFirst {
    stream: TcpStream,
    written: bool,
    reader: Option<Waker>,
}

impl RequestFirst {
    fn new(stream: TcpStream) -> Self {
        Self { stream, written: false, reader: None }
    }

    fn wrote(&mut self, result: &Poll<io::Result<usize>>) {
        if matches!(result, Poll::Ready(Ok(written)) if *written > 0) && !self.written {
            self.written = true;
            if let Some(reader) = self.reader.take() {
                reader.wake();
            }
        }
    }
}

impl AsyncRead for RequestFirst {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.written {
            this.reader = Some(cx.waker().clone());
            return Poll::Pending;
        }
        Pin::new(&mut this.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for RequestFirst {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.stream).poll_write(cx, buf);
        this.wrote(&result);
        result
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.stream).poll_write_vectored(cx, bufs);
        this.wrote(&result);
        result
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

/// Forwards every connection to `listener` to the sandbox, whatever the policy.
async fn serve_forward(listener: TcpListener, forward: Arc<Forward>) {
    loop {
        let Ok((mut client, _)) = listener.accept().await else {
            tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
            continue;
        };
        let forward = forward.clone();
        tokio::spawn(async move {
            // Resolved on every connection: the sandbox's address can change when it restarts.
            let Ok(mut upstream) = TcpStream::connect((forward.host.as_str(), forward.target_port)).await else {
                return;
            };
            let _ = client.set_nodelay(true);
            let _ = upstream.set_nodelay(true);
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        });
    }
}

async fn listen(host: IpAddr, port: u16) -> io::Result<TcpListener> {
    TcpListener::bind((host, port))
        .await
        .map_err(|error| io::Error::new(error.kind(), format!("could not listen on {host}:{port}: {error}")))
}

/// Answers a request for one of the proxy's own paths (`/healthz`), or one that is not a proxy request.
fn reply_to_origin_form(uri: &Uri) -> Response<Body> {
    let target = uri.path_and_query().map_or("", PathAndQuery::as_str);
    if target == "/healthz" {
        reply(StatusCode::OK, "ok")
    } else if target.starts_with('/') {
        reply(
            StatusCode::BAD_REQUEST,
            "This is the sandbox egress proxy: send proxy requests (absolute URLs or CONNECT)",
        )
    } else {
        reply(StatusCode::BAD_REQUEST, format!("Invalid request target {uri}"))
    }
}

/// Splits a `CONNECT` target into host and port: `host:port` or `[ipv6]:port`.
fn parse_authority(authority: &str) -> Option<(&str, u16)> {
    let (host, port) = authority.rsplit_once(':')?;
    let host_valid = match host.strip_prefix('[') {
        Some(inner) => inner.strip_suffix(']').is_some_and(|inner| !inner.is_empty() && !inner.contains(']')),
        None => !host.is_empty() && !host.contains([':', '[', ']']),
    };
    let port_valid = (1..=5).contains(&port.len()) && port.bytes().all(|byte| byte.is_ascii_digit());
    let port = port.parse().ok().filter(|&port| port != 0 && port_valid)?;
    host_valid.then_some((host, port))
}

/// Whether the request asks to switch protocols (WebSocket and the like).
fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(header::UPGRADE) && connection_options(headers).any(|option| option == "upgrade")
}

/// The header names listed in `Connection`, lowercased.
fn connection_options(headers: &HeaderMap) -> impl Iterator<Item = String> + '_ {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|option| option.trim().to_ascii_lowercase())
}

/// `headers` without the ones that only apply to a single connection.
fn without_hop_by_hop(headers: &HeaderMap) -> HeaderMap {
    let listed: Vec<String> = connection_options(headers).collect();
    let mut result = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        let name_str = name.as_str();
        if !HOP_BY_HOP.contains(&name_str) && !listed.iter().any(|option| option == name_str) {
            result.append(name.clone(), value.clone());
        }
    }
    result
}

/// Why the proxy refuses a connection: off the allowlist (403), or the host could not be resolved (502).
struct Refusal {
    status: StatusCode,
    reason: String,
}

impl Refusal {
    fn into_response(self) -> Response<Body> {
        reply(self.status, format!("Blocked by the sandbox egress proxy: {}", self.reason))
    }
}

/// A plain text response that ends the connection.
fn reply(status: StatusCode, body: impl Into<String>) -> Response<Body> {
    let text = format!("{}\n", body.into());
    let mut response = Response::new(Full::new(Bytes::from(text)).map_err(|never| match never {}).boxed());
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

fn empty() -> Body {
    Empty::new().map_err(|never| match never {}).boxed()
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncWriteExt;

    use super::*;

    #[tokio::test]
    async fn reads_a_response_sent_before_the_request() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let upstream = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        // As `printf '...' | nc -l` does: the response goes out before the request comes in.
        server.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nearly").await.unwrap();
        upstream.readable().await.unwrap();

        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(RequestFirst::new(upstream))).await.unwrap();
        tokio::spawn(connection);
        let response = sender.send_request(Request::new(Empty::<Bytes>::new())).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), "early");
    }

    #[test]
    fn parses_connect_targets() {
        assert_eq!(parse_authority("github.com:443"), Some(("github.com", 443)));
        assert_eq!(parse_authority("[2001:db8::1]:8443"), Some(("[2001:db8::1]", 8443)));
        assert_eq!(parse_authority("10.0.0.1:00080"), Some(("10.0.0.1", 80)));
        for invalid in [
            "github.com",
            "github.com:",
            ":443",
            "github.com:0",
            "github.com:65536",
            "github.com:123456",
            "2001:db8::1:443",
            "[]:443",
            "[a]b]:443",
            "github.com:+443",
            "github.com:44 3",
            "/path",
        ] {
            assert_eq!(parse_authority(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn drops_hop_by_hop_headers() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("connection", "keep-alive, X-Secret"),
            ("keep-alive", "timeout=5"),
            ("proxy-authorization", "Basic eDp5"),
            ("proxy-connection", "keep-alive"),
            ("transfer-encoding", "chunked"),
            ("x-secret", "1"),
            ("set-cookie", "a=1"),
            ("set-cookie", "b=2"),
            ("content-type", "text/plain"),
        ] {
            headers.append(header::HeaderName::from_static(name), HeaderValue::from_static(value));
        }
        let kept = without_hop_by_hop(&headers);
        let names: Vec<&str> = kept.keys().map(|name| name.as_str()).collect();
        assert_eq!(names, ["set-cookie", "content-type"]);
        assert_eq!(kept.get_all("set-cookie").iter().count(), 2);
    }

    #[test]
    fn recognizes_upgrade_requests() {
        let mut headers = HeaderMap::new();
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        assert!(!is_upgrade(&headers));
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
        assert!(is_upgrade(&headers));
    }
}
