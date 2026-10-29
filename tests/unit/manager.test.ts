import { describe, expect, it } from "bun:test";
import {
  ProviderSandboxMissingError,
  SandboxBusyError,
  SandboxCommandError,
  SandboxError,
  SandboxManager,
  SandboxStateError,
} from "../../src/index.js";
import type { CreateSandboxOptions, SandboxManagerOptions } from "../../src/index.js";
import { InMemorySandboxStore, MockSandboxProvider } from "../../src/testing/index.js";
import type { MockSandboxProviderOptions } from "../../src/testing/index.js";

function setup(providerOptions: MockSandboxProviderOptions = {}, managerOptions: Partial<SandboxManagerOptions> = {}) {
  const provider = new MockSandboxProvider(providerOptions);
  const store = new InMemorySandboxStore();
  const manager = new SandboxManager({ providers: [provider], store, pollIntervalMs: 5, ...managerOptions });
  return { provider, store, manager };
}

const spec: CreateSandboxOptions["spec"] = {
  git: { url: "https://example.com/repo.git", revision: "main", depth: 1 },
  setup: ["npm ci", { cmd: "npm", args: ["run", "build"], cwd: "app" }],
  start: "npm start",
  resume: "npm run resume",
  ports: [3000],
  env: { NODE_ENV: "production" },
};

describe("SandboxManager.create", () => {
  it("clones, runs setup in order, launches start and records the sandbox", async () => {
    const { manager, provider } = setup();
    const record = await manager.create({ spec, ownerId: "user-1", labels: { team: "a" }, metadata: { m: 1 } });

    expect(record).toMatchObject({
      provider: "mock",
      status: "running",
      ownerId: "user-1",
      labels: { team: "a" },
      metadata: { m: 1 },
      error: null,
    });
    expect(record.id).toMatch(/^sbx-[0-9a-f]{32}$/);
    expect(record.providerRef).toBe(`mock-${record.id}`);

    const execs = provider.callsFor(record.id, "exec").map((call) => call.command!);
    expect(execs).toHaveLength(3);
    expect(execs[0]!.env).toMatchObject({ SANDBOX_GIT_URL: "https://example.com/repo.git", SANDBOX_GIT_DIR: "/workspace" });
    expect(execs[1]).toEqual({ cmd: "sh", args: ["-c", "npm ci"], cwd: "/workspace", env: {} });
    expect(execs[2]).toEqual({ cmd: "npm", args: ["run", "build"], cwd: "/workspace/app", env: {} });

    const [start] = provider.callsFor(record.id, "startMainProcess");
    expect(start?.command).toEqual({ cmd: "sh", args: ["-c", "npm start"], cwd: "/workspace", env: {} });
    expect(await manager.getMainProcess(record.id)).toEqual({ pid: 100, running: true, exitCode: null });
    expect(await manager.get(record.id)).toEqual(record);
  });

  it("streams setup output", async () => {
    const { manager } = setup({ execHandler: () => ({ stdout: "out\n", stderr: "err\n" }) });
    let stdout = "";
    let stderr = "";
    await manager.create({
      spec: { setup: "make" },
      onStdout: (chunk) => (stdout += chunk),
      onStderr: (chunk) => (stderr += chunk),
    });
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
  });

  it("marks the sandbox failed and keeps the provider sandbox when a setup step fails", async () => {
    const { manager, store, provider } = setup({
      execHandler: ({ command }) =>
        command.args.includes("exit 3") ? { exitCode: 3, stderr: "nope" } : undefined,
    });
    const error = await manager.create({ spec: { setup: ["true", "exit 3", "never"] } }).catch((e) => e);
    expect(error).toBeInstanceOf(SandboxCommandError);
    expect(error.message).toBe("setup step 2 exited with code 3: nope");

    const [record] = await store.list();
    expect(record).toMatchObject({ status: "failed", error: error.message });
    expect(provider.callsFor(record!.id, "exec")).toHaveLength(2);
    expect(provider.getState(record!.id)).toBeDefined();
    expect(provider.callsFor(record!.id, "startMainProcess")).toHaveLength(0);

    await expect(manager.exec(record!.id, "ls")).rejects.toBeInstanceOf(SandboxStateError);
    expect((await manager.destroy(record!.id)).status).toBe("destroyed");
    expect(provider.getState(record!.id)).toBeUndefined();
  });

  it("marks the sandbox failed when the provider cannot create it", async () => {
    const { manager, store } = setup({
      beforeOperation: (operation) => {
        if (operation === "create") throw new Error("quota exceeded");
      },
    });
    await expect(manager.create({ spec: {} })).rejects.toThrow("quota exceeded");
    const [record] = await store.list();
    expect(record).toMatchObject({ status: "failed", error: "quota exceeded", providerRef: null });
    expect((await manager.destroy(record!.id)).status).toBe("destroyed");
  });

  it("validates the spec before creating anything", async () => {
    const { manager, store } = setup();
    await expect(manager.create({ spec: { ports: [0] } })).rejects.toBeInstanceOf(SandboxError);
    await expect(manager.create({ spec: { env: { "BAD-NAME": "x" } } })).rejects.toThrow("Invalid environment");
    await expect(manager.create({ spec: { workdir: "relative" } })).rejects.toThrow("absolute");
    expect(await store.list()).toHaveLength(0);
  });

  it("requires a provider when several are registered", async () => {
    const store = new InMemorySandboxStore();
    const manager = new SandboxManager({
      providers: [new MockSandboxProvider({ name: "a" }), new MockSandboxProvider({ name: "b" })],
      store,
    });
    await expect(manager.create({ spec: {} })).rejects.toThrow("No provider given");
    expect((await manager.create({ spec: {}, provider: "b" })).provider).toBe("b");
    await expect(manager.create({ spec: {}, provider: "c" })).rejects.toThrow('"c"');
  });
});

describe("SandboxManager lifecycle", () => {
  it("execs with the workdir as cwd and returns output", async () => {
    const { manager } = setup({ execHandler: ({ command, env }) => ({ stdout: `${command.cwd} ${env.NODE_ENV}` }) });
    const { id } = await manager.create({ spec: { env: { NODE_ENV: "test" } } });
    expect(await manager.exec(id, "pwd")).toEqual({ exitCode: 0, stdout: "/workspace test", stderr: "" });
  });

  it("stops, then auto-resumes on access by running the resume command", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    const stopped = await manager.stop(id);
    expect(stopped.status).toBe("stopped");
    expect(provider.getState(id)?.running).toBe(false);
    expect((await manager.stop(id)).status).toBe("stopped");

    const result = await manager.exec(id, "echo hi");
    expect(result.exitCode).toBe(0);
    expect((await manager.get(id)).status).toBe("running");
    expect(provider.callsFor(id, "wake")).toHaveLength(1);
    const launches = provider.callsFor(id, "startMainProcess").map((call) => call.command!.args[1]);
    expect(launches).toEqual(["npm start", "npm run resume"]);
  });

  it("relaunches start on resume when no resume command is given", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec: { start: "serve" } });
    await manager.stop(id);
    await manager.resume(id);
    const launches = provider.callsFor(id, "startMainProcess").map((call) => call.command!.args[1]);
    expect(launches).toEqual(["serve", "serve"]);
  });

  it("does not auto-resume when autoResume is off", async () => {
    const { manager } = setup({}, { autoResume: false });
    const { id } = await manager.create({ spec });
    await manager.stop(id);
    await expect(manager.exec(id, "ls")).rejects.toBeInstanceOf(SandboxStateError);
    expect((await manager.resume(id)).status).toBe("running");
  });

  it("detects a provider-side stop (e.g. a timeout) and resumes transparently", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    provider.simulateExternalStop(id);

    expect(await manager.getUrl(id, 3000)).toBe(`http://mock-${id}.mock.localhost:3000`);
    expect((await manager.get(id)).status).toBe("running");
    expect(provider.callsFor(id, "wake")).toHaveLength(1);
    expect(provider.callsFor(id, "startMainProcess")).toHaveLength(2);
  });

  it("resumes exactly once when many callers hit a stopped sandbox concurrently", async () => {
    const { manager, provider } = setup({ lifecycleDelayMs: 20 });
    const { id } = await manager.create({ spec });
    await manager.stop(id);

    const results = await Promise.all(Array.from({ length: 5 }, () => manager.exec(id, "echo hi")));
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    expect(provider.callsFor(id, "wake")).toHaveLength(1);
    expect((await manager.get(id)).status).toBe("running");
  });

  it("serializes concurrent stop and destroy", async () => {
    const { manager, provider } = setup({ lifecycleDelayMs: 10 });
    const { id } = await manager.create({ spec });
    const [stopped, destroyed] = await Promise.all([manager.stop(id), manager.destroy(id)]);
    expect(stopped.status).toBe("stopped");
    expect(destroyed.status).toBe("destroyed");
    expect(provider.callsFor(id, "stop")).toHaveLength(1);
    expect(provider.callsFor(id, "destroy")).toHaveLength(1);
  });

  it("marks the sandbox failed when resuming fails, and retries on explicit resume", async () => {
    let failWake = true;
    const { manager } = setup({
      beforeOperation: (operation) => {
        if (operation === "wake" && failWake) throw new Error("wake failed");
      },
    });
    const { id } = await manager.create({ spec });
    await manager.stop(id);
    await expect(manager.exec(id, "ls")).rejects.toThrow("wake failed");
    expect(await manager.get(id)).toMatchObject({ status: "failed", error: "wake failed" });

    failWake = false;
    expect(await manager.resume(id)).toMatchObject({ status: "running", error: null });
  });

  it("restores the running status when stop fails", async () => {
    const { manager } = setup({
      beforeOperation: (operation) => {
        if (operation === "stop") throw new Error("stop failed");
      },
    });
    const { id } = await manager.create({ spec });
    await expect(manager.stop(id)).rejects.toThrow("stop failed");
    expect(await manager.get(id)).toMatchObject({ status: "running", error: "stop failed" });
  });

  it("marks the sandbox failed when it vanished from the provider", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    provider.simulateExternalDelete(id);
    await expect(manager.exec(id, "ls")).rejects.toBeInstanceOf(ProviderSandboxMissingError);
    expect((await manager.get(id)).status).toBe("failed");
  });

  it("throws SandboxBusyError when another caller holds a transition too long", async () => {
    const { manager, store } = setup({}, { transitionTimeoutMs: 30 });
    const { id } = await manager.create({ spec });
    const record = await manager.get(id);
    await store.update(id, record.version, { status: "resuming" });
    await expect(manager.exec(id, "ls")).rejects.toBeInstanceOf(SandboxBusyError);
  });

  it("leaves records on unregistered providers untouched", async () => {
    const { manager, store } = setup();
    const { id } = await manager.create({ spec });
    const orphaned = new SandboxManager({ providers: [new MockSandboxProvider({ name: "other" })], store });
    await expect(orphaned.destroy(id)).rejects.toThrow('"mock"');
    await expect(orphaned.stop(id)).rejects.toThrow('"mock"');
    expect(await orphaned.reconcile()).toEqual([]);
    expect((await manager.get(id)).status).toBe("running");
  });

  it("keeps destroyed records, hidden from list by default", async () => {
    const { manager } = setup();
    const a = await manager.create({ spec, ownerId: "u1" });
    const b = await manager.create({ spec, ownerId: "u1", labels: { kind: "agent" } });
    await manager.destroy(a.id);

    expect((await manager.list({ ownerId: "u1" })).map((r) => r.id)).toEqual([b.id]);
    expect(await manager.list({ ownerId: "u1", includeDestroyed: true })).toHaveLength(2);
    expect((await manager.list({ labels: { kind: "agent" } })).map((r) => r.id)).toEqual([b.id]);
    await expect(manager.exec(a.id, "ls")).rejects.toBeInstanceOf(SandboxStateError);
    await expect(manager.get("sbx-nope")).rejects.toThrow("not found");
    expect(await manager.find("sbx-nope")).toBeNull();
  });
});

describe("SandboxManager files, URLs and logs", () => {
  it("writes and reads files relative to the workdir", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    await manager.writeFiles(id, [
      { path: "notes/a.txt", content: "hello" },
      { path: "/etc/b.bin", content: new Uint8Array([1, 2, 3]), mode: 0o600 },
    ]);
    expect([...provider.getState(id)!.files.keys()]).toEqual(["/workspace/notes/a.txt", "/etc/b.bin"]);
    expect(await manager.readTextFile(id, "notes/a.txt")).toBe("hello");
    expect(await manager.readFile(id, "/etc/b.bin")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await manager.readFile(id, "missing")).toBeNull();
  });

  it("only returns URLs for exposed ports", async () => {
    const { manager } = setup();
    const { id } = await manager.create({ spec });
    await expect(manager.getUrl(id, 8080)).rejects.toThrow("not exposed");
  });

  it("reads and follows the main process log", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    provider.appendMainLog(id, "line 1\n");
    expect(await manager.readLogs(id)).toBe("line 1\n");

    const controller = new AbortController();
    const chunks: string[] = [];
    const following = (async () => {
      for await (const chunk of manager.logs(id, { follow: true, signal: controller.signal, pollIntervalMs: 5 })) {
        chunks.push(chunk);
        if (chunks.join("").includes("line 3")) controller.abort();
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    provider.appendMainLog(id, "line 2\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    provider.appendMainLog(id, "line 3\n");
    await following;
    expect(chunks.join("")).toBe("line 1\nline 2\nline 3\n");
  });

  it("stops following logs when the sandbox stops, without resuming it", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    provider.appendMainLog(id, "hello\n");
    const chunks: string[] = [];
    const following = (async () => {
      for await (const chunk of manager.logs(id, { follow: true, pollIntervalMs: 5 })) chunks.push(chunk);
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.stop(id);
    await following;
    expect(chunks).toEqual(["hello\n"]);
    expect((await manager.get(id)).status).toBe("stopped");
    expect(provider.callsFor(id, "wake")).toHaveLength(0);
  });

  it("decodes multi-byte characters split across log reads", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    const bytes = new TextEncoder().encode("héllo ✓");
    const state = provider.getState(id)!;
    const chunks: string[] = [];
    state.log = bytes.slice(0, 2);
    const iterator = manager.logs(id, { follow: true, pollIntervalMs: 5 });
    chunks.push((await iterator.next()).value as string);
    state.log = bytes;
    chunks.push((await iterator.next()).value as string);
    await iterator.return();
    expect(chunks.join("")).toBe("héllo ✓");
  });

  it("reports the main process exit", async () => {
    const { manager, provider } = setup();
    const { id } = await manager.create({ spec });
    provider.exitMainProcess(id, 2);
    expect(await manager.getMainProcess(id)).toEqual({ pid: 100, running: false, exitCode: 2 });
  });
});

describe("SandboxManager timeouts and reconciliation", () => {
  it("sets expiresAt from timeoutMs, extends it, and stops expired sandboxes", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { manager, provider } = setup({}, { now: () => now });
    const { id, expiresAt } = await manager.create({ spec: { ...spec, timeoutMs: 60_000 } });
    expect(expiresAt).toEqual(new Date("2026-01-01T00:01:00Z"));

    const extended = await manager.extendTimeout(id, 30_000);
    expect(extended.expiresAt).toEqual(new Date("2026-01-01T00:01:30Z"));
    expect(provider.getState(id)?.timeoutExtensionsMs).toEqual([30_000]);

    const other = await manager.create({ spec: { timeoutMs: 600_000 } });
    now = new Date("2026-01-01T00:02:00Z");
    const stopped = await manager.stopExpired();
    expect(stopped.map((record) => record.id)).toEqual([id]);
    expect((await manager.get(id)).status).toBe("stopped");
    expect((await manager.get(other.id)).status).toBe("running");

    await manager.resume(id);
    expect((await manager.get(id)).expiresAt).toEqual(new Date("2026-01-01T00:03:00Z"));
  });

  it("reconciles records with what the provider reports", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { manager, provider, store } = setup({}, { now: () => now, transitionTimeoutMs: 60_000 });
    const stoppedExternally = await manager.create({ spec });
    const deletedExternally = await manager.create({ spec });
    const healthy = await manager.create({ spec });
    const stuck = await manager.create({ spec });
    provider.simulateExternalStop(stoppedExternally.id);
    provider.simulateExternalDelete(deletedExternally.id);
    await store.update(stuck.id, stuck.version, { status: "resuming" });

    const changed = await manager.reconcile();
    expect(changed.map((record) => [record.id, record.status]).sort()).toEqual(
      [
        [stoppedExternally.id, "stopped"],
        [deletedExternally.id, "failed"],
      ].sort(),
    );
    expect((await manager.get(healthy.id)).status).toBe("running");
    expect((await manager.get(stuck.id)).status).toBe("resuming");

    // The stuck transition is settled once it is older than the transition timeout.
    now = new Date(Date.now() + 120_000);
    const [settled] = await manager.reconcile([stuck.id]);
    expect(settled).toMatchObject({ status: "failed", error: "Interrupted while resuming" });
  });
});
