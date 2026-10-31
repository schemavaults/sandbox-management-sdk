import type { ExecResult, NormalizedCommand } from "@schemavaults/sandbox-management-sdk";

/** The filesystem of one browser sandbox: absolute paths to file contents, plus directories. */
export interface ToyFileSystem {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
}

export interface ToyShellContext {
  fs: ToyFileSystem;
  env: Record<string, string>;
  hostname: string;
  now: () => Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HELP = `This sandbox runs a toy shell in your browser tab. It knows:
  echo  cat  ls  pwd  cd  mkdir  touch  rm  wc  env  date  whoami  hostname  uname  sleep  true  false  help
Redirect with > and >>, chain with && and ;. No pipes, no network, no real processes.
`;

/**
 * Runs `command` against the in-memory filesystem: `sh -c` scripts are
 * parsed (quotes, $VARS, `>` / `>>`, `&&`, `;`), and argv commands run
 * directly. It is a few hundred lines pretending to be a computer.
 */
export function runToyShell(command: NormalizedCommand, context: ToyShellContext): ExecResult {
  const shell = new ToyShell(context, command.cwd, { ...context.env, ...command.env });
  if (command.cmd === "sh" && command.args[0] === "-c") return shell.runScript(command.args[1] ?? "");
  return shell.runArgv([command.cmd, ...command.args], null);
}

interface Redirect {
  path: string;
  append: boolean;
}

interface SimpleCommand {
  argv: string[];
  redirect: Redirect | null;
}

type Step = { command: SimpleCommand; then: "&&" | ";" };

class ToyShell {
  private stdout = "";
  private stderr = "";

  constructor(
    private readonly context: ToyShellContext,
    private cwd: string,
    private readonly env: Record<string, string>,
  ) {}

  runScript(script: string): ExecResult {
    let steps: Step[];
    try {
      steps = this.parse(script);
    } catch (error) {
      return { exitCode: 2, stdout: "", stderr: `sh: ${(error as Error).message}\n` };
    }
    let exitCode = 0;
    for (const [index, step] of steps.entries()) {
      const previous = steps[index - 1];
      if (previous?.then === "&&" && exitCode !== 0) continue;
      exitCode = this.runArgv(step.command.argv, step.command.redirect).exitCode;
    }
    return { exitCode, stdout: this.stdout, stderr: this.stderr };
  }

  runArgv(argv: string[], redirect: Redirect | null): ExecResult {
    const [name, ...args] = argv;
    if (!name) return { exitCode: 0, stdout: this.stdout, stderr: this.stderr };
    let output = "";
    const out = (text: string) => {
      output += text;
    };
    const exitCode = this.builtin(name, args, out);
    if (redirect) {
      const path = this.resolve(redirect.path);
      if (!this.context.fs.dirs.has(parent(path))) {
        this.stderr += `sh: ${redirect.path}: No such file or directory\n`;
        return { exitCode: 1, stdout: this.stdout, stderr: this.stderr };
      }
      const previous = redirect.append ? decoder.decode(this.context.fs.files.get(path) ?? new Uint8Array()) : "";
      this.context.fs.files.set(path, encoder.encode(previous + output));
    } else {
      this.stdout += output;
    }
    return { exitCode, stdout: this.stdout, stderr: this.stderr };
  }

  private builtin(name: string, args: string[], out: (text: string) => void): number {
    const { fs } = this.context;
    const fail = (message: string, code = 1) => {
      this.stderr += `${name}: ${message}\n`;
      return code;
    };
    switch (name) {
      case "echo": {
        const newline = args[0] !== "-n";
        out(args.slice(newline ? 0 : 1).join(" ") + (newline ? "\n" : ""));
        return 0;
      }
      case "pwd":
        out(`${this.cwd}\n`);
        return 0;
      case "cd": {
        const target = this.resolve(args[0] ?? this.env.HOME ?? "/");
        if (!fs.dirs.has(target)) return fail(`${args[0]}: No such directory`);
        this.cwd = target;
        return 0;
      }
      case "ls": {
        const flags = args.filter((arg) => arg.startsWith("-")).join("");
        const long = flags.includes("l");
        const all = flags.includes("a");
        const targets = args.filter((arg) => !arg.startsWith("-"));
        let code = 0;
        for (const target of targets.length > 0 ? targets : ["."]) {
          const path = this.resolve(target);
          if (fs.files.has(path)) {
            out(long ? this.longEntry(target, fs.files.get(path)!.length, false) : `${target}\n`);
            continue;
          }
          if (!fs.dirs.has(path)) {
            code = fail(`cannot access '${target}': No such file or directory`, 2);
            continue;
          }
          const entries = this.children(path).filter(({ name: entry }) => all || !entry.startsWith("."));
          if (all) entries.unshift({ name: ".", dir: true, size: 0 }, { name: "..", dir: true, size: 0 });
          if (long) {
            out(`total ${entries.length}\n`);
            for (const entry of entries) out(this.longEntry(entry.name, entry.size, entry.dir));
          } else if (entries.length > 0) {
            out(`${entries.map((entry) => (entry.dir ? `${entry.name}/` : entry.name)).join("  ")}\n`);
          }
        }
        return code;
      }
      case "cat": {
        let code = 0;
        for (const target of args) {
          const content = fs.files.get(this.resolve(target));
          if (content) out(decoder.decode(content));
          else code = fail(`${target}: ${fs.dirs.has(this.resolve(target)) ? "Is a directory" : "No such file or directory"}`);
        }
        return code;
      }
      case "touch":
        for (const target of args) {
          const path = this.resolve(target);
          if (!fs.dirs.has(parent(path))) return fail(`cannot touch '${target}': No such file or directory`);
          if (!fs.files.has(path)) fs.files.set(path, new Uint8Array());
        }
        return 0;
      case "mkdir": {
        const recursive = args.includes("-p");
        for (const target of args.filter((arg) => arg !== "-p")) {
          const path = this.resolve(target);
          if (fs.dirs.has(path) && !recursive) return fail(`cannot create directory '${target}': File exists`);
          if (!recursive && !fs.dirs.has(parent(path))) return fail(`cannot create directory '${target}': No such file or directory`);
          for (let dir = path; dir !== "/"; dir = parent(dir)) fs.dirs.add(dir);
        }
        return 0;
      }
      case "rm": {
        const force = args.some((arg) => arg.startsWith("-") && arg.includes("f"));
        const recursive = args.some((arg) => arg.startsWith("-") && arg.includes("r"));
        let code = 0;
        for (const target of args.filter((arg) => !arg.startsWith("-"))) {
          const path = this.resolve(target);
          if (fs.files.delete(path)) continue;
          if (fs.dirs.has(path) && path !== "/") {
            if (!recursive) {
              code = fail(`cannot remove '${target}': Is a directory`);
              continue;
            }
            for (const key of [...fs.files.keys()]) if (key.startsWith(`${path}/`)) fs.files.delete(key);
            for (const dir of [...fs.dirs]) if (dir === path || dir.startsWith(`${path}/`)) fs.dirs.delete(dir);
            continue;
          }
          if (!force) code = fail(`cannot remove '${target}': No such file or directory`);
        }
        return code;
      }
      case "wc": {
        const content = fs.files.get(this.resolve(args.find((arg) => !arg.startsWith("-")) ?? ""));
        if (!content) return fail("missing or unknown file");
        const text = decoder.decode(content);
        const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        out(args.includes("-l") ? `${lines}\n` : `${lines} ${text.split(/\s+/).filter(Boolean).length} ${content.length}\n`);
        return 0;
      }
      case "env":
        out(Object.entries(this.env).map(([key, value]) => `${key}=${value}\n`).join(""));
        return 0;
      case "date":
        out(`${this.context.now().toUTCString()}\n`);
        return 0;
      case "whoami":
        out(`${this.env.USER ?? "sandbox"}\n`);
        return 0;
      case "hostname":
        out(`${this.context.hostname}\n`);
        return 0;
      case "uname":
        out(args.includes("-a") ? `ToyOS ${this.context.hostname} 0.0.1-browser #1 SMP ${navigatorName()} wasm-ish\n` : "ToyOS\n");
        return 0;
      case "sleep":
      case "true":
      case ":":
        return 0;
      case "false":
        return 1;
      case "help":
        out(HELP);
        return 0;
      case "node":
      case "npm":
      case "bun":
      case "python":
      case "python3":
      case "git":
      case "curl":
        return fail("not installed. This sandbox is a toy shell running in your browser tab; try `help`.", 127);
      default:
        this.stderr += `sh: ${name}: command not found\n`;
        return 127;
    }
  }

  private children(dir: string): { name: string; dir: boolean; size: number }[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const entries = new Map<string, { name: string; dir: boolean; size: number }>();
    for (const sub of this.context.fs.dirs) {
      if (sub !== dir && parent(sub) === dir) entries.set(sub, { name: sub.slice(prefix.length), dir: true, size: 0 });
    }
    for (const [path, content] of this.context.fs.files) {
      if (parent(path) === dir) entries.set(path, { name: path.slice(prefix.length), dir: false, size: content.length });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private longEntry(name: string, size: number, dir: boolean): string {
    const mode = dir ? "drwxr-xr-x" : "-rw-r--r--";
    return `${mode} 1 sandbox sandbox ${String(dir ? 4096 : size).padStart(5)} ${name}\n`;
  }

  private resolve(path: string): string {
    const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
    const parts: string[] = [];
    for (const part of absolute.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }

  /** Splits a script into simple commands joined by `&&`, `;` or newlines. */
  private parse(script: string): Step[] {
    const steps: Step[] = [];
    let argv: string[] = [];
    let word: string | null = null;
    let redirect: Redirect | null = null;
    let pendingRedirect: boolean | null = null; // the next word is a redirect target (append?)

    const endWord = () => {
      if (word === null) return;
      if (pendingRedirect !== null) {
        redirect = { path: word, append: pendingRedirect };
        pendingRedirect = null;
      } else {
        argv.push(word);
      }
      word = null;
    };
    const endCommand = (then: Step["then"]) => {
      endWord();
      if (pendingRedirect !== null) throw new Error("syntax error: missing redirect target");
      if (argv.length > 0) steps.push({ command: { argv, redirect }, then });
      argv = [];
      redirect = null;
    };
    const expand = (name: string) => this.env[name] ?? (name === "PWD" ? this.cwd : "");

    for (let i = 0; i < script.length; i += 1) {
      const char = script[i]!;
      if (char === "'") {
        const end = script.indexOf("'", i + 1);
        if (end === -1) throw new Error("unterminated quoted string");
        word = (word ?? "") + script.slice(i + 1, end);
        i = end;
      } else if (char === '"') {
        let value = "";
        let j = i + 1;
        for (; j < script.length && script[j] !== '"'; j += 1) {
          const inner = script[j]!;
          if (inner === "\\" && j + 1 < script.length && '"\\$`'.includes(script[j + 1]!)) {
            value += script[j + 1];
            j += 1;
          } else if (inner === "$") {
            const match = /^\$(\w+|\{\w+\})/.exec(script.slice(j));
            if (match) {
              value += expand(match[1]!.replace(/[{}]/g, ""));
              j += match[0].length - 1;
            } else value += inner;
          } else value += inner;
        }
        if (j >= script.length) throw new Error("unterminated quoted string");
        word = (word ?? "") + value;
        i = j;
      } else if (char === "\\" && i + 1 < script.length) {
        word = (word ?? "") + script[i + 1];
        i += 1;
      } else if (char === "$") {
        const match = /^\$(\w+|\{\w+\})/.exec(script.slice(i));
        if (match) {
          word = (word ?? "") + expand(match[1]!.replace(/[{}]/g, ""));
          i += match[0].length - 1;
        } else word = (word ?? "") + char;
      } else if (char === ">") {
        endWord();
        const append = script[i + 1] === ">";
        if (append) i += 1;
        pendingRedirect = append;
      } else if (char === "&" && script[i + 1] === "&") {
        endCommand("&&");
        i += 1;
      } else if (char === ";" || char === "\n") {
        endCommand(";");
      } else if (char === "|") {
        throw new Error("pipes are not supported in this toy shell");
      } else if (char === "#" && word === null) {
        const end = script.indexOf("\n", i);
        i = end === -1 ? script.length : end - 1;
      } else if (/\s/.test(char)) {
        endWord();
      } else {
        word = (word ?? "") + char;
      }
    }
    endCommand(";");
    return steps;
  }
}

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function navigatorName(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}
