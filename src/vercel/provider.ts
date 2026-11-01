import type { Writable } from "node:stream";
import { posix } from "node:path";
import { ProviderSandboxMissingError, ProviderSandboxStoppedError, SandboxError } from "../errors.js";
import { outputCollector } from "../internal/output.js";
import { normalizeCidr } from "../network.js";
import type {
  MainLogChunk,
  ProviderCreateInput,
  ProviderCreateResult,
  ProviderSandbox,
  ProviderSandboxStatus,
  ResolvedSandboxFile,
  SandboxProvider,
} from "../provider.js";
import { shellGetMainProcess, shellReadMainLog, shellStartMainProcess } from "../shell-main-process.js";
import type { ExecOptions, ExecResult, MainProcessInfo, NormalizedCommand, SandboxNetworkPolicy } from "../types.js";

/** Per-sandbox options, set as `spec.providerOptions.vercel`. */
export interface VercelSandboxOptions {
  /** Vercel Container Registry image, e.g. `"vercel/sandbox/universal"`. */
  image?: string;
  /** Legacy managed runtime, e.g. `"node24"`. Ignored when `image` is set. */
  runtime?: string;
  /** Region, e.g. `"iad1"`. */
  region?: string;
  /**
   * Passed to `@vercel/sandbox` as-is, for what `spec.network` cannot express
   * (per-domain request rules, header injection). Cannot be combined with `spec.network`.
   */
  networkPolicy?: unknown;
  /** Up to 5 key/value tags. */
  tags?: Record<string, string>;
}

declare module "../types.js" {
  interface SandboxProviderOptions {
    vercel?: VercelSandboxOptions;
  }
}

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

export interface VercelRunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The subset of a `@vercel/sandbox` `Sandbox` instance this provider uses. */
export interface VercelSandboxInstance {
  readonly name: string;
  /** Status of the current session: `pending`, `running`, `stopping`, `stopped`, ... */
  readonly status: string;
  runCommand(params: VercelRunCommandParams): Promise<{ exitCode: number | null }>;
  writeFiles(files: { path: string; content: Uint8Array; mode?: number }[]): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Uint8Array | null>;
  domain(port: number): string;
  stop(): Promise<unknown>;
  delete(): Promise<unknown>;
  extendTimeout(durationMs: number): Promise<void>;
}

/** The subset of the `@vercel/sandbox` `Sandbox` class this provider uses. */
export interface VercelSandboxApi {
  create(params: Record<string, unknown>): Promise<VercelSandboxInstance>;
  get(params: { name: string; resume?: boolean } & Record<string, unknown>): Promise<VercelSandboxInstance>;
}

export interface VercelSandboxProviderOptions {
  /** Provider name used in sandbox records. Default `"vercel"`. */
  name?: string;
  /** Access-token credentials. Omit to use Vercel OIDC (`VERCEL_OIDC_TOKEN`). */
  credentials?: VercelCredentials;
  /** Sandbox API; defaults to `Sandbox` from `@vercel/sandbox`. Inject a fake in tests. */
  api?: VercelSandboxApi;
  /** Image used when the spec sets neither `image` nor `runtime`. */
  defaultImage?: string;
  defaultRegion?: string;
}

export const VERCEL_DEFAULT_WORKDIR = "/vercel/sandbox";
const RUNNING_STATUSES = new Set(["pending", "running"]);

/**
 * Runs each sandbox as a persistent Vercel Sandbox: `stop` snapshots the
 * filesystem and `wake` restores it. `spec.timeoutMs` maps to the native
 * sandbox timeout (Vercel stops the sandbox itself when it expires).
 */
export class VercelSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly defaultWorkdir = VERCEL_DEFAULT_WORKDIR;
  readonly networkPolicies = ["deny-all", "allowlist"] as const;
  private readonly credentials: Partial<VercelCredentials>;
  private readonly defaultImage: string | undefined;
  private readonly defaultRegion: string | undefined;
  private apiPromise: Promise<VercelSandboxApi> | undefined;

  constructor(options: VercelSandboxProviderOptions = {}) {
    this.name = options.name ?? "vercel";
    this.credentials = options.credentials ?? {};
    this.defaultImage = options.defaultImage;
    this.defaultRegion = options.defaultRegion;
    if (options.api) this.apiPromise = Promise.resolve(options.api);
  }

  async create(input: ProviderCreateInput): Promise<ProviderCreateResult> {
    const options = input.spec.providerOptions?.vercel ?? {};
    if (input.spec.network !== undefined && options.networkPolicy !== undefined) {
      throw new SandboxError("Set spec.network or spec.providerOptions.vercel.networkPolicy, not both");
    }
    const image = options.image ?? (options.runtime ? undefined : this.defaultImage);
    const api = await this.api();
    const sandbox = await api.create({
      ...this.credentials,
      name: input.id,
      persistent: true,
      ...(image ? { image } : options.runtime ? { runtime: options.runtime } : {}),
      ports: input.spec.ports,
      timeout: input.spec.timeoutMs,
      resources: input.spec.resources?.vcpus ? { vcpus: input.spec.resources.vcpus } : undefined,
      env: input.spec.env,
      tags: options.tags,
      region: options.region ?? this.defaultRegion,
      networkPolicy: input.spec.network === undefined ? options.networkPolicy : toVercelNetworkPolicy(input.spec.network),
    });
    if (input.workdir !== VERCEL_DEFAULT_WORKDIR) {
      const result = await sandbox.runCommand({ cmd: "mkdir", args: ["-p", input.workdir] });
      if (result.exitCode !== 0) {
        await sandbox.delete().catch(() => undefined);
        throw new SandboxError(`Failed to create workdir ${input.workdir}`);
      }
    }
    return { providerRef: sandbox.name };
  }

  async wake(sandbox: ProviderSandbox): Promise<void> {
    await this.connect(sandbox, { resume: true });
  }

  async stop(sandbox: ProviderSandbox): Promise<void> {
    const instance = await this.connect(sandbox);
    if (RUNNING_STATUSES.has(instance.status)) await instance.stop();
  }

  async destroy(sandbox: ProviderSandbox): Promise<void> {
    try {
      await (await this.connect(sandbox)).delete();
    } catch (error) {
      if (!(error instanceof ProviderSandboxMissingError) && !isNotFound(error)) throw error;
    }
  }

  async status(sandbox: ProviderSandbox): Promise<ProviderSandboxStatus> {
    try {
      const instance = await this.connect(sandbox);
      return RUNNING_STATUSES.has(instance.status) ? "running" : "stopped";
    } catch (error) {
      if (error instanceof ProviderSandboxMissingError) return "missing";
      throw error;
    }
  }

  async exec(sandbox: ProviderSandbox, command: NormalizedCommand, options: ExecOptions = {}): Promise<ExecResult> {
    const instance = await this.connectRunning(sandbox);
    return this.run(instance, command, options);
  }

  async startMainProcess(sandbox: ProviderSandbox, command: NormalizedCommand): Promise<void> {
    const instance = await this.connectRunning(sandbox);
    await shellStartMainProcess(
      (cmd) => this.run(instance, cmd),
      async (launcher) => {
        await instance.runCommand({ cmd: launcher.cmd, args: launcher.args, cwd: launcher.cwd, detached: true });
      },
      command,
    );
  }

  async getMainProcess(sandbox: ProviderSandbox): Promise<MainProcessInfo | null> {
    const instance = await this.connectRunning(sandbox);
    return shellGetMainProcess((cmd) => this.run(instance, cmd));
  }

  async readMainLog(sandbox: ProviderSandbox, offset: number): Promise<MainLogChunk> {
    const instance = await this.connectRunning(sandbox);
    return shellReadMainLog((cmd) => this.run(instance, cmd), offset);
  }

  async writeFiles(sandbox: ProviderSandbox, files: ResolvedSandboxFile[]): Promise<void> {
    const instance = await this.connectRunning(sandbox);
    const dirs = [...new Set(files.map((file) => posix.dirname(file.path)))];
    const mkdir = await instance.runCommand({ cmd: "mkdir", args: ["-p", ...dirs] });
    if (mkdir.exitCode !== 0) throw new SandboxError(`Failed to create directories ${dirs.join(", ")}`);
    await instance.writeFiles(files.map((file) => ({ path: file.path, content: file.content, mode: file.mode })));
  }

  async readFile(sandbox: ProviderSandbox, path: string): Promise<Uint8Array | null> {
    const instance = await this.connectRunning(sandbox);
    const buffer = await instance.readFileToBuffer({ path });
    return buffer === null ? null : new Uint8Array(buffer);
  }

  async getUrl(sandbox: ProviderSandbox, port: number): Promise<string> {
    const instance = await this.connectRunning(sandbox);
    return instance.domain(port);
  }

  async extendTimeout(sandbox: ProviderSandbox, durationMs: number): Promise<void> {
    const instance = await this.connectRunning(sandbox);
    await instance.extendTimeout(durationMs);
  }

  private async run(instance: VercelSandboxInstance, command: NormalizedCommand, options: ExecOptions = {}) {
    const stdout = outputCollector(options.onStdout);
    const stderr = outputCollector(options.onStderr);
    const result = await instance.runCommand({
      cmd: command.cmd,
      args: command.args,
      cwd: command.cwd,
      env: command.env,
      stdout: stdout.writable,
      stderr: stderr.writable,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return { exitCode: result.exitCode ?? -1, stdout: stdout.finish(), stderr: stderr.finish() };
  }

  private async connect(sandbox: ProviderSandbox, { resume = false } = {}): Promise<VercelSandboxInstance> {
    const api = await this.api();
    try {
      return await api.get({ ...this.credentials, name: sandbox.providerRef, resume });
    } catch (error) {
      if (isNotFound(error)) throw new ProviderSandboxMissingError(sandbox.providerRef);
      throw error;
    }
  }

  /** Connects without resuming, so a sandbox Vercel stopped (e.g. on timeout) is reported, not silently resumed. */
  private async connectRunning(sandbox: ProviderSandbox): Promise<VercelSandboxInstance> {
    const instance = await this.connect(sandbox);
    if (!RUNNING_STATUSES.has(instance.status)) throw new ProviderSandboxStoppedError(sandbox.providerRef);
    return instance;
  }

  private api(): Promise<VercelSandboxApi> {
    this.apiPromise ??= import("@vercel/sandbox").then(({ Sandbox }) => ({
      create: (params) => Sandbox.create(params as never) as unknown as Promise<VercelSandboxInstance>,
      get: (params) => Sandbox.get(params as never) as unknown as Promise<VercelSandboxInstance>,
    }));
    return this.apiPromise;
  }
}

/** The `@vercel/sandbox` `NetworkPolicy` shapes `spec.network` maps onto. */
type VercelNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | { allow: string[]; subnets?: { allow?: string[]; deny?: string[] } };

/** Maps `spec.network` onto a `@vercel/sandbox` network policy. */
export function toVercelNetworkPolicy(policy: SandboxNetworkPolicy): VercelNetworkPolicy {
  if (typeof policy === "string") return policy;
  const allow = policy.allowDomains ?? [];
  const allowCidrs = (policy.allowCidrs ?? []).map(normalizeCidr);
  const denyCidrs = (policy.denyCidrs ?? []).map(normalizeCidr);
  if (allow.length === 0 && allowCidrs.length === 0) return "deny-all";
  if (allowCidrs.length === 0 && denyCidrs.length === 0) return { allow };
  return {
    allow,
    subnets: {
      ...(allowCidrs.length > 0 && { allow: allowCidrs }),
      ...(denyCidrs.length > 0 && { deny: denyCidrs }),
    },
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const response = (error as { response?: { status?: number } }).response;
  return response?.status === 404;
}
