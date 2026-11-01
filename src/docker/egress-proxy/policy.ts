import { cidrContains, parseCidr, parseIp } from "../../network.js";
import type { CidrRange, IpAddress } from "../../network.js";
import type { SandboxNetworkAllowlist } from "../../types.js";

/** Destinations the proxy never connects to: its own loopback and the unspecified address. */
export const PROXY_LOCAL_CIDRS = ["127.0.0.0/8", "0.0.0.0/8", "::1/128", "::/128"];

export type EgressDecision =
  | { allowed: true; address: string }
  | { allowed: false; reason: string };

/**
 * `spec.network` allowlist semantics, shared with Vercel:
 *
 * - A host name is allowed if it is on `allowDomains`, or if it resolves to an
 *   address in `allowCidrs`. A leading `*.` matches any subdomain (not the
 *   domain itself), and `"*"` matches every name.
 * - An IP address is allowed if it is in `allowCidrs`.
 * - Addresses in `denyCidrs` are never connected to, whatever allowed them.
 */
export class EgressPolicy {
  private readonly anyDomain: boolean;
  private readonly domains: Set<string>;
  private readonly suffixes: string[];
  private readonly allowRanges: CidrRange[];
  private readonly denyRanges: CidrRange[];

  constructor(allowlist: SandboxNetworkAllowlist, { alwaysDeny = PROXY_LOCAL_CIDRS }: { alwaysDeny?: string[] } = {}) {
    const domains = (allowlist.allowDomains ?? []).map((domain) => domain.toLowerCase());
    this.anyDomain = domains.includes("*");
    this.domains = new Set(domains.filter((domain) => !domain.startsWith("*")));
    this.suffixes = domains.filter((domain) => domain.startsWith("*.")).map((domain) => domain.slice(1));
    this.allowRanges = ranges(allowlist.allowCidrs ?? []);
    this.denyRanges = ranges([...(allowlist.denyCidrs ?? []), ...alwaysDeny]);
  }

  /** Whether `name` (a normalized host name, not an IP address) is on the domain allowlist. */
  allowsName(name: string): boolean {
    return this.anyDomain || this.domains.has(name) || this.suffixes.some((suffix) => name.endsWith(suffix));
  }

  /**
   * Whether `name` must be resolved to decide on it. Names that are neither
   * allowlisted nor could match `allowCidrs` are refused without a DNS query,
   * so a sandbox cannot use the proxy to leak data through DNS lookups.
   */
  needsResolution(name: string): boolean {
    return this.allowsName(name) || this.allowRanges.length > 0;
  }

  /**
   * Picks the address to connect to for `host` (normalized with
   * `normalizeHost`), given what it resolved to. An IP address host resolves
   * to itself.
   */
  decide(host: string, addresses: string[]): EgressDecision {
    const nameAllowed = parseIp(host) === null && this.allowsName(host);
    let blocked = false;
    for (const address of addresses) {
      const ip = parseIp(address);
      if (ip === null) continue;
      const allowed = nameAllowed || this.allowRanges.some((range) => cidrContains(range, comparable(ip)));
      if (!allowed) continue;
      if (this.denyRanges.some((range) => cidrContains(range, comparable(ip)))) {
        blocked = true;
        continue;
      }
      return { allowed: true, address };
    }
    return {
      allowed: false,
      reason: blocked
        ? `${host} only resolves to blocked addresses`
        : `${host} is not on this sandbox's network allowlist`,
    };
  }
}

/** Lowercases a host, and strips IPv6 brackets and a trailing dot. */
export function normalizeHost(host: string): string {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

/** Whether `address` (as a socket reports it) is in one of `ranges`. */
export function addressInRanges(address: string | undefined, cidrs: readonly CidrRange[]): boolean {
  const ip = address === undefined ? null : parseIp(address);
  return ip !== null && cidrs.some((range) => cidrContains(range, comparable(ip)));
}

export function ranges(cidrs: readonly string[]): CidrRange[] {
  return cidrs.map((cidr) => {
    const range = parseCidr(cidr);
    if (range === null) throw new Error(`Invalid CIDR "${cidr}"`);
    return range;
  });
}

/** IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) compare as the IPv4 address they carry. */
function comparable(ip: IpAddress): IpAddress {
  return ip.version === 6 && ip.value >> 32n === 0xffffn ? { version: 4, value: ip.value & 0xffffffffn } : ip;
}
