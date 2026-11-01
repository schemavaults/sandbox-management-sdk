/**
 * A command to run inside a sandbox.
 *
 * - A `string` is run through `sh -c`, so pipes, `&&` and variable expansion work.
 * - An object is run as an exact argv with no implicit shell.
 */
export type CommandInput = string | ArgvCommand;

export interface ArgvCommand {
  cmd: string;
  args?: string[];
  /** Working directory. Relative paths resolve against the sandbox workdir. */
  cwd?: string;
  /** Extra environment variables, merged over the sandbox's `spec.env`. */
  env?: Record<string, string>;
}

/** A command after normalization: always argv, `cwd` always absolute. */
export interface NormalizedCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface GitSource {
  /** Clone URL, e.g. `https://github.com/org/repo.git`. */
  url: string;
  /** Branch, tag or commit SHA to check out. Defaults to the remote HEAD. */
  revision?: string;
  /** Shallow clone depth. Omit for full history. */
  depth?: number;
  /** HTTP basic credentials, e.g. `{ username: "x-access-token", password: token }`. */
  auth?: { username: string; password: string };
}

export interface SandboxResources {
  vcpus?: number;
  memoryMb?: number;
}

/**
 * Outbound network access for a sandbox, enforced by its provider.
 *
 * - `"allow-all"` (the default): no restriction.
 * - `"deny-all"`: no outbound access at all.
 * - An allowlist: only the listed destinations are reachable.
 *
 * The manager refuses to create a sandbox on a provider that cannot enforce
 * the policy, so a policy is never silently ignored.
 */
export type SandboxNetworkPolicy = "allow-all" | "deny-all" | SandboxNetworkAllowlist;

/** Everything not listed is denied, so an empty allowlist means no access. */
export interface SandboxNetworkAllowlist {
  /**
   * Host names the sandbox may reach, e.g. `"github.com"`. A leading `*.`
   * matches subdomains (`"*.npmjs.org"`); `"*"` matches every domain.
   */
  allowDomains?: string[];
  /** IP addresses or CIDR ranges the sandbox may reach, e.g. `"203.0.113.10"` or `"10.0.0.0/8"`. */
  allowCidrs?: string[];
  /** IP addresses or CIDR ranges that are always blocked, even for allowed domains. */
  denyCidrs?: string[];
}

/** The kind of a `SandboxNetworkPolicy`. Providers declare which kinds they enforce. */
export type SandboxNetworkPolicyKind = "allow-all" | "deny-all" | "allowlist";

/**
 * Provider-specific spec options, keyed by provider name. Each adapter
 * augments this interface with its own typed key (`docker`, `vercel`, ...).
 */
export interface SandboxProviderOptions {
  [provider: string]: unknown;
}

/**
 * Everything needed to (re)create and resume a sandbox. It is persisted in the
 * store, so any process can resume a sandbox by ID alone.
 *
 * Note: `env` and `git.auth` are stored as-is; treat the store as sensitive.
 */
export interface SandboxSpec {
  /** Directory commands run in. Defaults to the provider's workdir. */
  workdir?: string;
  /** Environment variables set for every command in the sandbox. */
  env?: Record<string, string>;
  /** Repository cloned into `workdir` before `setup` runs. */
  git?: GitSource;
  /** One-shot command(s) run once after creation; stops at the first non-zero exit. */
  setup?: CommandInput | CommandInput[];
  /** The long-running main process, launched detached after `setup`. */
  start?: CommandInput;
  /**
   * Launched detached (as the new main process) whenever a stopped sandbox is
   * woken back up. Defaults to `start`.
   */
  resume?: CommandInput;
  /** Ports to expose; see `SandboxManager.getUrl`. */
  ports?: number[];
  /** Maximum time a sandbox may run before it is stopped. */
  timeoutMs?: number;
  resources?: SandboxResources;
  /**
   * Outbound network access. Applies from creation, so `git` and `setup`
   * run under it too. Default `"allow-all"`.
   */
  network?: SandboxNetworkPolicy;
  providerOptions?: SandboxProviderOptions;
}

export type SandboxStatus =
  | "provisioning"
  | "setting_up"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "resuming"
  | "failed"
  | "destroying"
  | "destroyed";

export const SANDBOX_STATUSES: readonly SandboxStatus[] = [
  "provisioning",
  "setting_up",
  "starting",
  "running",
  "stopping",
  "stopped",
  "resuming",
  "failed",
  "destroying",
  "destroyed",
];

/** Statuses that are mid-operation; other callers wait for them to settle. */
export const TRANSITIONAL_STATUSES: readonly SandboxStatus[] = [
  "provisioning",
  "setting_up",
  "starting",
  "stopping",
  "resuming",
  "destroying",
];

export interface SandboxRecord {
  /** SDK-generated ID, e.g. `sbx-3f9c...`. */
  id: string;
  /** Name of the provider the sandbox lives on. */
  provider: string;
  /** The provider's own ID (Docker container ID, Vercel sandbox name). */
  providerRef: string | null;
  status: SandboxStatus;
  spec: SandboxSpec;
  /** Your user / tenant / project ID. Indexed for listing. */
  ownerId: string | null;
  /** String labels; `list({ labels })` matches records containing all given pairs. */
  labels: Record<string, string>;
  /** Free-form JSON metadata. Not queryable. */
  metadata: Record<string, unknown>;
  /** Last failure message, if any. */
  error: string | null;
  /** Incremented on every update; used for compare-and-set. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** When the sandbox should be stopped (from `spec.timeoutMs`). */
  expiresAt: Date | null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SandboxFile {
  /** Relative paths resolve against the sandbox workdir. */
  path: string;
  content: string | Uint8Array;
  /** Unix permission bits, e.g. `0o755`. Defaults to `0o644`. */
  mode?: number;
}

/** State of the sandbox's detached main process (the `start` / `resume` command). */
export interface MainProcessInfo {
  pid: number | null;
  running: boolean;
  /** Exit code once the process has exited, otherwise `null`. */
  exitCode: number | null;
}
