import { ProviderSandboxMissingError, ProviderSandboxStoppedError, SandboxError } from "../errors.js";
import type {
  MainLogChunk,
  ProviderCreateInput,
  ProviderCreateResult,
  ProviderSandbox,
  ProviderSandboxStatus,
  ResolvedSandboxFile,
  SandboxProvider,
} from "../provider.js";
import type { ExecOptions, ExecResult, MainProcessInfo, NormalizedCommand, SandboxSpec } from "../types.js";

export type MockOperation =
  | "create"
  | "wake"
  | "stop"
  | "destroy"
  | "exec"
  | "startMainProcess"
  | "writeFiles"
  | "readFile"
  | "getUrl"
  | "extendTimeout";

export interface MockCall {
  operation: MockOperation;
  sandboxId: string;
  command?: NormalizedCommand;
}

export interface MockExecContext {
  sandboxId: string;
  command: NormalizedCommand;
  /** `spec.env` merged with the command's env. */
  env: Record<string, string>;
}

/** Answers `exec` calls. Returning nothing means exit code 0 with no output. */
export type MockExecHandler = (
  context: MockExecContext,
) => Partial<ExecResult> | void | Promise<Partial<ExecResult> | void>;

export interface MockMainProcess {
  command: NormalizedCommand;
  pid: number;
  running: boolean;
  exitCode: number | null;
}

export interface MockSandboxState {
  sandboxId: string;
  providerRef: string;
  spec: SandboxSpec;
  workdir: string;
  running: boolean;
  files: Map<string, Uint8Array>;
  mainProcess: MockMainProcess | null;
  /** Main process output, appended across restarts like a real log file. */
  log: Uint8Array;
  timeoutExtensionsMs: number[];
}

export interface MockSandboxProviderOptions {
  /** Default `"mock"`. */
  name?: string;
  /** Default `"/workspace"`. */
  defaultWorkdir?: string;
  execHandler?: MockExecHandler;
  /** Simulated latency for create / wake / stop / destroy, in ms. Default 0. */
  lifecycleDelayMs?: number;
  /** Called before every operation; throw from it to inject failures. */
  beforeOperation?: (operation: MockOperation, sandboxId: string) => void | Promise<void>;
}

/**
 * An in-memory provider for tests. Nothing is executed: `exec` calls are
 * answered by `execHandler` and recorded in `calls`, files live in memory,
 * and stop / wake / external stops are simulated.
 */
export class MockSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly defaultWorkdir: string;
  readonly calls: MockCall[] = [];
  private readonly sandboxes = new Map<string, MockSandboxState>();
  private execHandler: MockExecHandler;
  private readonly lifecycleDelayMs: number;
  private readonly beforeOperation: MockSandboxProviderOptions["beforeOperation"];
  private nextPid = 100;

  constructor(options: MockSandboxProviderOptions = {}) {
    this.name = options.name ?? "mock";
    this.defaultWorkdir = options.defaultWorkdir ?? "/workspace";
    this.execHandler = options.execHandler ?? (() => undefined);
    this.lifecycleDelayMs = options.lifecycleDelayMs ?? 0;
    this.beforeOperation = options.beforeOperation;
  }

  setExecHandler(handler: MockExecHandler): void {
    this.execHandler = handler;
  }

  /** State of a sandbox by SDK sandbox ID. */
  getState(sandboxId: string): MockSandboxState | undefined {
    return [...this.sandboxes.values()].find((state) => state.sandboxId === sandboxId);
  }

  /** Calls recorded for one sandbox, optionally of one operation. */
  callsFor(sandboxId: string, operation?: MockOperation): MockCall[] {
    return this.calls.filter(
      (call) => call.sandboxId === sandboxId && (operation === undefined || call.operation === operation),
    );
  }

  /** Simulate the provider stopping a sandbox on its own, e.g. a provider-side timeout. */
  simulateExternalStop(sandboxId: string): void {
    const state = this.mustGetState(sandboxId);
    state.running = false;
    if (state.mainProcess) state.mainProcess.running = false;
  }

  /** Simulate the sandbox being deleted outside the SDK. */
  simulateExternalDelete(sandboxId: string): void {
    this.sandboxes.delete(this.mustGetState(sandboxId).providerRef);
  }

  /** Append output to the main process log. */
  appendMainLog(sandboxId: string, text: string): void {
    const state = this.mustGetState(sandboxId);
    const added = new TextEncoder().encode(text);
    const log = new Uint8Array(state.log.length + added.length);
    log.set(state.log);
    log.set(added, state.log.length);
    state.log = log;
  }

  /** Simulate the main process exiting with `exitCode`. */
  exitMainProcess(sandboxId: string, exitCode: number): void {
    const state = this.mustGetState(sandboxId);
    if (!state.mainProcess) throw new SandboxError(`Sandbox "${sandboxId}" has no main process`);
    state.mainProcess.running = false;
    state.mainProcess.exitCode = exitCode;
  }

  async create(input: ProviderCreateInput): Promise<ProviderCreateResult> {
    await this.record("create", input.id);
    await this.delay();
    const providerRef = `mock-${input.id}`;
    this.sandboxes.set(providerRef, {
      sandboxId: input.id,
      providerRef,
      spec: input.spec,
      workdir: input.workdir,
      running: true,
      files: new Map(),
      mainProcess: null,
      log: new Uint8Array(),
      timeoutExtensionsMs: [],
    });
    return { providerRef };
  }

  async wake(sandbox: ProviderSandbox): Promise<void> {
    await this.record("wake", sandbox.id);
    await this.delay();
    this.lookup(sandbox).running = true;
  }

  async stop(sandbox: ProviderSandbox): Promise<void> {
    await this.record("stop", sandbox.id);
    await this.delay();
    const state = this.lookup(sandbox);
    state.running = false;
    if (state.mainProcess) state.mainProcess.running = false;
  }

  async destroy(sandbox: ProviderSandbox): Promise<void> {
    await this.record("destroy", sandbox.id);
    await this.delay();
    this.sandboxes.delete(sandbox.providerRef);
  }

  async status(sandbox: ProviderSandbox): Promise<ProviderSandboxStatus> {
    const state = this.sandboxes.get(sandbox.providerRef);
    if (!state) return "missing";
    return state.running ? "running" : "stopped";
  }

  async exec(sandbox: ProviderSandbox, command: NormalizedCommand, options: ExecOptions = {}): Promise<ExecResult> {
    await this.record("exec", sandbox.id, command);
    const state = this.running(sandbox);
    const result = await this.execHandler({
      sandboxId: sandbox.id,
      command,
      env: { ...state.spec.env, ...command.env },
    });
    const stdout = result?.stdout ?? "";
    const stderr = result?.stderr ?? "";
    if (stdout) options.onStdout?.(stdout);
    if (stderr) options.onStderr?.(stderr);
    return { exitCode: result?.exitCode ?? 0, stdout, stderr };
  }

  async startMainProcess(sandbox: ProviderSandbox, command: NormalizedCommand): Promise<void> {
    await this.record("startMainProcess", sandbox.id, command);
    const state = this.running(sandbox);
    state.mainProcess = { command, pid: this.nextPid++, running: true, exitCode: null };
  }

  async getMainProcess(sandbox: ProviderSandbox): Promise<MainProcessInfo | null> {
    const process = this.running(sandbox).mainProcess;
    return process ? { pid: process.pid, running: process.running, exitCode: process.exitCode } : null;
  }

  async readMainLog(sandbox: ProviderSandbox, offset: number): Promise<MainLogChunk> {
    const log = this.running(sandbox).log;
    const start = offset > log.length ? 0 : offset;
    const data = log.slice(start);
    return { data, nextOffset: start + data.length };
  }

  async writeFiles(sandbox: ProviderSandbox, files: ResolvedSandboxFile[]): Promise<void> {
    await this.record("writeFiles", sandbox.id);
    const state = this.running(sandbox);
    for (const file of files) state.files.set(file.path, file.content.slice());
  }

  async readFile(sandbox: ProviderSandbox, path: string): Promise<Uint8Array | null> {
    await this.record("readFile", sandbox.id);
    return this.running(sandbox).files.get(path)?.slice() ?? null;
  }

  async getUrl(sandbox: ProviderSandbox, port: number): Promise<string> {
    await this.record("getUrl", sandbox.id);
    this.running(sandbox);
    return `http://${sandbox.providerRef}.mock.localhost:${port}`;
  }

  async extendTimeout(sandbox: ProviderSandbox, durationMs: number): Promise<void> {
    await this.record("extendTimeout", sandbox.id);
    this.running(sandbox).timeoutExtensionsMs.push(durationMs);
  }

  private async record(operation: MockOperation, sandboxId: string, command?: NormalizedCommand) {
    this.calls.push({ operation, sandboxId, ...(command && { command }) });
    await this.beforeOperation?.(operation, sandboxId);
  }

  private async delay() {
    if (this.lifecycleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.lifecycleDelayMs));
  }

  private lookup(sandbox: ProviderSandbox): MockSandboxState {
    const state = this.sandboxes.get(sandbox.providerRef);
    if (!state) throw new ProviderSandboxMissingError(sandbox.providerRef);
    return state;
  }

  private running(sandbox: ProviderSandbox): MockSandboxState {
    const state = this.lookup(sandbox);
    if (!state.running) throw new ProviderSandboxStoppedError(sandbox.providerRef);
    return state;
  }

  private mustGetState(sandboxId: string): MockSandboxState {
    const state = this.getState(sandboxId);
    if (!state) throw new SandboxError(`Mock sandbox "${sandboxId}" does not exist`);
    return state;
  }
}
