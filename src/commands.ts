import { SandboxError } from "./errors.js";
import { encodeBase64 } from "./internal/base64.js";
import * as posix from "./internal/posix-path.js";
import type { CommandInput, GitSource, NormalizedCommand, SandboxSpec } from "./types.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve `path` against `workdir` unless it is already absolute. */
export function resolveSandboxPath(workdir: string, path: string): string {
  return posix.isAbsolute(path) ? posix.normalize(path) : posix.join(workdir, path);
}

export function normalizeCommand(input: CommandInput, workdir: string): NormalizedCommand {
  if (typeof input === "string") {
    return { cmd: "sh", args: ["-c", input], cwd: workdir, env: {} };
  }
  return {
    cmd: input.cmd,
    args: input.args ?? [],
    cwd: input.cwd ? resolveSandboxPath(workdir, input.cwd) : workdir,
    env: input.env ?? {},
  };
}

/** Quote a string for POSIX `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Render a normalized command as a single `sh` command line (cd + env + argv). */
export function toShellCommandLine(command: NormalizedCommand): string {
  const env = Object.entries(command.env).map(([key, value]) => {
    assertEnvName(key);
    return `${key}=${shellQuote(value)}`;
  });
  const argv = [command.cmd, ...command.args].map(shellQuote);
  const run = env.length > 0 ? ["env", ...env, ...argv] : argv;
  return `cd ${shellQuote(command.cwd)} && ${run.join(" ")}`;
}

function assertEnvName(name: string): void {
  if (!ENV_NAME.test(name)) {
    throw new SandboxError(`Invalid environment variable name "${name}"`);
  }
}

/** Throws a `SandboxError` describing the first problem found in `spec`. */
export function validateSpec(spec: SandboxSpec): void {
  for (const key of Object.keys(spec.env ?? {})) assertEnvName(key);
  for (const port of spec.ports ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxError(`Invalid port ${port}`);
    }
  }
  if (spec.timeoutMs !== undefined && !(spec.timeoutMs > 0)) {
    throw new SandboxError(`timeoutMs must be a positive number`);
  }
  if (spec.workdir !== undefined && !posix.isAbsolute(spec.workdir)) {
    throw new SandboxError(`workdir must be an absolute path`);
  }
  if (spec.git) {
    if (!spec.git.url) throw new SandboxError(`git.url is required`);
    if (spec.git.depth !== undefined && !(Number.isInteger(spec.git.depth) && spec.git.depth > 0)) {
      throw new SandboxError(`git.depth must be a positive integer`);
    }
  }
}

const GIT_CLONE_SCRIPT = `set -e
mkdir -p "$SANDBOX_GIT_DIR"
cd "$SANDBOX_GIT_DIR"
if [ -z "$SANDBOX_GIT_REVISION" ]; then
  git clone $SANDBOX_GIT_DEPTH -- "$SANDBOX_GIT_URL" .
elif git clone $SANDBOX_GIT_DEPTH --branch "$SANDBOX_GIT_REVISION" -- "$SANDBOX_GIT_URL" . 2>/dev/null; then
  :
else
  # Not a branch or tag: fetch the revision (e.g. a commit SHA) directly.
  rm -rf .git
  git init -q
  git remote add origin "$SANDBOX_GIT_URL"
  git fetch -q $SANDBOX_GIT_DEPTH origin "$SANDBOX_GIT_REVISION"
  git checkout -q FETCH_HEAD
fi`;

/**
 * The command that clones `git` into `workdir`. Credentials travel as a
 * one-off `http.extraHeader` via `GIT_CONFIG_*` env vars, so they are never
 * written to `.git/config`.
 */
export function gitCloneCommand(git: GitSource, workdir: string): NormalizedCommand {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    SANDBOX_GIT_DIR: workdir,
    SANDBOX_GIT_URL: git.url,
    SANDBOX_GIT_REVISION: git.revision ?? "",
    SANDBOX_GIT_DEPTH: git.depth ? `--depth=${git.depth}` : "",
  };
  if (git.auth) {
    const basic = encodeBase64(new TextEncoder().encode(`${git.auth.username}:${git.auth.password}`));
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return { cmd: "sh", args: ["-c", GIT_CLONE_SCRIPT], cwd: "/", env };
}
