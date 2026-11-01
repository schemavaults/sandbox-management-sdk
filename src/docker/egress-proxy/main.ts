/**
 * Entry point of the egress proxy image (`images/egress-proxy`). Reads its
 * config from `SANDBOX_EGRESS_PROXY_CONFIG`. `--health` checks a running
 * proxy instead, for the image's HEALTHCHECK.
 */
import { EGRESS_PROXY_CONFIG_ENV, parseEgressProxyConfig } from "./config.js";
import { startEgressProxy } from "./server.js";

const config = parseEgressProxyConfig(process.env[EGRESS_PROXY_CONFIG_ENV]);

if (process.argv.includes("--health")) {
  const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) }).catch(
    () => null,
  );
  process.exit(response?.ok ? 0 : 1);
}

const proxy = await startEgressProxy(config, {
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
console.log(
  `egress proxy listening on :${proxy.port}` +
    config.forwards.map((forward) => `, forwarding :${forward.port} to ${forward.host}:${forward.targetPort}`).join(""),
);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
