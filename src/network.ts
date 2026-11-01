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
  return `${value}/${parseIp(value)?.version === 6 ? 128 : 32}`;
}

/** An IPv4 or IPv6 address as a number (32 or 128 bits). */
export interface IpAddress {
  version: 4 | 6;
  value: bigint;
}

/** An IP range; `network` holds the address's first `prefix` bits. */
export interface CidrRange {
  version: 4 | 6;
  prefix: number;
  network: bigint;
}

/** Parses an IPv4 / IPv6 address with an optional `/prefix`, or returns `null`. */
export function parseCidr(value: string): CidrRange | null {
  const [address = "", prefix, ...extra] = value.split("/");
  if (extra.length > 0) return null;
  const ip = parseIp(address);
  if (ip === null) return null;
  const bits = ip.version === 4 ? 32 : 128;
  if (prefix !== undefined && !(PREFIX.test(prefix) && Number(prefix) <= bits)) return null;
  const length = prefix === undefined ? bits : Number(prefix);
  return { version: ip.version, prefix: length, network: ip.value >> BigInt(bits - length) };
}

/** Whether `range` contains `ip`. Addresses of the other IP version are never contained. */
export function cidrContains(range: CidrRange, ip: IpAddress): boolean {
  const bits = range.version === 4 ? 32 : 128;
  return range.version === ip.version && ip.value >> BigInt(bits - range.prefix) === range.network;
}

/** Parses a plain IPv4 or IPv6 address (no zone ID), or returns `null`. */
export function parseIp(address: string): IpAddress | null {
  const v4 = parseIPv4(address);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIPv6(address);
  return v6 === null ? null : { version: 6, value: v6 };
}

function stringList(allowlist: Record<string, unknown>, field: string): string[] {
  const value = allowlist[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new SandboxError(`network.${field} must be an array of strings`);
  }
  return value;
}

function parseIPv4(address: string): bigint | null {
  const octets = address.split(".");
  if (octets.length !== 4 || !octets.every((octet) => IPV4_OCTET.test(octet) && Number(octet) <= 255)) return null;
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function parseIPv6(address: string): bigint | null {
  let rest = address;
  let embedded: bigint[] = [];
  const last = rest.slice(rest.lastIndexOf(":") + 1);
  if (last.includes(".")) {
    // An embedded IPv4 address, e.g. `::ffff:192.0.2.1`, stands for the last two groups.
    const v4 = parseIPv4(last);
    if (v4 === null || last === rest) return null;
    rest = rest.slice(0, -last.length);
    if (!rest.endsWith("::")) rest = rest.slice(0, -1);
    embedded = [v4 >> 16n, v4 & 0xffffn];
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const split = (part: string | undefined) => (part ? part.split(":") : []);
  const head = split(halves[0]);
  const tail = split(halves[1]);
  if (![...head, ...tail].every((group) => IPV6_GROUP.test(group))) return null;
  const groups = 8 - embedded.length;
  const count = head.length + tail.length;
  if (halves.length === 2 ? count >= groups : count !== groups) return null;
  const zeros: bigint[] = Array.from({ length: groups - count }, () => 0n);
  const values = [...head.map((group) => BigInt(`0x${group}`)), ...zeros, ...tail.map((group) => BigInt(`0x${group}`)), ...embedded];
  return values.reduce((value, group) => (value << 16n) | group, 0n);
}
