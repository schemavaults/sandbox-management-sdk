import { beforeEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import {
  MAIN_PROCESS_DIR,
  shellGetMainProcess,
  shellReadMainLog,
  shellStartMainProcess,
} from "../../src/index.js";
import type { ExecResult, NormalizedCommand } from "../../src/index.js";

// These run the real scripts against the host's `sh`, using MAIN_PROCESS_DIR on the host.
const env = () => ({ PATH: process.env.PATH ?? "" });

async function exec(command: NormalizedCommand): Promise<ExecResult> {
  const proc = Bun.spawn([command.cmd, ...command.args], { cwd: command.cwd, env: { ...env(), ...command.env } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function spawnDetached(command: NormalizedCommand): Promise<void> {
  Bun.spawn([command.cmd, ...command.args], { cwd: command.cwd, env: env(), stdio: ["ignore", "ignore", "ignore"] });
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await fn();
    if (predicate(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const readAll = async () => {
  let offset = 0;
  let text = "";
  for (;;) {
    const chunk = await shellReadMainLog(exec, offset, 4);
    if (chunk.data.length === 0) return text;
    text += new TextDecoder().decode(chunk.data);
    offset = chunk.nextOffset;
  }
};

describe("shell main process", () => {
  beforeEach(async () => {
    await rm(MAIN_PROCESS_DIR, { recursive: true, force: true });
  });

  it("reports no main process before one is launched", async () => {
    expect(await shellGetMainProcess(exec)).toBeNull();
    expect((await shellReadMainLog(exec, 0)).data.length).toBe(0);
  });

  it("launches, logs and records the exit code", async () => {
    await shellStartMainProcess(exec, spawnDetached, {
      cmd: "sh",
      args: ["-c", 'echo "out $GREETING"; echo err >&2; sleep 0.3; exit 7'],
      cwd: "/tmp",
      env: { GREETING: "hello" },
    });
    const running = await shellGetMainProcess(exec);
    expect(running?.pid).toBeGreaterThan(0);
    expect(running?.running).toBe(true);

    const finished = await waitFor(() => shellGetMainProcess(exec), (info) => info?.exitCode !== null);
    expect(finished).toMatchObject({ running: false, exitCode: 7 });
    expect(await readAll()).toBe("out hello\nerr\n");
  });

  it("appends to the log across runs and handles truncation", async () => {
    for (const word of ["first", "second"]) {
      await shellStartMainProcess(exec, spawnDetached, { cmd: "echo", args: [word], cwd: "/", env: {} });
      await waitFor(() => shellGetMainProcess(exec), (info) => info?.exitCode === 0);
    }
    expect(await readAll()).toBe("first\nsecond\n");

    const chunk = await shellReadMainLog(exec, 1000);
    expect(new TextDecoder().decode(chunk.data)).toBe("first\nsecond\n");
    expect(chunk.nextOffset).toBe(13);
  });
});
