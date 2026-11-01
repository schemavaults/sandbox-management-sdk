import { afterAll, describe, expect, it } from "bun:test";
import Docker from "dockerode";
import { SandboxCommandError, SandboxManager } from "../../src/index.js";
import type { SandboxSpec } from "../../src/index.js";
import { DOCKER_SANDBOX_ID_LABEL, DockerSandboxProvider } from "../../src/docker/index.js";
import { InMemorySandboxStore } from "../../src/testing/index.js";

// Requires a Docker daemon and the fixture image: `bun run test:e2e:fixture-image`.
const IMAGE = process.env.SANDBOX_E2E_DOCKER_IMAGE ?? "sandbox-sdk-e2e:latest";
const TIMEOUT = 120_000;

const docker = new Docker();
const provider = new DockerSandboxProvider({ docker, defaultImage: IMAGE, pullPolicy: "never" });

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

afterAll(async () => {
  for (const id of createdIds) {
    const info = await containerFor(id);
    if (info) await docker.getContainer(info.Id).remove({ force: true });
  }
});

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

  it(
    "refuses a network allowlist without creating a container",
    async () => {
      const manager = createManager();
      await expect(manager.create({ spec: { network: { allowDomains: ["github.com"] } } })).rejects.toThrow(
        "cannot enforce a network allowlist",
      );
      expect(await manager.list()).toHaveLength(0);
    },
    TIMEOUT,
  );
});
