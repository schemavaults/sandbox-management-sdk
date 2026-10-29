import { toShellCommandLine } from "./commands.js";
import { SandboxError } from "./errors.js";
import type { MainLogChunk } from "./provider.js";
import type { ExecResult, MainProcessInfo, NormalizedCommand } from "./types.js";

/**
 * Main-process bookkeeping for providers that only offer "run a command":
 * the launcher records its PID, appends output to a log file and records the
 * exit code, all under this directory inside the sandbox.
 */
export const MAIN_PROCESS_DIR = "/tmp/sandbox-sdk";
const PID_FILE = `${MAIN_PROCESS_DIR}/main.pid`;
const EXIT_FILE = `${MAIN_PROCESS_DIR}/main.exit`;
const LOG_FILE = `${MAIN_PROCESS_DIR}/main.log`;

const DEFAULT_MAX_LOG_READ_BYTES = 1024 * 1024;

type Exec = (command: NormalizedCommand) => Promise<ExecResult>;
type SpawnDetached = (command: NormalizedCommand) => Promise<void>;

const sh = (script: string): NormalizedCommand => ({ cmd: "sh", args: ["-c", script], cwd: "/", env: {} });

/**
 * Launch `command` as the main process: clear the previous run's PID and exit
 * files, spawn the launcher detached, then wait until it has recorded its PID
 * so `getMainProcess` reflects the new process as soon as this resolves.
 */
export async function shellStartMainProcess(
  exec: Exec,
  spawnDetached: SpawnDetached,
  command: NormalizedCommand,
  { timeoutMs = 15_000, pollIntervalMs = 100 }: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const reset = await exec(sh(`mkdir -p ${MAIN_PROCESS_DIR} && rm -f ${PID_FILE} ${EXIT_FILE}`));
  if (reset.exitCode !== 0) {
    throw new SandboxError(`Failed to prepare main process: ${reset.stderr.trim()}`);
  }
  await spawnDetached(mainProcessLauncher(command));
  const deadline = Date.now() + timeoutMs;
  while ((await exec(sh(`[ -f ${PID_FILE} ]`))).exitCode !== 0) {
    if (Date.now() >= deadline) throw new SandboxError("Main process did not start");
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * A command that runs `command` in the foreground as the main process. The
 * provider must run it detached (it only returns when the process exits).
 */
export function mainProcessLauncher(command: NormalizedCommand): NormalizedCommand {
  const script = [
    `mkdir -p ${MAIN_PROCESS_DIR}`,
    `rm -f ${EXIT_FILE}`,
    `echo $$ > ${PID_FILE}`,
    `exec >> ${LOG_FILE} 2>&1 < /dev/null`,
    `(${toShellCommandLine(command)})`,
    `echo $? > ${EXIT_FILE}`,
  ].join("\n");
  return sh(script);
}

const STATUS_SCRIPT = `[ -f ${PID_FILE} ] || exit 0
pid=$(cat ${PID_FILE})
if kill -0 "$pid" 2>/dev/null; then alive=1; else alive=0; fi
code=$(cat ${EXIT_FILE} 2>/dev/null || true)
echo "$pid $alive $code"`;

export async function shellGetMainProcess(exec: Exec): Promise<MainProcessInfo | null> {
  const result = await exec(sh(STATUS_SCRIPT));
  if (result.exitCode !== 0) {
    throw new SandboxError(`Failed to read main process status: ${result.stderr.trim()}`);
  }
  const [pidText, aliveText, codeText] = result.stdout.trim().split(/\s+/);
  if (!pidText) return null;
  const pid = Number.parseInt(pidText, 10);
  const exitCode = codeText ? Number.parseInt(codeText, 10) : null;
  return {
    pid: Number.isNaN(pid) ? null : pid,
    running: aliveText === "1" && exitCode === null,
    exitCode: exitCode === null || Number.isNaN(exitCode) ? null : exitCode,
  };
}

/**
 * Reads the main log from `offset`. The first output line is the effective
 * start offset (reset to 0 if the log was truncated), then base64 data.
 */
const READ_LOG_SCRIPT = `f=${LOG_FILE}
[ -f "$f" ] || { echo 0; exit 0; }
size=$(wc -c < "$f")
off=$SANDBOX_LOG_OFFSET
[ "$size" -lt "$off" ] && off=0
echo "$off"
tail -c +$((off + 1)) "$f" | head -c $SANDBOX_LOG_MAX_BYTES | base64`;

export async function shellReadMainLog(
  exec: Exec,
  offset: number,
  maxBytes = DEFAULT_MAX_LOG_READ_BYTES,
): Promise<MainLogChunk> {
  const result = await exec({
    cmd: "sh",
    args: ["-c", READ_LOG_SCRIPT],
    cwd: "/",
    env: { SANDBOX_LOG_OFFSET: String(offset), SANDBOX_LOG_MAX_BYTES: String(maxBytes) },
  });
  if (result.exitCode !== 0) {
    throw new SandboxError(`Failed to read main process log: ${result.stderr.trim()}`);
  }
  const newline = result.stdout.indexOf("\n");
  const start = Number.parseInt(newline === -1 ? result.stdout : result.stdout.slice(0, newline), 10) || 0;
  const encoded = newline === -1 ? "" : result.stdout.slice(newline + 1).replace(/\s+/g, "");
  const data = new Uint8Array(Buffer.from(encoded, "base64"));
  return { data, nextOffset: start + data.length };
}
