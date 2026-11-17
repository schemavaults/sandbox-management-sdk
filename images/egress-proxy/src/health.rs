//! `--health`: checks a running proxy, for the image's `HEALTHCHECK`.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// Whether the proxy on `port` answers `GET /healthz` with a 2xx status within `timeout`.
pub fn check(port: u16, timeout: Duration) -> bool {
    probe(port, Instant::now() + timeout).unwrap_or(false)
}

fn probe(port: u16, deadline: Instant) -> io::Result<bool> {
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
    };
    let mut stream = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), remaining()?)?;
    stream.set_write_timeout(Some(remaining()?))?;
    stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
    let mut head = Vec::new();
    let mut buffer = [0; 256];
    while !head.contains(&b'\n') && head.len() < 1024 {
        stream.set_read_timeout(Some(remaining()?))?;
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&buffer[..read]);
    }
    let head = String::from_utf8_lossy(&head);
    let mut status_line = head.lines().next().unwrap_or_default().split(' ');
    let http = status_line.next().is_some_and(|version| version.starts_with("HTTP/1."));
    let status = status_line.next().and_then(|status| status.parse::<u16>().ok());
    Ok(http && status.is_some_and(|status| (200..300).contains(&status)))
}
