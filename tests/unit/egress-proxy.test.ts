import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { parseEgressProxyConfig } from "../../src/docker/egress-proxy/config.js";
import { EgressPolicy, addressInRanges, normalizeHost, ranges } from "../../src/docker/egress-proxy/policy.js";
import { startEgressProxy } from "../../src/docker/egress-proxy/server.js";
import type { EgressProxyOptions, RunningEgressProxy } from "../../src/docker/egress-proxy/server.js";
import type { SandboxNetworkAllowlist } from "../../src/index.js";

describe("EgressPolicy", () => {
  const policy = new EgressPolicy(
    { allowDomains: ["github.com", "*.npmjs.org", "API.Example.com"], allowCidrs: ["10.0.0.0/8", "2001:db8::/32"], denyCidrs: ["10.9.0.0/16"] },
    { alwaysDeny: ["127.0.0.0/8"] },
  );

  it("allows names on the allowlist, matching wildcards on subdomains only", () => {
    expect(policy.decide("github.com", ["140.82.112.3"])).toEqual({ allowed: true, address: "140.82.112.3" });
    expect(policy.decide("registry.npmjs.org", ["104.16.0.1"]).allowed).toBe(true);
    expect(policy.decide("a.b.npmjs.org", ["104.16.0.1"]).allowed).toBe(true);
    expect(policy.decide("api.example.com", ["93.184.215.14"]).allowed).toBe(true);
    expect(policy.decide("npmjs.org", ["104.16.0.1"])).toEqual({
      allowed: false,
      reason: "npmjs.org is not on this sandbox's network allowlist",
    });
    expect(policy.decide("github.com.evil.dev", ["1.2.3.4"]).allowed).toBe(false);
    expect(policy.decide("evilgithub.com", ["1.2.3.4"]).allowed).toBe(false);
  });

  it("allows addresses in allowCidrs, whether named or literal, and never denied or proxy-local ones", () => {
    expect(policy.decide("10.1.2.3", ["10.1.2.3"]).allowed).toBe(true);
    expect(policy.decide("2001:db8::5", ["2001:db8::5"]).allowed).toBe(true);
    expect(policy.decide("db.internal", ["10.1.2.3"])).toEqual({ allowed: true, address: "10.1.2.3" });
    expect(policy.decide("::ffff:10.1.2.3", ["::ffff:10.1.2.3"]).allowed).toBe(true);
    expect(policy.decide("11.0.0.1", ["11.0.0.1"]).allowed).toBe(false);
    expect(policy.decide("github.com", ["10.9.1.1"])).toEqual({
      allowed: false,
      reason: "github.com only resolves to blocked addresses",
    });
    expect(policy.decide("github.com", ["10.9.1.1", "140.82.112.3"])).toEqual({ allowed: true, address: "140.82.112.3" });
    expect(policy.decide("github.com", ["127.0.0.1"]).allowed).toBe(false);
    expect(policy.decide("github.com", []).allowed).toBe(false);
  });

  it("only resolves names that could be allowed", () => {
    expect(policy.needsResolution("github.com")).toBe(true);
    expect(policy.needsResolution("anything.dev")).toBe(true); // allowCidrs could match it
    const domainsOnly = new EgressPolicy({ allowDomains: ["github.com"] });
    expect(domainsOnly.needsResolution("github.com")).toBe(true);
    expect(domainsOnly.needsResolution("leak.attacker.dev")).toBe(false);
    expect(new EgressPolicy({ allowDomains: ["*"] }).decide("anything.dev", ["1.2.3.4"]).allowed).toBe(true);
    expect(new EgressPolicy({ allowDomains: ["*"] }).decide("1.2.3.4", ["1.2.3.4"]).allowed).toBe(false);
  });

  it("normalizes hosts and matches client addresses, including IPv4-mapped ones", () => {
    expect(normalizeHost("GitHub.COM.")).toBe("github.com");
    expect(normalizeHost("[2001:DB8::1]")).toBe("2001:db8::1");
    const clients = ranges(["172.18.0.0/16"]);
    expect(addressInRanges("172.18.0.2", clients)).toBe(true);
    expect(addressInRanges("::ffff:172.18.0.2", clients)).toBe(true);
    expect(addressInRanges("172.17.0.2", clients)).toBe(false);
    expect(addressInRanges(undefined, clients)).toBe(false);
  });
});

describe("parseEgressProxyConfig", () => {
  const valid = { port: 3128, policy: { allowDomains: ["github.com"] }, clients: ["172.18.0.0/16"], forwards: [{ port: 3000, host: "sandbox", targetPort: 3000 }] };

  it("accepts a valid config and rejects broken ones", () => {
    expect(parseEgressProxyConfig(JSON.stringify(valid))).toEqual(valid);
    expect(() => parseEgressProxyConfig(undefined)).toThrow("SANDBOX_EGRESS_PROXY_CONFIG is not set");
    expect(() => parseEgressProxyConfig(JSON.stringify({ ...valid, port: 0 }))).toThrow("config.port");
    expect(() => parseEgressProxyConfig(JSON.stringify({ ...valid, policy: "deny-all" }))).toThrow("config.policy");
    expect(() => parseEgressProxyConfig(JSON.stringify({ ...valid, policy: { allow: [] } }))).toThrow("Unknown field");
    expect(() => parseEgressProxyConfig(JSON.stringify({ ...valid, clients: ["nope"] }))).toThrow('Invalid CIDR "nope"');
    expect(() => parseEgressProxyConfig(JSON.stringify({ ...valid, forwards: [{ port: 1 }] }))).toThrow("config.forwards");
  });
});

/** Sends raw bytes to `port` and resolves everything received until the server closes the connection. */
function raw(port: number, ...chunks: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => chunks.forEach((chunk) => socket.write(chunk)));
    socket.on("data", (data: string) => (received += data));
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
  });
}

describe("startEgressProxy", () => {
  let upstream: Server;
  let upstreamPort: number;
  const proxies: RunningEgressProxy[] = [];
  const resolved: string[] = [];
  const hosts: Record<string, string[]> = { "allowed.test": ["127.0.0.1"], "a.wild.test": ["127.0.0.1"], "wild.test": ["127.0.0.1"] };

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("x-upstream", "yes");
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await Promise.all(proxies.map((proxy) => proxy.close()));
    await new Promise((resolve) => upstream.close(resolve));
  });

  async function proxy(policy: SandboxNetworkAllowlist, options: EgressProxyOptions = {}) {
    const running = await startEgressProxy(
      { port: 0, policy, clients: [], forwards: [{ port: 0, host: "127.0.0.1", targetPort: upstreamPort }] },
      {
        host: "127.0.0.1",
        alwaysDeny: [],
        resolve: async (name) => {
          resolved.push(name);
          const addresses = hosts[name];
          if (!addresses) throw new Error(`ENOTFOUND ${name}`);
          return addresses;
        },
        ...options,
      },
    );
    proxies.push(running);
    return running;
  }

  const get = (url: string, extra = "") =>
    `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic eDp5\r\n${extra}Connection: close\r\n\r\n`;
  const bodyOf = (response: string) => JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4).replace(/^[0-9a-f]+\r\n|\r\n0\r\n\r\n$/g, ""));

  it("forwards plain HTTP requests to allowed hosts without proxy headers", async () => {
    const { port } = await proxy({ allowDomains: ["allowed.test"] });
    const response = await raw(port, get(`http://allowed.test:${upstreamPort}/path?q=1`));
    expect(response).toStartWith("HTTP/1.1 200 OK");
    expect(response).toContain("x-upstream: yes");
    const seen = bodyOf(response);
    expect(seen).toMatchObject({ method: "GET", url: "/path?q=1", headers: { host: `allowed.test:${upstreamPort}` } });
    expect(seen.headers["proxy-connection"]).toBeUndefined();
    expect(seen.headers["proxy-authorization"]).toBeUndefined();

    const post = await raw(
      port,
      `POST http://allowed.test:${upstreamPort}/submit HTTP/1.1\r\nHost: allowed.test:${upstreamPort}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`,
    );
    expect(bodyOf(post)).toMatchObject({ method: "POST", url: "/submit", body: "hello" });
  });

  it("refuses hosts off the allowlist, without resolving them", async () => {
    const { port } = await proxy({ allowDomains: ["allowed.test", "*.wild.test"] });
    expect(await raw(port, get(`http://a.wild.test:${upstreamPort}/`))).toStartWith("HTTP/1.1 200 OK");
    resolved.length = 0;
    const denied = await raw(port, get(`http://wild.test:${upstreamPort}/`));
    expect(denied).toStartWith("HTTP/1.1 403 Forbidden");
    expect(denied).toContain("Blocked by the sandbox egress proxy: wild.test is not on this sandbox's network allowlist");
    expect(resolved).toEqual([]);
    expect(await raw(port, get(`http://127.0.0.1:${upstreamPort}/`))).toStartWith("HTTP/1.1 403");
  });

  it("allows IP addresses in allowCidrs and blocks denyCidrs and, by default, its own loopback", async () => {
    const byCidr = await proxy({ allowCidrs: ["127.0.0.0/8"] });
    expect(await raw(byCidr.port, get(`http://127.0.0.1:${upstreamPort}/`))).toStartWith("HTTP/1.1 200 OK");
    expect(await raw(byCidr.port, get(`http://allowed.test:${upstreamPort}/`))).toStartWith("HTTP/1.1 200 OK");

    const denied = await proxy({ allowDomains: ["allowed.test"], denyCidrs: ["127.0.0.1"] });
    expect(await raw(denied.port, get(`http://allowed.test:${upstreamPort}/`))).toContain("only resolves to blocked addresses");

    const local = await proxy({ allowDomains: ["allowed.test"] }, { alwaysDeny: undefined });
    expect(await raw(local.port, get(`http://allowed.test:${upstreamPort}/`))).toStartWith("HTTP/1.1 403");
  });

  it("tunnels CONNECT to allowed hosts, including bytes sent before the 200", async () => {
    const logged: string[] = [];
    const { port } = await proxy({ allowDomains: ["allowed.test"] }, { log: (line) => logged.push(line) });
    const response = await raw(
      port,
      `CONNECT allowed.test:${upstreamPort} HTTP/1.1\r\nHost: allowed.test:${upstreamPort}\r\n\r\nGET /tunneled HTTP/1.0\r\n\r\n`,
    );
    expect(response).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200 OK");
    expect(response).toContain('"url":"/tunneled"');

    expect(await raw(port, `CONNECT blocked.test:443 HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 403 Forbidden");
    expect(await raw(port, `CONNECT allowed.test HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 400 Bad Request");
    expect(await raw(port, `CONNECT allowed.test:1 HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 502 Bad Gateway");
    expect(logged.slice(0, 2)).toEqual([
      `allow CONNECT allowed.test:${upstreamPort} -> 127.0.0.1`,
      "deny CONNECT blocked.test:443: blocked.test is not on this sandbox's network allowlist",
    ]);
  });

  it("reports unresolvable hosts, rejects non-proxy requests and answers health checks", async () => {
    const { port } = await proxy({ allowDomains: ["*"] });
    expect(await raw(port, get("http://missing.test/"))).toContain("502 Bad Gateway");
    expect(await raw(port, get("http://missing.test/"))).toContain("could not resolve missing.test");
    expect(await raw(port, `GET https://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`)).toContain(
      "tunnel https: with CONNECT",
    );
    expect(await raw(port, `GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).toStartWith("HTTP/1.1 400");
    const health = await raw(port, `GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    expect(health).toStartWith("HTTP/1.1 200 OK");
    expect(health).toEndWith("ok\n");
  });

  it("forwards published ports to the sandbox whatever the policy", async () => {
    const { forwardPorts } = await proxy({});
    const response = await raw(forwardPorts[0]!, `GET /inbound HTTP/1.0\r\n\r\n`);
    expect(response).toStartWith("HTTP/1.1 200 OK");
    expect(response).toContain('"url":"/inbound"');
  });
});
