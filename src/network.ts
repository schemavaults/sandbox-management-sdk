import { SandboxError } from "./errors.js";
import type { SandboxProvider } from "./provider.js";
import type { SandboxNetworkAllowlist, SandboxNetworkPolicy, SandboxNetworkPolicyKind } from "./types.js";

const ALLOWLIST_FIELDS = ["allowDomains", "allowCidrs", "denyCidrs"] as const satisfies readonly (keyof SandboxNetworkAllowlist)[];
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^(?:\\*\\.)?(?:${DOMAIN_LABEL}\\.)*${DOMAIN_LABEL}$`, "i");
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;
const PREFIX = /^(?:0|[1-9]\d{0,2})$/;

/** `"allow-all"` for an unset policy, otherwise the policy's kind. */
export function networkPolicyKind(policy: SandboxNetworkPolicy | undefined): SandboxNetworkPolicyKind {
  return policy === undefined || policy === "allow-all" ? "allow-all" : policy === "deny-all" ? "deny-all" : "allowlist";
}

/** Throws a `SandboxError` unless `provider` declares that it enforces `policy`. */
export function assertNetworkPolicySupported(
  provider: Pick<SandboxProvider, "name" | "networkPolicies">,
  policy: SandboxNetworkPolicy | undefined,
): void {
  const kind = networkPolicyKind(policy);
  if (kind === "allow-all" || provider.networkPolicies?.includes(kind)) return;
  const supported = provider.networkPolicies?.length
    ? `it enforces only ${provider.networkPolicies.map((name) => `"${name}"`).join(", ")}`
    : "it enforces no network restrictions";
  throw new SandboxError(
    `Provider "${provider.name}" cannot enforce ${kind === "allowlist" ? "a network allowlist" : 'a "deny-all" network policy'} (spec.network): ${supported}`,
  );
}

/** Throws a `SandboxError` describing the first problem found in `policy`. */
export function validateNetworkPolicy(policy: unknown): void {
  if (policy === undefined || policy === "allow-all" || policy === "deny-all") return;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new SandboxError(`network must be "allow-all", "deny-all" or { allowDomains?, allowCidrs?, denyCidrs? }`);
  }
  const allowlist = policy as Record<string, unknown>;
  for (const key of Object.keys(allowlist)) {
    if (!(ALLOWLIST_FIELDS as readonly string[]).includes(key)) {
      throw new SandboxError(`Unknown field network.${key}; expected allowDomains, allowCidrs or denyCidrs`);
    }
  }
  for (const domain of stringList(allowlist, "allowDomains")) {
    if (parseCidr(domain)) {
      throw new SandboxError(`network.allowDomains has the IP address "${domain}"; put it in allowCidrs`);
    }
    if (domain !== "*" && !(domain.length <= 253 && DOMAIN.test(domain))) {
      throw new SandboxError(
        `Invalid domain "${domain}" in network.allowDomains; expected a host name such as "github.com" or "*.github.com"`,
      );
    }
  }
  for (const field of ["allowCidrs", "denyCidrs"] as const) {
    for (const cidr of stringList(allowlist, field)) {
      if (!parseCidr(cidr)) {
        throw new SandboxError(
          `Invalid IP address or CIDR "${cidr}" in network.${field}; expected e.g. "203.0.113.10" or "10.0.0.0/8"`,
        );
      }
    }
  }
}

/** Adds the single-host prefix (`/32` or `/128`) to a bare IP address. Expects a valid value. */
export function normalizeCidr(value: string): string {
  if (value.includes("/")) return value;
  return `${value}/${parseCidr(value)?.version === 6 ? 128 : 32}`;
}

/** Parses an IPv4 / IPv6 address with an optional `/prefix`, or returns `null`. */
export function parseCidr(value: string): { version: 4 | 6; prefix: number } | null {
  const [address = "", prefix, ...extra] = value.split("/");
  if (extra.length > 0) return null;
  const version = isIPv4(address) ? 4 : isIPv6(address) ? 6 : null;
  if (version === null) return null;
  const maxPrefix = version === 4 ? 32 : 128;
  if (prefix === undefined) return { version, prefix: maxPrefix };
  if (!PREFIX.test(prefix) || Number(prefix) > maxPrefix) return null;
  return { version, prefix: Number(prefix) };
}

function stringList(allowlist: Record<string, unknown>, field: string): string[] {
  const value = allowlist[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new SandboxError(`network.${field} must be an array of strings`);
  }
  return value;
}

function isIPv4(address: string): boolean {
  const octets = address.split(".");
  return octets.length === 4 && octets.every((octet) => IPV4_OCTET.test(octet) && Number(octet) <= 255);
}

function isIPv6(address: string): boolean {
  let rest = address;
  let groups = 8;
  const last = rest.slice(rest.lastIndexOf(":") + 1);
  if (last.includes(".")) {
    // An embedded IPv4 address, e.g. `::ffff:192.0.2.1`, stands for the last two groups.
    if (!isIPv4(last) || last === rest) return false;
    rest = rest.slice(0, -last.length);
    if (!rest.endsWith("::")) rest = rest.slice(0, -1);
    groups = 6;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return false;
  const split = (part: string) => (part === "" ? [] : part.split(":"));
  const parts = halves.flatMap(split);
  if (!parts.every((group) => IPV6_GROUP.test(group))) return false;
  return halves.length === 2 ? parts.length < groups : parts.length === groups;
}
