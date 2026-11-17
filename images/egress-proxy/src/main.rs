//! Entry point of the egress proxy image. Reads its config from
//! `SANDBOX_EGRESS_PROXY_CONFIG`. `--health` checks a running proxy instead,
//! for the image's `HEALTHCHECK`.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use sandbox_egress_proxy::config::{CONFIG_ENV, Config};
use sandbox_egress_proxy::{health, log, proxy};
use tokio::signal::unix::{SignalKind, signal};

fn main() -> ExitCode {
    let config = match Config::parse(std::env::var(CONFIG_ENV).ok().as_deref()) {
        Ok(config) => config,
        Err(error) => return fail(&error),
    };
    if std::env::args().skip(1).any(|arg| arg == "--health") {
        return if health::check(config.port, Duration::from_secs(2)) { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    // One thread is plenty for a single sandbox's traffic; name lookups run on
    // Tokio's blocking threads.
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return fail(&error.to_string()),
    };
    let code = runtime.block_on(run(config));
    // Exit without waiting for connections or lookups still in flight.
    runtime.shutdown_background();
    code
}

async fn run(config: Config) -> ExitCode {
    let options = proxy::Options { log: Arc::new(log::stdout), ..proxy::Options::default() };
    let running = match proxy::start(&config, options).await {
        Ok(running) => running,
        Err(error) => return fail(&error.to_string()),
    };
    let forwards: String = config
        .forwards
        .iter()
        .map(|forward| format!(", forwarding :{} to {}:{}", forward.port, forward.host, forward.target_port))
        .collect();
    log::stdout(&format!("egress proxy listening on :{}{forwards}", running.port));
    match shutdown_signal().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(&error.to_string()),
    }
}

/// Waits for `SIGTERM` (`docker stop`) or `SIGINT`.
async fn shutdown_signal() -> std::io::Result<()> {
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
    Ok(())
}

fn fail(error: &str) -> ExitCode {
    eprintln!("egress proxy: {error}");
    ExitCode::FAILURE
}
