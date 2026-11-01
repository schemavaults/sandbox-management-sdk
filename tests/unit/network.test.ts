import { describe, expect, it } from "bun:test";
import { isIP } from "node:net";
import { assertNetworkPolicySupported, networkPolicyKind, normalizeCidr, validateSpec } from "../../src/index.js";
import type { SandboxNetworkPolicy } from "../../src/index.js";
import { parseCidr } from "../../src/network.js";

const validate = (network: unknown) => () => validateSpec({ network: network as SandboxNetworkPolicy });

describe("network policies", () => {
  it("accepts the presets and well-formed allowlists", () => {
    for (const network of [undefined, "allow-all", "deny-all", {}, { allowDomains: [] }]) {
      expect(validate(network)).not.toThrow();
    }
    expect(
      validate({
        allowDomains: ["github.com", "*.npmjs.org", "API.Example.COM", "localhost", "a-b.c-d.io", "*"],
        allowCidrs: ["203.0.113.10", "10.0.0.0/8", "0.0.0.0/0", "2001:db8::/32", "::1", "::ffff:192.0.2.1/128"],
        denyCidrs: ["169.254.169.254/32", "fd00::/8"],
      }),
    ).not.toThrow();
  });

  it("rejects malformed policies with a message that says what to fix", () => {
    expect(validate("none")).toThrow('network must be "allow-all", "deny-all"');
    expect(validate(null)).toThrow("network must be");
    expect(validate(["github.com"])).toThrow("network must be");
    expect(validate({ allow: ["github.com"] })).toThrow("Unknown field network.allow; expected allowDomains");
    expect(validate({ allowDomains: "github.com" })).toThrow("network.allowDomains must be an array of strings");
    expect(validate({ denyCidrs: [10] })).toThrow("network.denyCidrs must be an array of strings");
    expect(validate({ allowDomains: ["203.0.113.10"] })).toThrow("put it in allowCidrs");
    for (const domain of ["https://github.com", "github.com:443", "github.com/path", "*.*.com", "a.*.com", "-a.com", "a..com", "github.com.", "", "ex ample.com", "bücher.de", `${"a".repeat(64)}.com`]) {
      expect(validate({ allowDomains: [domain] })).toThrow(`Invalid domain "${domain}"`);
    }
    for (const cidr of ["10.0.0.0/33", "10.0.0/8", "256.0.0.1", "01.2.3.4", "10.0.0.0/08", "10.0.0.0/8/1", "::/129", "fe80::1%eth0", "1::2::3", "github.com", ""]) {
      expect(validate({ allowCidrs: [cidr] })).toThrow(`Invalid IP address or CIDR "${cidr}" in network.allowCidrs`);
    }
  });

  it("parses IP addresses like node:net, except IPv6 zone IDs (rejected above)", () => {
    const candidates = [
      "0.0.0.0", "255.255.255.255", "1.2.3.4", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.-4", " 1.2.3.4",
      "::", "::1", "1::", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8::", "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7", ":1", "1:", ":::", "1:::2", "1::2::3", "12345::", "g::", "ABCD:ef01::",
      "::ffff:1.2.3.4", "::1.2.3.4", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "1::1.2.3.4", "1.2.3.4::",
      "::ffff:1.2.3", ":1.2.3.4", "1:1.2.3.4", "2001:db8:0:0:0:0:2:1", "2001:db8::2:1",
    ];
    for (const address of candidates) {
      expect({ address, version: parseCidr(address)?.version ?? 0 }).toEqual({ address, version: isIP(address) });
    }
  });

  it("normalizes bare addresses to single-host ranges", () => {
    expect(normalizeCidr("203.0.113.10")).toBe("203.0.113.10/32");
    expect(normalizeCidr("2001:db8::1")).toBe("2001:db8::1/128");
    expect(normalizeCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("classifies policies and checks them against what a provider enforces", () => {
    expect(networkPolicyKind(undefined)).toBe("allow-all");
    expect(networkPolicyKind("allow-all")).toBe("allow-all");
    expect(networkPolicyKind("deny-all")).toBe("deny-all");
    expect(networkPolicyKind({})).toBe("allowlist");

    const none = { name: "p" };
    const denyOnly = { name: "p", networkPolicies: ["deny-all"] as const };
    expect(() => assertNetworkPolicySupported(none, undefined)).not.toThrow();
    expect(() => assertNetworkPolicySupported(none, "allow-all")).not.toThrow();
    expect(() => assertNetworkPolicySupported(none, "deny-all")).toThrow(
      'Provider "p" cannot enforce a "deny-all" network policy (spec.network): it enforces no network restrictions',
    );
    expect(() => assertNetworkPolicySupported(denyOnly, "deny-all")).not.toThrow();
    expect(() => assertNetworkPolicySupported(denyOnly, { allowDomains: ["github.com"] })).toThrow(
      'Provider "p" cannot enforce a network allowlist (spec.network): it enforces only "deny-all"',
    );
  });
});
