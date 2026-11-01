import Docker from "dockerode";
import type { Container, ContainerInspectInfo } from "dockerode";
import type { Duplex } from "node:stream";
import { ProviderSandboxMissingError, ProviderSandboxStoppedError, SandboxError } from "../errors.js";
import { outputCollector } from "../internal/output.js";
import { assertNetworkPolicySupported } from "../network.js";
import type {
  MainLogChunk,
  ProviderCreateInput,
  ProviderCreateResult,
  ProviderSandbox,
  ProviderSandboxStatus,
  ResolvedSandboxFile,
  SandboxProvider,
} from "../provider.js";
import { shellGetMainProcess, shellReadMainLog, shellStartMainProcess } from "../shell-main-process.js";
import type { ExecOptions, ExecResult, MainProcessInfo, NormalizedCommand, SandboxSpec } from "../types.js";
import { createTar, extractFirstFile } from "./tar.js";

export type DockerPullPolicy = "if-not-present" | "always" | "never";

/** Per-sandbox options, set as `spec.providerOptions.docker`. */
export interface DockerSandboxOptions {
  /** Image to run. Must provide `/bin/sh`; `git` is needed for `spec.git`. */
  image?: string;
  /** User commands run as (container `User`). */
  user?: string;
  /**
   * Docker network to attach the container to. For `spec.network: "deny-all"`
   * leave it unset (the container gets `--network none`).
   */
  network?: string;
  pullPolicy?: DockerPullPolicy;
  /** Extra container labels. */
  labels?: Record<string, string>;
}

declare module "../types.js" {
  interface SandboxProviderOptions {
    docker?: DockerSandboxOptions;
  }
}

export interface DockerSandboxProviderOptions {
  /** A configured dockerode client. Defaults to `new Docker()` (honors `DOCKER_HOST`). */
  docker?: Docker;
  /** Provider name used in sandbox records. Default `"docker"`. */
  name?: string;
  /** Image used when the spec does not set one. */
  defaultImage?: string;
  /** Default `"/workspace"`. */
  defaultWorkdir?: string;
  /** Default `"if-not-present"`. */
  pullPolicy?: DockerPullPolicy;
  /** Host interface published ports bind to. Default `"127.0.0.1"`. */
  portBindingHost?: string;
  /** Host name used in URLs from `getUrl`. Default `"localhost"`. */
  urlHost?: string;
  /** Container name prefix. Default `"sandbox-"`. */
  containerNamePrefix?: string;
}

export const DOCKER_SANDBOX_ID_LABEL = "dev.schemavaults.sandbox.id";

/** PID 1 of every sandbox container: idle until stopped, exiting promptly on SIGTERM. */
const KEEPALIVE_SCRIPT = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done";

/**
 * Runs each sandbox as a long-lived container. `stop` / `wake` map to
 * `docker stop` / `docker start`, which keep the container filesystem.
 * Docker has no native timeout: run `SandboxManager.stopExpired()` periodically.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly defaultWorkdir: string;
  /** `"deny-all"` runs the container with `--network none`. Allowlists are not supported. */
  readonly networkPolicies = ["deny-all"] as const;
  private readonly docker: Docker;
  private readonly defaultImage: string | undefined;
  private readonly pullPolicy: DockerPullPolicy;
  private readonly portBindingHost: string;
  private readonly urlHost: string;
  private readonly containerNamePrefix: string;

  constructor(options: DockerSandboxProviderOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.name = options.name ?? "docker";
    this.defaultImage = options.defaultImage;
    this.defaultWorkdir = options.defaultWorkdir ?? "/workspace";
    this.pullPolicy = options.pullPolicy ?? "if-not-present";
    this.portBindingHost = options.portBindingHost ?? "127.0.0.1";
    this.urlHost = options.urlHost ?? "localhost";
    this.containerNamePrefix = options.containerNamePrefix ?? "sandbox-";
  }

  async create(input: ProviderCreateInput): Promise<ProviderCreateResult> {
    const options = input.spec.providerOptions?.docker ?? {};
    const image = options.image ?? this.defaultImage;
    if (!image) {
      throw new SandboxError("No Docker image: set spec.providerOptions.docker.image or defaultImage");
    }
    const networkMode = dockerNetworkMode(this, input.spec, options);
    await this.ensureImage(image, options.pullPolicy ?? this.pullPolicy);

    const ports = (input.spec.ports ?? []).map((port) => `${port}/tcp`);
    const { vcpus, memoryMb } = input.spec.resources ?? {};
    const container = await this.docker.createContainer({
      name: `${this.containerNamePrefix}${input.id}`,
      Image: image,
      Entrypoint: ["/bin/sh", "-c", KEEPALIVE_SCRIPT],
      Cmd: [],
      WorkingDir: input.workdir,
      Env: Object.entries(input.spec.env ?? {}).map(([key, value]) => `${key}=${value}`),
      User: options.user,
      Labels: { ...options.labels, [DOCKER_SANDBOX_ID_LABEL]: input.id },
      ExposedPorts: Object.fromEntries(ports.map((port) => [port, {}])),
      HostConfig: {
        Init: true,
        PortBindings: Object.fromEntries(
          ports.map((port) => [port, [{ HostIp: this.portBindingHost, HostPort: "" }]]),
        ),
        Memory: memoryMb ? memoryMb * 1024 * 1024 : undefined,
        NanoCpus: vcpus ? Math.round(vcpus * 1e9) : undefined,
        NetworkMode: networkMode,
      },
    });
    try {
      await container.start();
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }
    return { providerRef: container.id };
  }

  async wake(sandbox: ProviderSandbox): Promise<void> {
    const info = await this.inspect(sandbox);
    if (!info.State.Running) {
      await this.container(sandbox).start();
    }
  }

  async stop(sandbox: ProviderSandbox): Promise<void> {
    const info = await this.inspect(sandbox);
    if (!info.State.Running) return;
    try {
      await this.container(sandbox).stop({ t: 10 });
    } catch (error) {
      if (statusCode(error) !== 304) throw error; // 304: already stopped
    }
  }

  async destroy(sandbox: ProviderSandbox): Promise<void> {
    try {
      await this.container(sandbox).remove({ force: true, v: true });
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
  }

  async status(sandbox: ProviderSandbox): Promise<ProviderSandboxStatus> {
    try {
      const info = await this.inspect(sandbox);
      return info.State.Running ? "running" : "stopped";
    } catch (error) {
      if (error instanceof ProviderSandboxMissingError) return "missing";
      throw error;
    }
  }

  async exec(sandbox: ProviderSandbox, command: NormalizedCommand, options: ExecOptions = {}): Promise<ExecResult> {
    await this.assertRunning(sandbox);
    const exec = await this.container(sandbox).exec({
      Cmd: [command.cmd, ...command.args],
      Env: Object.entries(command.env).map(([key, value]) => `${key}=${value}`),
      WorkingDir: command.cwd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = (await exec.start({ hijack: true, stdin: false })) as Duplex;
    const stdout = outputCollector(options.onStdout);
    const stderr = outputCollector(options.onStderr);
    this.docker.modem.demuxStream(stream, stdout.writable, stderr.writable);
    await waitForStream(stream, options);

    // The exit code can lag the end of the stream briefly.
    let info = await exec.inspect();
    for (let attempt = 0; info.Running && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      info = await exec.inspect();
    }
    return { exitCode: info.ExitCode ?? -1, stdout: stdout.finish(), stderr: stderr.finish() };
  }

  async startMainProcess(sandbox: ProviderSandbox, command: NormalizedCommand): Promise<void> {
    await shellStartMainProcess(
      (cmd) => this.exec(sandbox, cmd),
      async (launcher) => {
        const exec = await this.container(sandbox).exec({
          Cmd: [launcher.cmd, ...launcher.args],
          WorkingDir: launcher.cwd,
        });
        await exec.start({ Detach: true });
      },
      command,
    );
  }

  async getMainProcess(sandbox: ProviderSandbox): Promise<MainProcessInfo | null> {
    return shellGetMainProcess((cmd) => this.exec(sandbox, cmd));
  }

  async readMainLog(sandbox: ProviderSandbox, offset: number): Promise<MainLogChunk> {
    return shellReadMainLog((cmd) => this.exec(sandbox, cmd), offset);
  }

  async writeFiles(sandbox: ProviderSandbox, files: ResolvedSandboxFile[]): Promise<void> {
    await this.assertRunning(sandbox);
    const tar = createTar(files.map((file) => ({ path: file.path, content: file.content, mode: file.mode })));
    await this.container(sandbox).putArchive(Buffer.from(tar), { path: "/", copyUIDGID: true });
  }

  async readFile(sandbox: ProviderSandbox, path: string): Promise<Uint8Array | null> {
    await this.assertRunning(sandbox);
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.container(sandbox).getArchive({ path });
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    const file = extractFirstFile(new Uint8Array(Buffer.concat(chunks)));
    return file?.content ?? null;
  }

  async getUrl(sandbox: ProviderSandbox, port: number): Promise<string> {
    const info = await this.assertRunning(sandbox);
    const hostPort = info.NetworkSettings.Ports?.[`${port}/tcp`]?.[0]?.HostPort;
    if (!hostPort) throw new SandboxError(`Port ${port} is not published on sandbox "${sandbox.id}"`);
    return `http://${this.urlHost}:${hostPort}`;
  }

  private container(sandbox: ProviderSandbox): Container {
    return this.docker.getContainer(sandbox.providerRef);
  }

  private async inspect(sandbox: ProviderSandbox): Promise<ContainerInspectInfo> {
    try {
      return await this.container(sandbox).inspect();
    } catch (error) {
      if (statusCode(error) === 404) throw new ProviderSandboxMissingError(sandbox.providerRef);
      throw error;
    }
  }

  private async assertRunning(sandbox: ProviderSandbox): Promise<ContainerInspectInfo> {
    const info = await this.inspect(sandbox);
    if (!info.State.Running) throw new ProviderSandboxStoppedError(sandbox.providerRef);
    return info;
  }

  private async ensureImage(image: string, policy: DockerPullPolicy): Promise<void> {
    if (policy === "never") return;
    if (policy === "if-not-present") {
      try {
        await this.docker.getImage(image).inspect();
        return;
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error: Error | null) => (error ? reject(error) : resolve()));
    });
    await this.docker.getImage(image).inspect();
  }
}

/** The container's `NetworkMode` for `spec.network`, or throws if the spec cannot be honored. */
function dockerNetworkMode(
  provider: DockerSandboxProvider,
  spec: SandboxSpec,
  options: DockerSandboxOptions,
): string | undefined {
  // Also checked by the manager; repeated for callers that use the provider directly.
  assertNetworkPolicySupported(provider, spec.network);
  if (spec.network !== "deny-all") return options.network;
  if (options.network !== undefined && options.network !== "none") {
    throw new SandboxError(
      `spec.network "deny-all" conflicts with spec.providerOptions.docker.network "${options.network}"`,
    );
  }
  if (spec.ports?.length) {
    throw new SandboxError(`spec.network "deny-all" gives a Docker sandbox no network, so spec.ports cannot be published`);
  }
  return "none";
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error
    ? (error as { statusCode?: number }).statusCode
    : undefined;
}

function waitForStream(stream: Duplex, options: ExecOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => fail(new SandboxError(`Command timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    const onAbort = () => fail(new SandboxError("Command aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();

    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", fail);

    function cleanup() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    function done() {
      cleanup();
      resolve();
    }
    function fail(error: Error) {
      cleanup();
      stream.destroy();
      reject(error);
    }
  });
}
