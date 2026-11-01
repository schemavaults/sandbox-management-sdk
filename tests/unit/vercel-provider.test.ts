import { describe, expect, it } from "bun:test";
import type { NetworkPolicy } from "@vercel/sandbox";
import { ProviderSandboxStoppedError, SandboxManager } from "../../src/index.js";
import type { SandboxNetworkPolicy } from "../../src/index.js";
import { InMemorySandboxStore } from "../../src/testing/index.js";
import { VercelSandboxProvider, toVercelNetworkPolicy } from "../../src/vercel/index.js";
import type {
  VercelRunCommandParams,
  VercelSandboxApi,
  VercelSandboxInstance,
} from "../../src/vercel/index.js";

type CommandHandler = (params: VercelRunCommandParams) => { exitCode?: number; stdout?: string; stderr?: string };

class FakeVercelSandbox implements VercelSandboxInstance {
  status = "running";
  readonly commands: VercelRunCommandParams[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly extensions: number[] = [];

  constructor(
    readonly name: string,
    readonly params: Record<string, unknown>,
    private readonly handler: CommandHandler,
  ) {}

  async runCommand(params: VercelRunCommandParams) {
    if (this.status !== "running") throw new Error("fake: command on a stopped sandbox");
    this.commands.push(params);
    const result = params.detached ? {} : this.handler(params);
    if (result.stdout) params.stdout?.write(result.stdout);
    if (result.stderr) params.stderr?.write(result.stderr);
    return { exitCode: result.exitCode ?? 0 };
  }

  async writeFiles(files: { path: string; content: Uint8Array }[]) {
    for (const file of files) this.files.set(file.path, file.content);
  }

  async readFileToBuffer({ path }: { path: string }) {
    return this.files.get(path) ?? null;
  }

  domain(port: number) {
    return `https://${this.name}-${port}.vercel.run`;
  }

  async stop() {
    this.status = "stopped";
  }

  async delete() {
    this.status = "deleted";
  }

  async extendTimeout(durationMs: number) {
    this.extensions.push(durationMs);
  }
}

class FakeVercelApi implements VercelSandboxApi {
  readonly sandboxes = new Map<string, FakeVercelSandbox>();
  readonly getCalls: Record<string, unknown>[] = [];
  /** Answers non-detached commands; the default (exit 0) also satisfies the main-process PID-file poll. */
  handler: CommandHandler = () => ({});

  async create(params: Record<string, unknown>) {
    const sandbox = new FakeVercelSandbox(String(params.name), params, (p) => this.handler(p));
    this.sandboxes.set(sandbox.name, sandbox);
    return sandbox;
  }

  async get(params: { name: string; resume?: boolean }) {
    this.getCalls.push(params);
    const sandbox = this.sandboxes.get(params.name);
    if (!sandbox || sandbox.status === "deleted") {
      throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
    }
    if (params.resume && sandbox.status === "stopped") sandbox.status = "running";
    return sandbox;
  }
}

const credentials = { token: "tok", teamId: "team", projectId: "proj" };

function setup() {
  const api = new FakeVercelApi();
  const provider = new VercelSandboxProvider({ api, credentials, defaultImage: "vercel/sandbox/universal" });
  const manager = new SandboxManager({ providers: [provider], store: new InMemorySandboxStore(), pollIntervalMs: 5 });
  return { api, provider, manager };
}

describe("VercelSandboxProvider", () => {
  it("creates a persistent sandbox named after the SDK id, with credentials and spec options", async () => {
    const { api, manager } = setup();
    const record = await manager.create({
      spec: {
        env: { A: "1" },
        ports: [3000],
        timeoutMs: 600_000,
        resources: { vcpus: 2 },
        setup: "npm ci",
        start: "npm run dev",
        providerOptions: { vercel: { region: "sfo1", tags: { app: "x" } } },
      },
    });
    expect(record.provider).toBe("vercel");
    expect(record.providerRef).toBe(record.id);

    const sandbox = api.sandboxes.get(record.id)!;
    expect(sandbox.params).toMatchObject({
      ...credentials,
      name: record.id,
      persistent: true,
      image: "vercel/sandbox/universal",
      ports: [3000],
      timeout: 600_000,
      resources: { vcpus: 2 },
      env: { A: "1" },
      region: "sfo1",
      tags: { app: "x" },
    });
    expect(api.getCalls.every((call) => call.token === "tok" && call.resume === false)).toBe(true);

    const setupCommand = sandbox.commands.find((c) => c.args?.[1] === "npm ci");
    expect(setupCommand).toMatchObject({ cmd: "sh", cwd: "/vercel/sandbox" });
    const launcher = sandbox.commands.find((c) => c.detached);
    expect(launcher?.args?.[1]).toContain("'npm run dev'");
  });

  it("uses runtime instead of the default image when the spec asks for one", async () => {
    const { api, manager } = setup();
    const { id } = await manager.create({ spec: { providerOptions: { vercel: { runtime: "node24" } } } });
    const params = api.sandboxes.get(id)!.params;
    expect(params.runtime).toBe("node24");
    expect(params.image).toBeUndefined();
  });

  it("creates a custom workdir", async () => {
    const { api, manager } = setup();
    const { id } = await manager.create({ spec: { workdir: "/home/app" } });
    expect(api.sandboxes.get(id)!.commands[0]).toMatchObject({ cmd: "mkdir", args: ["-p", "/home/app"] });
  });

  it("streams and returns exec output", async () => {
    const { api, manager } = setup();
    const { id } = await manager.create({ spec: {} });
    api.handler = (params) => (params.args?.[1] === "make" ? { exitCode: 2, stdout: "building\n", stderr: "oops\n" } : {});
    let streamed = "";
    const result = await manager.exec(id, "make", { onStdout: (chunk) => (streamed += chunk) });
    expect(result).toEqual({ exitCode: 2, stdout: "building\n", stderr: "oops\n" });
    expect(streamed).toBe("building\n");
  });

  it("reports a sandbox Vercel stopped instead of letting the SDK resume it silently", async () => {
    const { api, provider, manager } = setup();
    const record = await manager.create({ spec: { start: "serve" } });
    const sandbox = api.sandboxes.get(record.id)!;
    sandbox.status = "stopped"; // e.g. the Vercel timeout elapsed

    const providerSandbox = { id: record.id, providerRef: record.id, spec: record.spec, workdir: "/vercel/sandbox" };
    await expect(provider.exec(providerSandbox, { cmd: "ls", args: [], cwd: "/", env: {} })).rejects.toBeInstanceOf(
      ProviderSandboxStoppedError,
    );
    expect(await provider.status(providerSandbox)).toBe("stopped");

    // The manager notices, resumes via Sandbox.get({ resume: true }) and relaunches the main process.
    expect((await manager.exec(record.id, "ls")).exitCode).toBe(0);
    expect(api.getCalls.filter((call) => call.resume === true)).toHaveLength(1);
    expect(sandbox.commands.filter((c) => c.detached)).toHaveLength(2);
    expect((await manager.get(record.id)).status).toBe("running");
  });

  it("stops, resumes and destroys", async () => {
    const { api, manager } = setup();
    const { id } = await manager.create({ spec: {} });
    await manager.stop(id);
    expect(api.sandboxes.get(id)!.status).toBe("stopped");
    await manager.resume(id);
    expect(api.sandboxes.get(id)!.status).toBe("running");
    await manager.destroy(id);
    expect(api.sandboxes.get(id)!.status).toBe("deleted");
  });

  it("treats a missing sandbox as already destroyed, and reconciles it as failed", async () => {
    const { api, manager } = setup();
    const a = await manager.create({ spec: {} });
    const b = await manager.create({ spec: {} });
    api.sandboxes.delete(a.id);
    api.sandboxes.delete(b.id);
    expect((await manager.destroy(a.id)).status).toBe("destroyed");
    const [reconciled] = await manager.reconcile([b.id]);
    expect(reconciled?.status).toBe("failed");
  });

  it("writes files (creating parent directories), reads them back and returns port URLs", async () => {
    const { api, manager } = setup();
    const { id } = await manager.create({ spec: { ports: [3000] } });
    await manager.writeFiles(id, [{ path: "src/a.txt", content: "A" }]);
    const sandbox = api.sandboxes.get(id)!;
    expect(sandbox.commands.at(-1)).toMatchObject({ cmd: "mkdir", args: ["-p", "/vercel/sandbox/src"] });
    expect(await manager.readTextFile(id, "src/a.txt")).toBe("A");
    expect(await manager.readFile(id, "nope")).toBeNull();
    expect(await manager.getUrl(id, 3000)).toBe(`https://${id}-3000.vercel.run`);
  });

  it("extends the native timeout", async () => {
    const { api, manager } = setup();
    const { id } = await manager.create({ spec: { timeoutMs: 60_000 } });
    await manager.extendTimeout(id, 30_000);
    expect(api.sandboxes.get(id)!.extensions).toEqual([30_000]);
  });

  it("maps spec.network onto the native network policy", async () => {
    const { api, manager } = setup();
    const policyFor = async (network: SandboxNetworkPolicy | undefined) => {
      const { id } = await manager.create({ spec: { network } });
      return api.sandboxes.get(id)!.params.networkPolicy;
    };
    expect(await policyFor(undefined)).toBeUndefined();
    expect(await policyFor("allow-all")).toBe("allow-all");
    expect(await policyFor("deny-all")).toBe("deny-all");
    expect(await policyFor({})).toBe("deny-all");
    expect(await policyFor({ denyCidrs: ["10.0.0.0/8"] })).toBe("deny-all");
    expect(await policyFor({ allowDomains: ["github.com", "*.npmjs.org"] })).toEqual({ allow: ["github.com", "*.npmjs.org"] });
    expect(
      await policyFor({
        allowDomains: ["api.example.com"],
        allowCidrs: ["203.0.113.10", "2001:db8::1", "198.51.100.0/24"],
        denyCidrs: ["169.254.169.254"],
      }),
    ).toEqual({
      allow: ["api.example.com"],
      subnets: { allow: ["203.0.113.10/32", "2001:db8::1/128", "198.51.100.0/24"], deny: ["169.254.169.254/32"] },
    });
    expect(await policyFor({ allowCidrs: ["203.0.113.10"] })).toEqual({ allow: [], subnets: { allow: ["203.0.113.10/32"] } });
  });

  it("produces policies that type-check as @vercel/sandbox NetworkPolicy values", () => {
    const networks: SandboxNetworkPolicy[] = ["allow-all", "deny-all", {}, { allowDomains: ["a.com"], allowCidrs: ["10.0.0.1"], denyCidrs: ["10.0.0.0/8"] }];
    const policies: NetworkPolicy[] = networks.map(toVercelNetworkPolicy);
    expect(policies).toHaveLength(4);
  });

  it("passes providerOptions.vercel.networkPolicy through, but not together with spec.network", async () => {
    const { api, manager } = setup();
    const native = { allow: { "api.example.com": [{ transform: [{ headers: { authorization: "Bearer x" } }] }] } };
    const { id } = await manager.create({ spec: { providerOptions: { vercel: { networkPolicy: native } } } });
    expect(api.sandboxes.get(id)!.params.networkPolicy).toEqual(native);

    await expect(
      manager.create({ spec: { network: "deny-all", providerOptions: { vercel: { networkPolicy: native } } } }),
    ).rejects.toThrow("Set spec.network or spec.providerOptions.vercel.networkPolicy, not both");
  });
});
