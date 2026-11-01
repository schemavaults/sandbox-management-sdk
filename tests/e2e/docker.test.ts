import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import Docker from "dockerode";
import { SandboxCommandError, SandboxManager } from "../../src/index.js";
import type { SandboxSpec } from "../../src/index.js";
import { DOCKER_EGRESS_PROXY_LABEL, DOCKER_SANDBOX_ID_LABEL, DockerSandboxProvider } from "../../src/docker/index.js";
import { InMemorySandboxStore } from "../../src/testing/index.js";

// Requires a Docker daemon, the fixture image and the egress proxy image:
// `bun run test:e2e:fixture-image && bun run test:e2e:egress-proxy-image`.
const IMAGE = process.env.SANDBOX_E2E_DOCKER_IMAGE ?? "sandbox-sdk-e2e:latest";
const EGRESS_PROXY_IMAGE = process.env.SANDBOX_E2E_EGRESS_PROXY_IMAGE ?? "sandbox-egress-proxy:e2e";
const TIMEOUT = 120_000;

const docker = new Docker();
const provider = new DockerSandboxProvider({
  docker,
  defaultImage: IMAGE,
  pullPolicy: "never",
  egressProxyImage: EGRESS_PROXY_IMAGE,
});

/** A tiny HTTP server on :8080 using busybox nc; prints `banner` first. */
const server = (banner: string) =>
  `echo ${banner}; while true; do printf 'HTTP/1.0 200 OK\\r\\nContent-Length: 5\\r\\n\\r\\nhello' | nc -l -p 8080; done`;

const spec: SandboxSpec = {
  git: { url: "file:///srv/fixture-repo", revision: "v1", depth: 1 },
  setup: ["test -f README.md", "echo setup-ran > setup.txt && echo setup-output"],
  start: server("started"),
  resume: server("resumed"),
  ports: [8080],
  env: { GREETING: "hi" },
  resources: { memoryMb: 256 },
};

const createdIds: string[] = [];

function createManager(now?: () => Date) {
  return new SandboxManager({ providers: [provider], store: new InMemorySandboxStore(), now });
}

async function eventually<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (predicate(value)) return value;
      if (Date.now() > deadline) return value;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const fetchText = (url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((res) => res.text());

async function containerFor(id: string) {
  const [info] = await docker.listContainers({ all: true, filters: { label: [`${DOCKER_SANDBOX_ID_LABEL}=${id}`] } });
  return info;
}

/** A sandbox's egress proxy container and internal network, if it has them. */
async function egressFor(id: string) {
  const filters = { label: [`${DOCKER_EGRESS_PROXY_LABEL}=${id}`] };
  const [proxy] = await docker.listContainers({ all: true, filters });
  const [network] = await docker.listNetworks({ filters });
  return { proxy, network };
}

/** Removes whatever the tests' sandboxes left behind. */
async function removeLeftovers() {
  for (const id of createdIds.splice(0)) {
    const info = await containerFor(id);
    if (info) await docker.getContainer(info.Id).remove({ force: true });
    const { proxy, network } = await egressFor(id);
    if (proxy) await docker.getContainer(proxy.Id).remove({ force: true });
    if (network) await docker.getNetwork(network.Id).remove();
  }
}

afterAll(removeLeftovers);

describe("DockerSandboxProvider e2e", () => {
  it(
    "runs the full lifecycle against a real Docker daemon",
    async () => {
      const manager = createManager();
      let setupOutput = "";
      const record = await manager.create({
        spec,
        ownerId: "e2e",
        labels: { suite: "docker" },
        onStdout: (chunk) => (setupOutput += chunk),
      });
      createdIds.push(record.id);
      expect(record.status).toBe("running");
      expect((await containerFor(record.id))?.State).toBe("running");

      // git clone + setup ran in the workdir
      expect(await manager.readTextFile(record.id, "README.md")).toBe("fixture v1\n");
      expect(await manager.readTextFile(record.id, "setup.txt")).toBe("setup-ran\n");

      // exec: shell strings, argv with cwd/env, exit codes, streaming
      expect(await manager.exec(record.id, 'echo "$GREETING from $(pwd)"')).toEqual({
        exitCode: 0,
        stdout: "hi from /workspace\n",
        stderr: "",
      });
      await manager.exec(record.id, "mkdir -p sub");
      const argv = await manager.exec(record.id, { cmd: "sh", args: ["-c", "echo $X $(pwd) >&2; exit 4"], cwd: "sub", env: { X: "x" } });
      expect(argv).toEqual({ exitCode: 4, stdout: "", stderr: "x /workspace/sub\n" });
      let streamed = "";
      await manager.exec(record.id, "for i in 1 2 3; do echo $i; done", { onStdout: (c) => (streamed += c) });
      expect(streamed).toBe("1\n2\n3\n");

      // main process, logs and published port
      expect(await manager.getMainProcess(record.id)).toMatchObject({ running: true, exitCode: null });
      expect(await eventually(() => manager.readLogs(record.id), (logs) => logs.includes("started"))).toContain("started");
      const url = await manager.getUrl(record.id, 8080);
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(await eventually(() => fetchText(url), (body) => body === "hello")).toBe("hello");

      // files, including nested paths, binary content and modes
      await manager.writeFiles(record.id, [
        { path: "deep/er/script.sh", content: "#!/bin/sh\necho from-script\n", mode: 0o755 },
        { path: "/tmp/bytes.bin", content: new Uint8Array([0, 1, 254, 255]) },
      ]);
      expect((await manager.exec(record.id, "./deep/er/script.sh")).stdout).toBe("from-script\n");
      expect(await manager.readFile(record.id, "/tmp/bytes.bin")).toEqual(new Uint8Array([0, 1, 254, 255]));
      expect(await manager.readFile(record.id, "does/not/exist")).toBeNull();

      // stop keeps the filesystem; access auto-resumes and runs the resume command
      expect((await manager.stop(record.id)).status).toBe("stopped");
      expect((await containerFor(record.id))?.State).toBe("exited");
      expect(await manager.readTextFile(record.id, "setup.txt")).toBe("setup-ran\n");
      expect((await manager.get(record.id)).status).toBe("running");
      const logs = await eventually(() => manager.readLogs(record.id), (text) => text.includes("resumed"));
      expect(logs).toContain("started");
      expect(logs).toContain("resumed");
      const resumedUrl = await manager.getUrl(record.id, 8080);
      expect(await eventually(() => fetchText(resumedUrl), (body) => body === "hello")).toBe("hello");

      // a container stopped behind the SDK's back is detected and resumed
      await docker.getContainer(record.providerRef!).stop({ t: 1 });
      expect((await manager.exec(record.id, "cat setup.txt")).stdout).toBe("setup-ran\n");

      // reconcile picks up external stops
      await docker.getContainer(record.providerRef!).stop({ t: 1 });
      const [reconciled] = await manager.reconcile([record.id]);
      expect(reconciled?.status).toBe("stopped");

      // destroy removes the container and keeps the record
      expect((await manager.destroy(record.id)).status).toBe("destroyed");
      expect(await containerFor(record.id)).toBeUndefined();
      expect(await manager.list({ ownerId: "e2e" })).toHaveLength(0);
      expect(setupOutput).toBe("setup-output\n");
    },
    TIMEOUT,
  );

  it(
    "resumes once when concurrent callers hit a stopped sandbox",
    async () => {
      const manager = createManager();
      const { id } = await manager.create({ spec: { start: server("started"), resume: "echo resumed-once", ports: [8080] } });
      createdIds.push(id);
      await manager.stop(id);
      const results = await Promise.all(Array.from({ length: 4 }, () => manager.exec(id, "echo ok")));
      expect(results.map((result) => result.stdout)).toEqual(["ok\n", "ok\n", "ok\n", "ok\n"]);
      const logs = await eventually(() => manager.readLogs(id), (text) => text.includes("resumed-once"));
      expect(logs.match(/resumed-once/g)).toHaveLength(1);
      await manager.destroy(id);
    },
    TIMEOUT,
  );

  it(
    "marks a sandbox failed when setup fails and keeps the container until destroyed",
    async () => {
      const manager = createManager();
      const error = await manager.create({ spec: { setup: ["echo ok", "echo broken >&2; exit 9"] } }).catch((e) => e);
      expect(error).toBeInstanceOf(SandboxCommandError);
      expect(error.message).toBe("setup step 2 exited with code 9: broken");
      const [record] = await manager.list({ status: "failed" });
      createdIds.push(record!.id);
      expect(await containerFor(record!.id)).toBeDefined();
      await manager.destroy(record!.id);
      expect(await containerFor(record!.id)).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "fails clearly for an unknown git revision",
    async () => {
      const manager = createManager();
      const error = await manager
        .create({ spec: { git: { url: "file:///srv/fixture-repo", revision: "no-such-ref" } } })
        .catch((e) => e);
      expect(error).toBeInstanceOf(SandboxCommandError);
      expect(error.message).toStartWith("git clone exited with code");
      const [record] = await manager.list({ status: "failed" });
      createdIds.push(record!.id);
      await manager.destroy(record!.id);
    },
    TIMEOUT,
  );

  it(
    "stops expired sandboxes",
    async () => {
      let now = new Date();
      const manager = createManager(() => now);
      const { id } = await manager.create({ spec: { timeoutMs: 60_000 } });
      createdIds.push(id);
      expect(await manager.stopExpired()).toHaveLength(0);
      now = new Date(now.getTime() + 61_000);
      expect((await manager.stopExpired()).map((record) => record.id)).toEqual([id]);
      expect((await containerFor(id))?.State).toBe("exited");
      await manager.destroy(id);
    },
    TIMEOUT,
  );

  it(
    'cuts a "deny-all" sandbox off from the network, across stop and resume',
    async () => {
      const manager = createManager();
      const { id, providerRef } = await manager.create({
        spec: { git: { url: "file:///srv/fixture-repo" }, network: "deny-all" },
      });
      createdIds.push(id);
      expect((await docker.getContainer(providerRef!).inspect()).HostConfig.NetworkMode).toBe("none");
      const offline = async () => {
        expect((await manager.exec(id, "ls /sys/class/net")).stdout).toBe("lo\n");
        expect((await manager.exec(id, "wget -q -T 3 -O /dev/null http://1.1.1.1")).exitCode).not.toBe(0);
      };
      await offline();
      expect(await manager.readTextFile(id, "README.md")).toBe("fixture v2\n"); // local clones still work
      await manager.stop(id);
      await manager.resume(id);
      await offline();
      await manager.destroy(id);
    },
    TIMEOUT,
  );

});

/** An HTTP server on :8080 that answers every request with `body`. */
const respond = (body: string) =>
  `while true; do printf 'HTTP/1.0 200 OK\\r\\nContent-Length: ${body.length}\\r\\n\\r\\n${body}' | nc -l -p 8080; done`;

describe("DockerSandboxProvider network allowlists e2e", () => {
  // Stand-ins for the internet: containers on a network only the egress proxies join.
  const OUTSIDE = `sandbox-e2e-outside-${process.pid}`;
  const servers: Docker.Container[] = [];
  const ip: Record<string, string> = {};

  async function startServer(key: string, network: string, aliases: string[]) {
    const container = await docker.createContainer({
      Image: IMAGE,
      Entrypoint: ["sh", "-c", respond(key)],
      HostConfig: { NetworkMode: network },
      NetworkingConfig: network === "bridge" ? undefined : { EndpointsConfig: { [network]: { Aliases: aliases } } },
    });
    servers.push(container);
    await container.start();
    ip[key] = (await container.inspect()).NetworkSettings.Networks[network]!.IPAddress;
  }

  beforeAll(async () => {
    await docker.createNetwork({ Name: OUTSIDE, Driver: "bridge" });
    await startServer("upstream", OUTSIDE, ["allowed.test", "a.wild.test"]);
    await startServer("other", OUTSIDE, ["blocked.test", "wild.test"]);
    await startServer("denied", OUTSIDE, ["denied.test"]);
    await startServer("on-bridge", "bridge", []);
  }, TIMEOUT);

  afterAll(async () => {
    await removeLeftovers();
    for (const container of servers) await container.remove({ force: true });
    await docker.getNetwork(OUTSIDE).remove();
  });

  /** Fetches `url` from inside the sandbox with busybox wget, which honors `http_proxy`. */
  const fetchIn = (manager: SandboxManager, id: string, url: string) =>
    manager.exec(id, `wget -q -T 5 -O - ${url}`);

  it(
    "lets a sandbox reach only its allowlist, through the egress proxy, across stop and resume",
    async () => {
      const manager = createManager();
      const record = await manager.create({
        spec: {
          // Runs through the proxy as soon as the sandbox exists, so the proxy must be ready by then.
          setup: "wget -q -T 5 -O setup.txt http://allowed.test:8080/",
          start: respond("from-sandbox"),
          ports: [8080],
          network: {
            allowDomains: ["allowed.test", "*.wild.test", "denied.test"],
            allowCidrs: [ip.upstream!],
            denyCidrs: [ip.denied!],
          },
          providerOptions: { docker: { network: OUTSIDE } },
        },
      });
      const { id, providerRef } = record;
      createdIds.push(id);
      expect(await manager.readTextFile(id, "setup.txt")).toBe("upstream");

      // The sandbox sits alone on an internal network with its proxy, which publishes its ports.
      const { proxy, network } = await egressFor(id);
      expect(proxy?.State).toBe("running");
      expect(network?.Internal).toBe(true);
      const sandbox = await docker.getContainer(providerRef!).inspect();
      expect(Object.keys(sandbox.NetworkSettings.Networks)).toEqual([network!.Name]);
      expect(sandbox.Config.Env).toContain("HTTPS_PROXY=http://egress-proxy:3128");

      // Allowed: names on the list (wildcards match subdomains) and addresses in allowCidrs.
      expect((await fetchIn(manager, id, "http://allowed.test:8080/")).stdout).toBe("upstream");
      expect((await fetchIn(manager, id, "http://a.wild.test:8080/")).stdout).toBe("upstream");
      expect((await fetchIn(manager, id, `http://${ip.upstream}:8080/`)).stdout).toBe("upstream");
      // Refused by the proxy: names off the list (that do not resolve into allowCidrs), the
      // wildcard's apex, and allowed names that resolve into denyCidrs.
      for (const url of ["http://blocked.test:8080/", "http://wild.test:8080/", "http://denied.test:8080/"]) {
        const result = await fetchIn(manager, id, url);
        expect({ url, exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ url, exitCode: 1 });
        expect(result.stderr).toContain("403 Forbidden");
      }

      // CONNECT tunnels (what HTTPS uses) obey the same list.
      const connect = (host: string) =>
        manager.exec(
          id,
          `printf 'CONNECT ${host}:8080 HTTP/1.1\\r\\nHost: ${host}:8080\\r\\n\\r\\nGET / HTTP/1.0\\r\\n\\r\\n' | nc -w 5 egress-proxy 3128`,
        );
      const tunneled = (await connect("allowed.test")).stdout;
      expect(tunneled).toStartWith("HTTP/1.1 200 Connection Established");
      expect(tunneled).toEndWith("upstream");
      expect((await connect("blocked.test")).stdout).toStartWith("HTTP/1.1 403 Forbidden");

      // Nothing gets around the proxy: no route out, and no DNS for outside names.
      const direct = await manager.exec(id, `unset http_proxy HTTP_PROXY; wget -q -T 3 -O - http://${ip.upstream}:8080/`);
      expect(direct.exitCode).not.toBe(0);
      expect((await manager.exec(id, "nslookup allowed.test")).exitCode).not.toBe(0);

      // Published ports are reachable from the host through the proxy.
      const url = await manager.getUrl(id, 8080);
      expect(await eventually(() => fetchText(url), (body) => body === "from-sandbox")).toBe("from-sandbox");

      // stop takes the proxy down too; resuming brings both back.
      await manager.stop(id);
      expect((await containerFor(id))?.State).toBe("exited");
      expect((await egressFor(id)).proxy?.State).toBe("exited");
      expect((await fetchIn(manager, id, "http://allowed.test:8080/")).stdout).toBe("upstream");
      const resumedUrl = await manager.getUrl(id, 8080);
      expect(await eventually(() => fetchText(resumedUrl), (body) => body === "from-sandbox")).toBe("from-sandbox");

      // A proxy stopped behind the SDK's back counts as a stopped sandbox, and is restarted on access.
      await docker.getContainer((await egressFor(id)).proxy!.Id).stop({ t: 1 });
      expect((await manager.reconcile([id]))[0]?.status).toBe("stopped");
      expect((await fetchIn(manager, id, "http://allowed.test:8080/")).stdout).toBe("upstream");

      // destroy removes the proxy and the internal network along with the sandbox.
      await manager.destroy(id);
      expect(await containerFor(id)).toBeUndefined();
      expect(await egressFor(id)).toEqual({ proxy: undefined, network: undefined });
    },
    TIMEOUT,
  );

  it(
    "reaches the outside through Docker's default bridge when no network is given",
    async () => {
      const manager = createManager();
      const { id } = await manager.create({ spec: { network: { allowCidrs: [ip["on-bridge"]!] } } });
      createdIds.push(id);
      expect((await egressFor(id)).proxy?.HostConfig.NetworkMode).toBe("bridge");
      expect((await fetchIn(manager, id, `http://${ip["on-bridge"]}:8080/`)).stdout).toBe("on-bridge");
      expect((await fetchIn(manager, id, "http://1.1.1.1/")).stderr).toContain("403 Forbidden");
      await manager.destroy(id);
    },
    TIMEOUT,
  );

  it(
    'publishes ports of a "deny-all" sandbox through a proxy that lets nothing out',
    async () => {
      const manager = createManager();
      const { id } = await manager.create({ spec: { network: "deny-all", ports: [8080], start: respond("deny-all") } });
      createdIds.push(id);
      const url = await manager.getUrl(id, 8080);
      expect(await eventually(() => fetchText(url), (body) => body === "deny-all")).toBe("deny-all");
      expect((await fetchIn(manager, id, `http://${ip["on-bridge"]}:8080/`)).stderr).toContain("403 Forbidden");
      await manager.destroy(id);
      expect(await egressFor(id)).toEqual({ proxy: undefined, network: undefined });
    },
    TIMEOUT,
  );

  it(
    "refuses an outside network the proxy cannot use, before creating anything",
    async () => {
      const manager = createManager();
      const error = await manager
        .create({ spec: { network: { allowDomains: ["allowed.test"] }, providerOptions: { docker: { network: "none" } } } })
        .catch((e) => e);
      expect(error.message).toContain('docker.network "none" cannot carry the egress proxy\'s traffic');
      const [record] = await manager.list({ status: "failed" });
      createdIds.push(record!.id);
      expect(await containerFor(record!.id)).toBeUndefined();
      expect(await egressFor(record!.id)).toEqual({ proxy: undefined, network: undefined });
    },
    TIMEOUT,
  );
});
