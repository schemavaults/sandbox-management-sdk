import { gitCloneCommand, normalizeCommand, resolveSandboxPath, validateSpec } from "./commands.js";
import {
  ProviderNotFoundError,
  ProviderSandboxMissingError,
  ProviderSandboxStoppedError,
  SandboxBusyError,
  SandboxCommandError,
  SandboxError,
  SandboxNotFoundError,
  SandboxStateError,
} from "./errors.js";
import { assertNetworkPolicySupported } from "./network.js";
import type { MainLogChunk, ProviderSandbox, SandboxProvider } from "./provider.js";
import type { SandboxListFilter, SandboxRecordPatch, SandboxStore } from "./store.js";
import { TRANSITIONAL_STATUSES } from "./types.js";
import type {
  CommandInput,
  ExecOptions,
  ExecResult,
  MainProcessInfo,
  NormalizedCommand,
  SandboxFile,
  SandboxRecord,
  SandboxSpec,
} from "./types.js";

export interface SandboxManagerOptions {
  providers: SandboxProvider[];
  store: SandboxStore;
  /** Provider used by `create` when none is given. Defaults to the only provider, if there is one. */
  defaultProvider?: string;
  /** Resume stopped sandboxes automatically when they are accessed. Default `true`. */
  autoResume?: boolean;
  /** How long to wait for another caller's in-flight transition. Default 10 minutes. */
  transitionTimeoutMs?: number;
  /** Poll interval while waiting for a transition. Default 250ms. */
  pollIntervalMs?: number;
  /** ID generator for new sandboxes. */
  generateId?: () => string;
  /** Clock, for tests. */
  now?: () => Date;
}

export interface CreateSandboxOptions extends Pick<ExecOptions, "onStdout" | "onStderr"> {
  spec: SandboxSpec;
  /** Provider name. Defaults to `defaultProvider`. */
  provider?: string;
  ownerId?: string | null;
  labels?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface LogsOptions {
  /** Keep polling for new output until `signal` aborts. Default `false`. */
  follow?: boolean;
  signal?: AbortSignal;
  /** Poll interval when following. Default 1000ms. */
  pollIntervalMs?: number;
}

const DEFAULT_TRANSITION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export function generateSandboxId(): string {
  return `sbx-${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Creates, lists and drives sandboxes across providers, keeping their state in
 * a `SandboxStore`. Safe to use from many processes at once: every status
 * change is a compare-and-set on the record's version.
 */
export class SandboxManager {
  private readonly providers = new Map<string, SandboxProvider>();
  private readonly store: SandboxStore;
  private readonly defaultProvider: string | undefined;
  private readonly autoResume: boolean;
  private readonly transitionTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(options: SandboxManagerOptions) {
    for (const provider of options.providers) {
      if (this.providers.has(provider.name)) {
        throw new SandboxError(`Duplicate sandbox provider name "${provider.name}"`);
      }
      this.providers.set(provider.name, provider);
    }
    this.store = options.store;
    this.defaultProvider =
      options.defaultProvider ?? (options.providers.length === 1 ? options.providers[0]?.name : undefined);
    this.autoResume = options.autoResume ?? true;
    this.transitionTimeoutMs = options.transitionTimeoutMs ?? DEFAULT_TRANSITION_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.generateId = options.generateId ?? generateSandboxId;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Create a sandbox, clone `spec.git`, run `spec.setup` and launch
   * `spec.start`. Resolves once the sandbox is running. On failure the record
   * is marked `failed` and the provider sandbox is kept for inspection; call
   * `destroy` to remove it.
   */
  async create(options: CreateSandboxOptions): Promise<SandboxRecord> {
    const providerName = options.provider ?? this.defaultProvider;
    if (!providerName) {
      throw new SandboxError("No provider given and no defaultProvider configured");
    }
    const provider = this.getProvider(providerName);
    validateSpec(options.spec);
    assertNetworkPolicySupported(provider, options.spec.network);

    const now = this.now();
    let record: SandboxRecord = {
      id: this.generateId(),
      provider: provider.name,
      providerRef: null,
      status: "provisioning",
      spec: structuredClone(options.spec),
      ownerId: options.ownerId ?? null,
      labels: { ...options.labels },
      metadata: structuredClone(options.metadata ?? {}),
      error: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
    };
    await this.store.insert(record);

    try {
      const workdir = this.workdirFor(record);
      const { providerRef } = await provider.create({
        id: record.id,
        spec: record.spec,
        workdir,
        ownerId: record.ownerId,
        labels: record.labels,
      });
      record = await this.mustUpdate(record, {
        providerRef,
        status: "setting_up",
        expiresAt: this.expiryFor(record.spec),
      });

      const sandbox = this.toProviderSandbox(record);
      if (record.spec.git) {
        await this.runStep(provider, sandbox, "git clone", gitCloneCommand(record.spec.git, workdir), options);
      }
      const setup = record.spec.setup === undefined ? [] : ([] as CommandInput[]).concat(record.spec.setup);
      for (const [index, step] of setup.entries()) {
        await this.runStep(provider, sandbox, `setup step ${index + 1}`, normalizeCommand(step, workdir), options);
      }

      record = await this.mustUpdate(record, { status: "starting" });
      if (record.spec.start) {
        await provider.startMainProcess(sandbox, normalizeCommand(record.spec.start, workdir));
      }
      return await this.mustUpdate(record, { status: "running" });
    } catch (error) {
      await this.markFailed(record, error);
      throw error;
    }
  }

  /** Resolves the record, or throws `SandboxNotFoundError`. */
  async get(id: string): Promise<SandboxRecord> {
    const record = await this.store.get(id);
    if (!record) throw new SandboxNotFoundError(id);
    return record;
  }

  /** Resolves the record, or `null` if it does not exist. */
  async find(id: string): Promise<SandboxRecord | null> {
    return this.store.get(id);
  }

  async list(filter?: SandboxListFilter): Promise<SandboxRecord[]> {
    return this.store.list(filter);
  }

  /** Run a one-shot command and wait for it to finish. A non-zero exit does not throw. */
  async exec(id: string, command: CommandInput, options?: ExecOptions): Promise<ExecResult> {
    return this.withRunning(id, "exec in", (provider, sandbox) =>
      provider.exec(sandbox, normalizeCommand(command, sandbox.workdir), options),
    );
  }

  /**
   * Wake a stopped sandbox and relaunch `spec.resume` (or `spec.start`) as its
   * main process. Also retries a `failed` sandbox that still has a provider
   * sandbox; `setup` is not re-run. No-op if it is already running.
   */
  async resume(id: string): Promise<SandboxRecord> {
    for (;;) {
      const record = await this.settle(id);
      if (record.status === "running") return record;
      const resumable = record.status === "stopped" || (record.status === "failed" && record.providerRef !== null);
      if (!resumable) throw new SandboxStateError(id, record.status, "resume");
      const resumed = await this.tryResume(record);
      if (resumed) return resumed;
    }
  }

  /** Stop a running sandbox, keeping its filesystem. No-op if it is already stopped. */
  async stop(id: string): Promise<SandboxRecord> {
    for (;;) {
      const record = await this.settle(id);
      if (record.status === "stopped") return record;
      if (record.status !== "running") throw new SandboxStateError(id, record.status, "stop");
      const provider = this.getProvider(record.provider);
      const claimed = await this.store.update(id, record.version, { status: "stopping" });
      if (!claimed) continue;
      try {
        await provider.stop(this.toProviderSandbox(claimed));
      } catch (error) {
        if (error instanceof ProviderSandboxMissingError) {
          await this.markFailed(claimed, error);
        } else {
          await this.store.update(id, claimed.version, { status: "running", error: errorMessage(error) });
        }
        throw error;
      }
      return this.mustUpdate(claimed, { status: "stopped", expiresAt: null });
    }
  }

  /** Delete the provider sandbox. The record is kept with status `destroyed`. */
  async destroy(id: string): Promise<SandboxRecord> {
    for (;;) {
      const record = await this.settle(id);
      if (record.status === "destroyed") return record;
      const provider = this.getProvider(record.provider);
      const claimed = await this.store.update(id, record.version, { status: "destroying" });
      if (!claimed) continue;
      try {
        if (claimed.providerRef) await provider.destroy(this.toProviderSandbox(claimed));
      } catch (error) {
        await this.markFailed(claimed, error);
        throw error;
      }
      return this.mustUpdate(claimed, { status: "destroyed", expiresAt: null });
    }
  }

  /** A URL that reaches `port` (which must be listed in `spec.ports`). */
  async getUrl(id: string, port: number): Promise<string> {
    return this.withRunning(id, "get a URL for", (provider, sandbox) => {
      if (!sandbox.spec.ports?.includes(port)) {
        throw new SandboxError(`Port ${port} is not exposed; add it to spec.ports`);
      }
      return provider.getUrl(sandbox, port);
    });
  }

  async writeFiles(id: string, files: SandboxFile[]): Promise<void> {
    const encoder = new TextEncoder();
    await this.withRunning(id, "write files to", (provider, sandbox) =>
      provider.writeFiles(
        sandbox,
        files.map((file) => ({
          path: resolveSandboxPath(sandbox.workdir, file.path),
          content: typeof file.content === "string" ? encoder.encode(file.content) : file.content,
          mode: file.mode ?? 0o644,
        })),
      ),
    );
  }

  /** Resolves the file's bytes, or `null` if it does not exist. */
  async readFile(id: string, path: string): Promise<Uint8Array | null> {
    return this.withRunning(id, "read files from", (provider, sandbox) =>
      provider.readFile(sandbox, resolveSandboxPath(sandbox.workdir, path)),
    );
  }

  async readTextFile(id: string, path: string): Promise<string | null> {
    const bytes = await this.readFile(id, path);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  /** State of the detached main process, or `null` if none was launched. */
  async getMainProcess(id: string): Promise<MainProcessInfo | null> {
    return this.withRunning(id, "inspect", (provider, sandbox) => provider.getMainProcess(sandbox));
  }

  /** The main process's full log so far. */
  async readLogs(id: string): Promise<string> {
    let output = "";
    for await (const chunk of this.logs(id)) output += chunk;
    return output;
  }

  /**
   * Stream the main process's log, from the beginning. Only the first read
   * auto-resumes a stopped sandbox; when following, the stream ends once the
   * sandbox stops or `signal` aborts.
   */
  async *logs(id: string, options: LogsOptions = {}): AsyncGenerator<string, void, void> {
    const decoder = new TextDecoder();
    let offset = 0;
    let first = true;
    for (;;) {
      if (options.signal?.aborted) break;
      const chunk = first
        ? await this.withRunning(id, "read logs of", (provider, sandbox) => provider.readMainLog(sandbox, offset))
        : await this.readMainLogIfRunning(id, offset);
      first = false;
      if (chunk === null) break;
      offset = chunk.nextOffset;
      if (chunk.data.length > 0) {
        yield decoder.decode(chunk.data, { stream: true });
        continue;
      }
      if (!options.follow) break;
      await sleep(options.pollIntervalMs ?? 1000, options.signal);
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  }

  /** Reads the log without resuming; `null` once the sandbox is no longer running. */
  private async readMainLogIfRunning(id: string, offset: number): Promise<MainLogChunk | null> {
    const record = await this.get(id);
    if (record.status !== "running") return null;
    try {
      return await this.getProvider(record.provider).readMainLog(this.toProviderSandbox(record), offset);
    } catch (error) {
      if (error instanceof ProviderSandboxStoppedError || error instanceof ProviderSandboxMissingError) return null;
      throw error;
    }
  }

  /** Push back the sandbox's expiry (and the provider's own timeout, if it has one). */
  async extendTimeout(id: string, durationMs: number): Promise<SandboxRecord> {
    await this.withRunning(id, "extend the timeout of", async (provider, sandbox) => {
      await provider.extendTimeout?.(sandbox, durationMs);
    });
    for (;;) {
      const record = await this.get(id);
      const base = Math.max(record.expiresAt?.getTime() ?? 0, this.now().getTime());
      const updated = await this.store.update(id, record.version, { expiresAt: new Date(base + durationMs) });
      if (updated) return updated;
    }
  }

  /**
   * Stop every running sandbox whose `expiresAt` has passed. Run this
   * periodically (e.g. from a cron job) for providers without native
   * timeouts, such as Docker.
   */
  async stopExpired(): Promise<SandboxRecord[]> {
    const now = this.now().getTime();
    const expired = (await this.store.list({ status: "running" })).filter(
      (record) => record.expiresAt !== null && record.expiresAt.getTime() <= now,
    );
    const stopped: SandboxRecord[] = [];
    for (const record of expired) {
      try {
        stopped.push(await this.stop(record.id));
      } catch {
        // Leave it for the next run; the error is recorded on the sandbox where possible.
      }
    }
    return stopped;
  }

  /**
   * Bring records in line with what the providers report: running sandboxes
   * the provider has stopped become `stopped`, vanished ones become `failed`,
   * and transitions abandoned for longer than the transition timeout (e.g. a
   * crashed process) are settled. Defaults to every non-destroyed sandbox;
   * sandboxes on unregistered providers, or whose provider errors, are
   * skipped. Resolves the records that changed.
   */
  async reconcile(ids?: string[]): Promise<SandboxRecord[]> {
    const records = ids
      ? (await Promise.all(ids.map((id) => this.store.get(id)))).filter((r): r is SandboxRecord => r !== null)
      : await this.store.list();
    const changed: SandboxRecord[] = [];
    for (const record of records) {
      const patch = await this.reconcilePatch(record).catch(() => null);
      if (!patch) continue;
      const updated = await this.store.update(record.id, record.version, patch);
      if (updated) changed.push(updated);
    }
    return changed;
  }

  private async reconcilePatch(record: SandboxRecord): Promise<SandboxRecordPatch | null> {
    if (record.status === "destroyed") return null;
    const stale =
      TRANSITIONAL_STATUSES.includes(record.status) &&
      this.now().getTime() - record.updatedAt.getTime() > this.transitionTimeoutMs;
    if (!record.providerRef) {
      return stale ? { status: "failed", error: `Interrupted while ${record.status}` } : null;
    }
    const provider = this.providers.get(record.provider);
    if (!provider) return null;
    const providerStatus = await provider.status(this.toProviderSandbox(record));
    if (providerStatus === "missing") {
      if (record.status === "destroying") return { status: "destroyed", expiresAt: null };
      if (record.status === "failed") return null;
      if (TRANSITIONAL_STATUSES.includes(record.status) && !stale) return null;
      return { status: "failed", error: "Sandbox no longer exists on the provider" };
    }
    if (record.status === "running" && providerStatus === "stopped") {
      return { status: "stopped", expiresAt: null };
    }
    if (stale) {
      if (record.status === "stopping" && providerStatus === "stopped") {
        return { status: "stopped", expiresAt: null };
      }
      return { status: "failed", error: `Interrupted while ${record.status}` };
    }
    return null;
  }

  /** Runs `fn` against a running sandbox, auto-resuming it if it is (or turns out to be) stopped. */
  private async withRunning<T>(
    id: string,
    operation: string,
    fn: (provider: SandboxProvider, sandbox: ProviderSandbox) => Promise<T>,
  ): Promise<T> {
    let record = await this.ensureRunning(id, operation);
    let provider = this.getProvider(record.provider);
    try {
      return await fn(provider, this.toProviderSandbox(record));
    } catch (error) {
      if (error instanceof ProviderSandboxMissingError) {
        await this.markFailed(record, error);
        throw error;
      }
      if (!(error instanceof ProviderSandboxStoppedError)) throw error;
      // Stopped behind our back, e.g. by a provider-side timeout.
      await this.store.update(id, record.version, { status: "stopped", expiresAt: null });
      record = await this.ensureRunning(id, operation);
      provider = this.getProvider(record.provider);
      return await fn(provider, this.toProviderSandbox(record));
    }
  }

  private async ensureRunning(id: string, operation: string): Promise<SandboxRecord> {
    for (;;) {
      const record = await this.settle(id);
      if (record.status === "running") return record;
      if (record.status !== "stopped" || !this.autoResume) {
        throw new SandboxStateError(id, record.status, operation);
      }
      const resumed = await this.tryResume(record);
      if (resumed) return resumed;
    }
  }

  /** Claims the record for resuming. Resolves `null` if another caller claimed it first. */
  private async tryResume(record: SandboxRecord): Promise<SandboxRecord | null> {
    const provider = this.getProvider(record.provider);
    const claimed = await this.store.update(record.id, record.version, { status: "resuming", error: null });
    if (!claimed) return null;
    try {
      const sandbox = this.toProviderSandbox(claimed);
      await provider.wake(sandbox);
      const command = claimed.spec.resume ?? claimed.spec.start;
      if (command) {
        await provider.startMainProcess(sandbox, normalizeCommand(command, sandbox.workdir));
      }
      return await this.mustUpdate(claimed, { status: "running", expiresAt: this.expiryFor(claimed.spec) });
    } catch (error) {
      await this.markFailed(claimed, error);
      throw error;
    }
  }

  /** Waits until the record is not in a transitional status. */
  private async settle(id: string): Promise<SandboxRecord> {
    const deadline = Date.now() + this.transitionTimeoutMs;
    for (;;) {
      const record = await this.get(id);
      if (!TRANSITIONAL_STATUSES.includes(record.status)) return record;
      if (Date.now() >= deadline) throw new SandboxBusyError(id, record.status);
      await sleep(this.pollIntervalMs);
    }
  }

  private async runStep(
    provider: SandboxProvider,
    sandbox: ProviderSandbox,
    step: string,
    command: NormalizedCommand,
    options: Pick<ExecOptions, "onStdout" | "onStderr">,
  ): Promise<void> {
    const result = await provider.exec(sandbox, command, {
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
    if (result.exitCode !== 0) throw new SandboxCommandError(step, result);
  }

  /** Update that must succeed because this caller holds the record's transitional status. */
  private async mustUpdate(record: SandboxRecord, patch: SandboxRecordPatch): Promise<SandboxRecord> {
    const updated = await this.store.update(record.id, record.version, patch);
    if (!updated) {
      throw new SandboxError(`Sandbox "${record.id}" was modified concurrently while ${record.status}`);
    }
    return updated;
  }

  private async markFailed(record: SandboxRecord, error: unknown): Promise<void> {
    await this.store
      .update(record.id, record.version, { status: "failed", error: errorMessage(error) })
      .catch(() => null);
  }

  private getProvider(name: string): SandboxProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new ProviderNotFoundError(name);
    return provider;
  }

  private workdirFor(record: SandboxRecord): string {
    return record.spec.workdir ?? this.getProvider(record.provider).defaultWorkdir;
  }

  private toProviderSandbox(record: SandboxRecord): ProviderSandbox {
    if (!record.providerRef) {
      throw new SandboxError(`Sandbox "${record.id}" has no provider sandbox`);
    }
    return { id: record.id, providerRef: record.providerRef, spec: record.spec, workdir: this.workdirFor(record) };
  }

  private expiryFor(spec: SandboxSpec): Date | null {
    return spec.timeoutMs === undefined ? null : new Date(this.now().getTime() + spec.timeoutMs);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
