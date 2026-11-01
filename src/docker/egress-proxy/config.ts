import { validateNetworkPolicy } from "../../network.js";
import type { SandboxNetworkAllowlist } from "../../types.js";
import { ranges } from "./policy.js";

/** Environment variable the proxy image reads its `EgressProxyConfig` from, as JSON. */
export const EGRESS_PROXY_CONFIG_ENV = "SANDBOX_EGRESS_PROXY_CONFIG";

/** A TCP port the proxy forwards to the sandbox, so it can be published on the host. */
export interface EgressProxyForward {
  port: number;
  host: string;
  targetPort: number;
}

export interface EgressProxyConfig {
  /** Port of the HTTP proxy (plain requests and `CONNECT`). */
  port: number;
  policy: SandboxNetworkAllowlist;
  /** CIDRs of the clients that may use the HTTP proxy. Loopback always may. */
  clients: string[];
  forwards: EgressProxyForward[];
}

/** Parses and checks `SANDBOX_EGRESS_PROXY_CONFIG`. Throws a descriptive `Error`. */
export function parseEgressProxyConfig(raw: string | undefined): EgressProxyConfig {
  if (!raw) throw new Error(`${EGRESS_PROXY_CONFIG_ENV} is not set`);
  const config = JSON.parse(raw) as Partial<EgressProxyConfig>;
  if (!isPort(config.port)) throw new Error("config.port must be a port number");
  if (typeof config.policy !== "object" || config.policy === null) throw new Error("config.policy must be an allowlist");
  validateNetworkPolicy(config.policy);
  if (!Array.isArray(config.clients)) throw new Error("config.clients must be an array of CIDRs");
  ranges(config.clients);
  if (!Array.isArray(config.forwards)) throw new Error("config.forwards must be an array");
  for (const forward of config.forwards) {
    if (!isPort(forward?.port) || !isPort(forward.targetPort) || typeof forward.host !== "string") {
      throw new Error("config.forwards entries must be { port, host, targetPort }");
    }
  }
  return config as EgressProxyConfig;
}

export function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}
