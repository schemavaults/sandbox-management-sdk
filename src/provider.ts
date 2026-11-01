import type {
  ExecOptions,
  ExecResult,
  MainProcessInfo,
  NormalizedCommand,
  SandboxNetworkPolicyKind,
  SandboxSpec,
} from "./types.js";

/** Identifies a sandbox on its provider. Passed to every provider operation. */
export interface ProviderSandbox {
  /** SDK sandbox ID. */
  id: string;
  /** The provider's own ID, as returned from `create`. */
  providerRef: string;
  spec: SandboxSpec;
  /** Resolved working directory (`spec.workdir` or the provider default). */
  workdir: string;
}

export interface ProviderCreateInput {
  id: string;
  spec: SandboxSpec;
  workdir: string;
  ownerId: string | null;
  labels: Record<string, string>;
}

export interface ProviderCreateResult {
  providerRef: string;
}

/** What the provider reports about a sandbox. */
export type ProviderSandboxStatus = "running" | "stopped" | "missing";

/** A file written by `writeFiles`, with its path resolved to absolute. */
export interface ResolvedSandboxFile {
  path: string;
  content: Uint8Array;
  mode: number;
}

export interface MainLogChunk {
  data: Uint8Array;
  /** Byte offset to pass on the next read. */
  nextOffset: number;
}

/**
 * Adapter to a sandbox backend. Providers are stateless with respect to the
 * store: the `SandboxManager` owns status bookkeeping.
 *
 * Operations other than `create`, `wake`, `stop`, `destroy` and `status` must
 * throw `ProviderSandboxStoppedError` if the sandbox is not running, and
 * `ProviderSandboxMissingError` if it no longer exists, so the manager can
 * auto-resume or report it.
 */
export interface SandboxProvider {
  readonly name: string;
  /** Working directory used when `spec.workdir` is not set. */
  readonly defaultWorkdir: string;
  /**
   * The restrictive `spec.network` policies this provider enforces. The
   * manager refuses to create a sandbox whose policy is not listed, so a
   * provider that leaves this out never silently ignores one. An unset or
   * `"allow-all"` policy is always accepted.
   */
  readonly networkPolicies?: readonly Exclude<SandboxNetworkPolicyKind, "allow-all">[];

  /** Create the sandbox and leave it running with `workdir` present. */
  create(input: ProviderCreateInput): Promise<ProviderCreateResult>;
  /** Start a stopped sandbox. Must be a no-op if it is already running. */
  wake(sandbox: ProviderSandbox): Promise<void>;
  /** Stop the sandbox, keeping its filesystem. Must be a no-op if already stopped. */
  stop(sandbox: ProviderSandbox): Promise<void>;
  /** Delete the sandbox. Must be a no-op if it no longer exists. */
  destroy(sandbox: ProviderSandbox): Promise<void>;
  status(sandbox: ProviderSandbox): Promise<ProviderSandboxStatus>;

  exec(sandbox: ProviderSandbox, command: NormalizedCommand, options?: ExecOptions): Promise<ExecResult>;

  /** Launch `command` detached as the sandbox's main process, logging its output. */
  startMainProcess(sandbox: ProviderSandbox, command: NormalizedCommand): Promise<void>;
  getMainProcess(sandbox: ProviderSandbox): Promise<MainProcessInfo | null>;
  /** Read the main process log from byte `offset`; an empty chunk means no new output. */
  readMainLog(sandbox: ProviderSandbox, offset: number): Promise<MainLogChunk>;

  writeFiles(sandbox: ProviderSandbox, files: ResolvedSandboxFile[]): Promise<void>;
  /** Resolves `null` if the file does not exist. */
  readFile(sandbox: ProviderSandbox, path: string): Promise<Uint8Array | null>;
  /** A URL that reaches `port` inside the sandbox. The port must be in `spec.ports`. */
  getUrl(sandbox: ProviderSandbox, port: number): Promise<string>;
  /** Extend the provider-side timeout, if the provider enforces one. */
  extendTimeout?(sandbox: ProviderSandbox, durationMs: number): Promise<void>;
}
