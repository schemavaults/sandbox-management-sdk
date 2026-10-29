import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitCloneCommand,
  normalizeCommand,
  resolveSandboxPath,
  shellQuote,
  toShellCommandLine,
  validateSpec,
} from "../../src/index.js";
import type { NormalizedCommand } from "../../src/index.js";

/** Run a normalized command on the host. */
function run(command: NormalizedCommand, cwd?: string) {
  const proc = Bun.spawnSync([command.cmd, ...command.args], {
    cwd: cwd ?? command.cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...command.env },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("command helpers", () => {
  it("normalizes strings to sh -c and resolves cwd against the workdir", () => {
    expect(normalizeCommand("echo $HOME | wc", "/w")).toEqual({
      cmd: "sh",
      args: ["-c", "echo $HOME | wc"],
      cwd: "/w",
      env: {},
    });
    expect(normalizeCommand({ cmd: "ls", args: ["-la"], cwd: "sub", env: { A: "1" } }, "/w")).toEqual({
      cmd: "ls",
      args: ["-la"],
      cwd: "/w/sub",
      env: { A: "1" },
    });
    expect(normalizeCommand({ cmd: "ls", cwd: "/abs/../x" }, "/w").cwd).toBe("/x");
    expect(resolveSandboxPath("/w", "a/./b")).toBe("/w/a/b");
  });

  it("quotes arbitrary strings for sh", () => {
    const nasty = `it's "quoted" $(rm -rf /) \`x\` \\ ;`;
    const result = run({ cmd: "sh", args: ["-c", `printf %s ${shellQuote(nasty)}`], cwd: "/", env: {} });
    expect(result.stdout).toBe(nasty);
  });

  it("renders a command line with cwd and env", () => {
    const line = toShellCommandLine({ cmd: "sh", args: ["-c", 'echo "$GREETING from $(pwd)"'], cwd: "/tmp", env: { GREETING: "hi 'there'" } });
    const result = run({ cmd: "sh", args: ["-c", line], cwd: "/", env: {} });
    expect(result.stdout.trim()).toBe("hi 'there' from /tmp");
    expect(() => toShellCommandLine({ cmd: "x", args: [], cwd: "/", env: { "A B": "1" } })).toThrow();
  });

  it("validates specs", () => {
    expect(() => validateSpec({ ports: [3000], timeoutMs: 1, workdir: "/w", git: { url: "u", depth: 1 } })).not.toThrow();
    expect(() => validateSpec({ ports: [70000] })).toThrow("Invalid port");
    expect(() => validateSpec({ timeoutMs: 0 })).toThrow("timeoutMs");
    expect(() => validateSpec({ git: { url: "u", depth: 0 } })).toThrow("depth");
    expect(() => validateSpec({ git: { url: "" } })).toThrow("git.url");
  });

  it("passes git credentials as a one-off extra header", () => {
    const command = gitCloneCommand({ url: "https://example.com/r.git", auth: { username: "u", password: "p" } }, "/w");
    expect(command.env).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa("u:p")}`,
    });
  });
});

describe("git clone script", () => {
  let root: string;
  let repoUrl: string;
  let firstCommit: string;

  const git = (cwd: string, ...args: string[]) => {
    const result = run({ cmd: "git", args, cwd, env: {} });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-sdk-git-"));
    const repo = join(root, "repo");
    await Bun.write(join(repo, "README.md"), "one\n");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    firstCommit = git(repo, "rev-parse", "HEAD");
    git(repo, "tag", "v1");
    await Bun.write(join(repo, "README.md"), "two\n");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "two");
    git(repo, "checkout", "-q", "-b", "feature");
    await Bun.write(join(repo, "README.md"), "feature\n");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "feature");
    git(repo, "checkout", "-q", "main");
    git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
    repoUrl = `file://${repo}`;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cases: [string, string | undefined, string][] = [
    ["the default branch", undefined, "two\n"],
    ["a branch", "feature", "feature\n"],
    ["a tag", "v1", "one\n"],
  ];
  for (const [label, revision, expected] of cases) {
    it(`clones ${label}`, async () => {
      const workdir = join(root, `clone-${label.replaceAll(" ", "-")}`);
      const result = run(gitCloneCommand({ url: repoUrl, revision, depth: 1 }, workdir));
      expect(result.stderr).not.toContain("fatal");
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(workdir, "README.md")).text()).toBe(expected);
    });
  }

  it("clones a commit SHA", async () => {
    const workdir = join(root, "clone-sha");
    const result = run(gitCloneCommand({ url: repoUrl, revision: firstCommit }, workdir));
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(workdir, "README.md")).text()).toBe("one\n");
  });

  it("fails for an unknown revision", () => {
    const result = run(gitCloneCommand({ url: repoUrl, revision: "does-not-exist" }, join(root, "clone-bad")));
    expect(result.exitCode).not.toBe(0);
  });
});
