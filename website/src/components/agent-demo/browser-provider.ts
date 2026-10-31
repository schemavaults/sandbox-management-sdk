import {
  ProviderSandboxMissingError,
  ProviderSandboxStoppedError,
  SandboxError,
  type ExecOptions,
  type ExecResult,
  type MainLogChunk,
  type MainProcessInfo,
  type NormalizedCommand,
  type ProviderCreateInput,
  type ProviderCreateResult,
  type ProviderSandbox,
  type ProviderSandboxStatus,
  type ResolvedSandboxFile,
  type SandboxProvider,
} from "@schemavaults/sandbox-management-sdk";
import { runToyShell, type ToyFileSystem } from "./toy-shell";

interface BrowserSandboxState {
  sandboxId: string;
  hostname: string;
  env: Record<string, string>;
  running: boolean;
  fs: ToyFileSystem;
  main: { pid: number; running: boolean; exitCode: number | null } | null;
  log: Uint8Array;
}

/** Simulated latency per operation, in ms, so the lifecycle is visible. */
export interface BrowserSandboxDelays {
  create: number;
  wake: number;
  stop: number;
  destroy: number;
  exec: number;
}

const DEFAULT_DELAYS: BrowserSandboxDelays = { create: 700, wake: 650, stop: 500, destroy: 550, exec: 260 };

const encoder = new TextEncoder();

/**
 * An ephemeral sandbox provider that lives in the browser tab: each sandbox
 * is an in-memory filesystem plus the toy shell in `toy-shell.ts`, and all of
 * it disappears with the page. It implements the same `SandboxProvider`
 * interface as the Docker and Vercel adapters, so `SandboxManager` drives it
 * through the real lifecycle: setup steps, stop, auto-resume, destroy.
 */
export class BrowserSandboxProvider implements SandboxProvider {
  readonly name = "browser";
  readonly defaultWorkdir = "/workspace";
  private readonly sandboxes = new Map<string, BrowserSandboxState>();
  private readonly delays: BrowserSandboxDelays;
  private nextRef = 1;
  private nextPid = 100;

  constructor(options: { delays?: Partial<BrowserSandboxDelays> } = {}) {
    this.delays = { ...DEFAULT_DELAYS, ...options.delays };
  }

  async create(input: ProviderCreateInput): Promise<ProviderCreateResult> {
    await this.delay("create");
    const providerRef = `tab-sbx-${this.nextRef++}`;
    const dirs = new Set(["/tmp", "/home", "/home/sandbox"]);
    for (let dir = input.workdir; dir !== "/" && dir !== ""; dir = dir.slice(0, dir.lastIndexOf("/")) || "/") dirs.add(dir);
    this.sandboxes.set(providerRef, {
      sandboxId: input.id,
      hostname: providerRef,
      env: { HOME: "/home/sandbox", USER: "sandbox", PATH: "/usr/bin:/bin", ...input.spec.env },
      running: true,
      fs: { files: new Map(), dirs },
      main: null,
      log: new Uint8Array(),
    });
    return { providerRef };
  }

  async wake(sandbox: ProviderSandbox): Promise<void> {
    const state = this.lookup(sandbox);
    if (state.running) return;
    await this.delay("wake");
    state.running = true;
  }

  async stop(sandbox: ProviderSandbox): Promise<void> {
    const state = this.lookup(sandbox);
    if (!state.running) return;
    await this.delay("stop");
    state.running = false;
    if (state.main?.running) {
      state.main.running = false;
      state.main.exitCode = 143;
      this.appendLog(state, `[${timestamp()}] received SIGTERM, saving nothing because there is nothing to save\n`);
    }
  }

  async destroy(sandbox: ProviderSandbox): Promise<void> {
    if (!this.sandboxes.has(sandbox.providerRef)) return;
    await this.delay("destroy");
    this.sandboxes.delete(sandbox.providerRef);
  }

  async status(sandbox: ProviderSandbox): Promise<ProviderSandboxStatus> {
    const state = this.sandboxes.get(sandbox.providerRef);
    if (!state) return "missing";
    return state.running ? "running" : "stopped";
  }

  async exec(sandbox: ProviderSandbox, command: NormalizedCommand, options: ExecOptions = {}): Promise<ExecResult> {
    this.running(sandbox);
    await this.delay("exec");
    // It may have been stopped while this command was "running".
    const state = this.running(sandbox);
    const result = runToyShell(command, { fs: state.fs, env: state.env, hostname: state.hostname, now: () => new Date() });
    if (result.stdout) options.onStdout?.(result.stdout);
    if (result.stderr) options.onStderr?.(result.stderr);
    return result;
  }

  async startMainProcess(sandbox: ProviderSandbox, command: NormalizedCommand): Promise<void> {
    const state = this.running(sandbox);
    const pid = this.nextPid++;
    state.main = { pid, running: true, exitCode: null };
    const line = command.cmd === "sh" ? (command.args[1] ?? "") : [command.cmd, ...command.args].join(" ");
    this.appendLog(state, `[${timestamp()}] started \`${line}\` as pid ${pid}\n`);
  }

  async getMainProcess(sandbox: ProviderSandbox): Promise<MainProcessInfo | null> {
    const main = this.running(sandbox).main;
    return main ? { ...main } : null;
  }

  async readMainLog(sandbox: ProviderSandbox, offset: number): Promise<MainLogChunk> {
    const log = this.running(sandbox).log;
    const start = offset > log.length ? 0 : offset;
    const data = log.slice(start);
    return { data, nextOffset: start + data.length };
  }

  async writeFiles(sandbox: ProviderSandbox, files: ResolvedSandboxFile[]): Promise<void> {
    const { fs } = this.running(sandbox);
    for (const file of files) fs.files.set(file.path, file.content.slice());
  }

  async readFile(sandbox: ProviderSandbox, path: string): Promise<Uint8Array | null> {
    return this.running(sandbox).fs.files.get(path)?.slice() ?? null;
  }

  async getUrl(sandbox: ProviderSandbox): Promise<string> {
    this.running(sandbox);
    throw new SandboxError("Browser sandboxes have no network, so there is no URL to give out");
  }

  private appendLog(state: BrowserSandboxState, text: string): void {
    const added = encoder.encode(text);
    const log = new Uint8Array(state.log.length + added.length);
    log.set(state.log);
    log.set(added, state.log.length);
    state.log = log;
  }

  private delay(operation: keyof BrowserSandboxDelays): Promise<void> {
    const ms = this.delays[operation];
    // Vary it a little so it feels like a machine and not a metronome.
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms * (0.8 + Math.random() * 0.4))) : Promise.resolve();
  }

  private lookup(sandbox: ProviderSandbox): BrowserSandboxState {
    const state = this.sandboxes.get(sandbox.providerRef);
    if (!state) throw new ProviderSandboxMissingError(sandbox.providerRef);
    return state;
  }

  private running(sandbox: ProviderSandbox): BrowserSandboxState {
    const state = this.lookup(sandbox);
    if (!state.running) throw new ProviderSandboxStoppedError(sandbox.providerRef);
    return state;
  }
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}
