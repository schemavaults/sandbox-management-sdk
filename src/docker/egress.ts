import { SandboxError } from "../errors.js";
import { assertNetworkPolicySupported, networkPolicyKind } from "../network.js";
import type { SandboxProvider } from "../provider.js";
import type { SandboxNetworkAllowlist, SandboxSpec } from "../types.js";
import type { EgressProxyConfig } from "./egress-proxy/config.js";

/**
 * The egress proxy image published with this SDK version (built from
 * `images/egress-proxy`). Keep the tag in step with `package.json`.
 */
export const DOCKER_EGRESS_PROXY_IMAGE = "ghcr.io/schemavaults/sandbox-egress-proxy:0.1.0";

/** Label on a sandbox's egress proxy container and internal network; the value is the sandbox ID. */
export const DOCKER_EGRESS_PROXY_LABEL = "dev.schemavaults.sandbox.egress-proxy";

/** Host names of the proxy and the sandbox on the sandbox's internal network. */
export const EGRESS_PROXY_ALIAS = "egress-proxy";
export const SANDBOX_ALIAS = "sandbox";

const DEFAULT_PROXY_PORT = 3128;
const UNUSABLE_OUTSIDE_NETWORKS = new Set(["none", "host"]);

/**
 * How a sandbox container is networked:
 *
 * - `direct`: attached to `networkMode` (`undefined` is Docker's default bridge,
 *   `"none"` is no network at all).
 * - `proxy`: attached only to an internal network of its own, with no route
 *   out. Its egress proxy shares that network and `outsideNetwork`; it
 *   enforces `policy` and forwards the sandbox's ports.
 */
export type DockerNetworkPlan =
  | { mode: "direct"; networkMode: string | undefined }
  | { mode: "proxy"; policy: SandboxNetworkAllowlist; outsideNetwork: string; proxyPort: number };

/** Whether the sandbox runs behind an egress proxy: an allowlist, or `"deny-all"` with published ports. */
export function usesEgressProxy(spec: SandboxSpec): boolean {
  const kind = networkPolicyKind(spec.network);
  return kind === "allowlist" || (kind === "deny-all" && (spec.ports?.length ?? 0) > 0);
}

/** Works out the networking for `spec`, or throws a `SandboxError` if Docker cannot honor it. */
export function dockerNetworkPlan(
  provider: Pick<SandboxProvider, "name" | "networkPolicies">,
  spec: SandboxSpec,
  network: string | undefined,
): DockerNetworkPlan {
  // Also checked by the manager; repeated for callers that use the provider directly.
  assertNetworkPolicySupported(provider, spec.network);
  const kind = networkPolicyKind(spec.network);
  if (kind === "allow-all") return { mode: "direct", networkMode: network };
  if (!usesEgressProxy(spec)) {
    if (network !== undefined && network !== "none") {
      throw new SandboxError(`spec.network "deny-all" conflicts with spec.providerOptions.docker.network "${network}"`);
    }
    return { mode: "direct", networkMode: "none" };
  }
  const outsideNetwork = network ?? "bridge";
  if (UNUSABLE_OUTSIDE_NETWORKS.has(outsideNetwork) || outsideNetwork.startsWith("container:")) {
    throw new SandboxError(
      `spec.providerOptions.docker.network "${outsideNetwork}" cannot carry the egress proxy's traffic; use a bridge network or leave it unset`,
    );
  }
  const policy = kind === "allowlist" ? (spec.network as SandboxNetworkAllowlist) : {};
  const ports = new Set(spec.ports ?? []);
  let proxyPort = DEFAULT_PROXY_PORT;
  while (ports.has(proxyPort)) proxyPort++;
  return { mode: "proxy", policy, outsideNetwork, proxyPort };
}

/** The proxy's config: the policy, who may use it (the internal network), and the ports to forward. */
export function egressProxyConfig(plan: DockerNetworkPlan & { mode: "proxy" }, spec: SandboxSpec, clients: string[]): EgressProxyConfig {
  return {
    port: plan.proxyPort,
    policy: plan.policy,
    clients,
    forwards: (spec.ports ?? []).map((port) => ({ port, host: SANDBOX_ALIAS, targetPort: port })),
  };
}

/** Points HTTP clients in the sandbox at its egress proxy. `spec.env` can override any of these. */
export function egressProxyEnv(proxyPort: number): Record<string, string> {
  const url = `http://${EGRESS_PROXY_ALIAS}:${proxyPort}`;
  const local = "localhost,127.0.0.1,::1";
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: local,
    no_proxy: local,
    // Node.js (24+) only honors the variables above with this set.
    NODE_USE_ENV_PROXY: "1",
  };
}
