import Docker from "dockerode";
import type { Container, ContainerInspectInfo } from "dockerode";
import type { Duplex } from "node:stream";
import { ProviderSandboxMissingError, ProviderSandboxStoppedError, SandboxError } from "../errors.js";
import { outputCollector } from "../internal/output.js";
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
import type { ExecOptions, ExecResult, MainProcessInfo, NormalizedCommand } from "../types.js";
import {
  DOCKER_EGRESS_PROXY_IMAGE,
  DOCKER_EGRESS_PROXY_LABEL,
  EGRESS_PROXY_ALIAS,
  SANDBOX_ALIAS,
  dockerNetworkPlan,
  egressProxyConfig,
  egressProxyEnv,
  usesEgressProxy,
} from "./egress.js";
import { EGRESS_PROXY_CONFIG_ENV } from "./egress-proxy/config.js";
import { createTar, extractFirstFile } from "./tar.js";

export type DockerPullPolicy = "if-not-present" | "always" | "never";

/** Per-sandbox options, set as `spec.providerOptions.docker`. */
export interface DockerSandboxOptions {
  /** Image to run. Must provide `/bin/sh`; `git` is needed for `spec.git`. */
  image?: string;
  /** User commands run as (container `User`). */
  user?: string;
  /**
   * Docker network to attach the container to. With a `spec.network`
   * allowlist, this is the network the egress proxy reaches the outside
   * through instead (default `"bridge"`). Leave it unset for `"deny-all"`.
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
  /**
   * Image of the egress proxy that enforces `spec.network` allowlists. Default
   * `DOCKER_EGRESS_PROXY_IMAGE`, published for each SDK release. Pulled
   * according to `pullPolicy`.
   */
  egressProxyImage?: string;
  /** How long to wait for an egress proxy to report healthy. Default 30 seconds. */
  egressProxyStartTimeoutMs?: number;
}

export const DOCKER_SANDBOX_ID_LABEL = "dev.schemavaults.sandbox.id";

/** PID 1 of every sandbox container: idle until stopped, exiting promptly on SIGTERM. */
const KEEPALIVE_SCRIPT = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done";

/**
 * Runs each sandbox as a long-lived container. `stop` / `wake` map to
 * `docker stop` / `docker start`, which keep the container filesystem.
 * Docker has no native timeout: run `SandboxManager.stopExpired()` periodically.
 *
 * A sandbox with a `spec.network` allowlist (or `"deny-all"` and `ports`) gets
 * an internal network of its own, with no route out, and an egress proxy
 * container (`<name>-egress`) that is its only way to the outside: it enforces
 * the allowlist for HTTP(S) and forwards the published ports.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly defaultWorkdir: string;
  /** `"deny-all"` without ports is `--network none`; the rest runs behind an egress proxy. */
  readonly networkPolicies = ["deny-all", "allowlist"] as const;
  private readonly docker: Docker;
  private readonly defaultImage: string | undefined;
  private readonly pullPolicy: DockerPullPolicy;
  private readonly portBindingHost: string;
  private readonly urlHost: string;
  private readonly containerNamePrefix: string;
  private readonly egressProxyImage: string;
  private readonly egressProxyStartTimeoutMs: number;

  constructor(options: DockerSandboxProviderOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.name = options.name ?? "docker";
    this.defaultImage = options.defaultImage;
    this.defaultWorkdir = options.defaultWorkdir ?? "/workspace";
    this.pullPolicy = options.pullPolicy ?? "if-not-present";
    this.portBindingHost = options.portBindingHost ?? "127.0.0.1";
    this.urlHost = options.urlHost ?? "localhost";
    this.containerNamePrefix = options.containerNamePrefix ?? "sandbox-";
    this.egressProxyImage = options.egressProxyImage ?? DOCKER_EGRESS_PROXY_IMAGE;
    this.egressProxyStartTimeoutMs = options.egressProxyStartTimeoutMs ?? 30_000;
  }

  async create(input: ProviderCreateInput): Promise<ProviderCreateResult> {
    const options = input.spec.providerOptions?.docker ?? {};
    const image = options.image ?? this.defaultImage;
    if (!image) {
      throw new SandboxError("No Docker image: set spec.providerOptions.docker.image or defaultImage");
    }
    const plan = dockerNetworkPlan(this, input.spec, options.network);
    await this.ensureImage(image, options.pullPolicy ?? this.pullPolicy);
    if (plan.mode === "proxy") await this.ensureImage(this.egressProxyImage, this.pullPolicy);

    const name = `${this.containerNamePrefix}${input.id}`;
    const ports = (input.spec.ports ?? []).map((port) => `${port}/tcp`);
    const exposedPorts = Object.fromEntries(ports.map((port) => [port, {}]));
    const portBindings = Object.fromEntries(ports.map((port) => [port, [{ HostIp: this.portBindingHost, HostPort: "" }]]));
    const { vcpus, memoryMb } = input.spec.resources ?? {};
    const undo: (() => Promise<unknown>)[] = [];
    try {
      let env = input.spec.env ?? {};
      let proxy: Container | undefined;
      let internalNetwork: string | undefined;
      if (plan.mode === "proxy") {
        internalNetwork = `${name}-net`;
        const network = await this.docker.createNetwork({
          Name: internalNetwork,
          Driver: "bridge",
          Internal: true,
          Labels: { [DOCKER_EGRESS_PROXY_LABEL]: input.id },
        });
        undo.push(() => network.remove());
        const subnets = ((await network.inspect()) as Docker.NetworkInspectInfo).IPAM?.Config?.flatMap((config) =>
          config.Subnet ? [config.Subnet] : [],
        );
        const config = egressProxyConfig(plan, input.spec, subnets ?? []);
        const egressProxy = await this.docker.createContainer({
          name: `${name}-egress`,
          Image: this.egressProxyImage,
          Env: [`${EGRESS_PROXY_CONFIG_ENV}=${JSON.stringify(config)}`],
          Labels: { ...options.labels, [DOCKER_EGRESS_PROXY_LABEL]: input.id },
          ExposedPorts: exposedPorts,
          HostConfig: {
            Init: true,
            NetworkMode: plan.outsideNetwork,
            PortBindings: portBindings,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
            RestartPolicy: { Name: "on-failure" },
          },
        });
        proxy = egressProxy;
        undo.push(() => egressProxy.remove({ force: true }));
        await network.connect({ Container: egressProxy.id, EndpointConfig: { Aliases: [EGRESS_PROXY_ALIAS] } });
        env = { ...egressProxyEnv(plan.proxyPort), ...env };
      }

      const container = await this.docker.createContainer({
        name,
        Image: image,
        Entrypoint: ["/bin/sh", "-c", KEEPALIVE_SCRIPT],
        Cmd: [],
        WorkingDir: input.workdir,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        User: options.user,
        Labels: { ...options.labels, [DOCKER_SANDBOX_ID_LABEL]: input.id },
        ExposedPorts: exposedPorts,
        HostConfig: {
          Init: true,
          // Behind a proxy, the proxy publishes the ports: Docker publishes none from internal networks.
          PortBindings: proxy ? {} : portBindings,
          Memory: memoryMb ? memoryMb * 1024 * 1024 : undefined,
          NanoCpus: vcpus ? Math.round(vcpus * 1e9) : undefined,
          NetworkMode: internalNetwork ?? (plan.mode === "direct" ? plan.networkMode : undefined),
        },
        NetworkingConfig: internalNetwork
          ? { EndpointsConfig: { [internalNetwork]: { Aliases: [SANDBOX_ALIAS] } } }
          : undefined,
      });
      undo.push(() => container.remove({ force: true }));
      if (proxy) {
        await proxy.start();
        await this.waitForEgressProxy(proxy);
      }
      await container.start();
      return { providerRef: container.id };
    } catch (error) {
      for (const step of undo.reverse()) await step().catch(() => undefined);
      throw error;
    }
  }

  async wake(sandbox: ProviderSandbox): Promise<void> {
    const info = await this.inspect(sandbox);
    if (usesEgressProxy(sandbox.spec)) {
      const proxy = await this.requireEgressProxy(sandbox);
      if (!(await proxy.inspect()).State.Running) await proxy.start();
      await this.waitForEgressProxy(proxy);
    }
    if (!info.State.Running) {
      await this.container(sandbox).start();
    }
  }

  async stop(sandbox: ProviderSandbox): Promise<void> {
    const info = await this.inspect(sandbox);
    if (info.State.Running) await stopContainer(this.container(sandbox));
    if (usesEgressProxy(sandbox.spec)) {
      const proxy = await this.findEgressProxy(sandbox);
      if (proxy) await stopContainer(proxy);
    }
  }

  async destroy(sandbox: ProviderSandbox): Promise<void> {
    await ignoreNotFound(this.container(sandbox).remove({ force: true, v: true }));
    // The egress proxy and internal network, if any. Looked up by label so they are removed even if the spec changed.
    const filters = { label: [`${DOCKER_EGRESS_PROXY_LABEL}=${sandbox.id}`] };
    for (const proxy of await this.docker.listContainers({ all: true, filters })) {
      await ignoreNotFound(this.docker.getContainer(proxy.Id).remove({ force: true }));
    }
    for (const network of await this.docker.listNetworks({ filters })) {
      await ignoreNotFound(this.docker.getNetwork(network.Id).remove());
    }
  }

  async status(sandbox: ProviderSandbox): Promise<ProviderSandboxStatus> {
    try {
      const info = await this.inspect(sandbox);
      if (!usesEgressProxy(sandbox.spec)) return info.State.Running ? "running" : "stopped";
      // Without its proxy the sandbox cannot reach anything: it only counts as running with it.
      const proxy = await this.findEgressProxy(sandbox);
      if (!proxy) return "missing";
      return info.State.Running && (await proxy.inspect()).State.Running ? "running" : "stopped";
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
    let info = await this.assertRunning(sandbox);
    if (usesEgressProxy(sandbox.spec)) info = await (await this.requireEgressProxy(sandbox)).inspect();
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

  private async findEgressProxy(sandbox: ProviderSandbox): Promise<Container | null> {
    const [proxy] = await this.docker.listContainers({
      all: true,
      filters: { label: [`${DOCKER_EGRESS_PROXY_LABEL}=${sandbox.id}`] },
    });
    return proxy ? this.docker.getContainer(proxy.Id) : null;
  }

  private async requireEgressProxy(sandbox: ProviderSandbox): Promise<Container> {
    const proxy = await this.findEgressProxy(sandbox);
    if (!proxy) {
      throw new SandboxError(`The egress proxy of sandbox "${sandbox.id}" no longer exists; destroy and recreate the sandbox`);
    }
    return proxy;
  }

  /** Waits for the proxy's HEALTHCHECK to pass. An image without one counts as ready once running. */
  private async waitForEgressProxy(proxy: Container): Promise<void> {
    const deadline = Date.now() + this.egressProxyStartTimeoutMs;
    for (;;) {
      const { Name, State } = await proxy.inspect();
      const health = State.Health?.Status;
      if (State.Running && (health === undefined || health === "healthy")) return;
      const name = Name.replace(/^\//, "");
      if (!State.Running && !State.Restarting) {
        throw new SandboxError(`Egress proxy ${name} exited with code ${State.ExitCode}; see \`docker logs ${name}\``);
      }
      if (health === "unhealthy" || Date.now() > deadline) {
        throw new SandboxError(`Egress proxy ${name} did not become healthy; see \`docker logs ${name}\``);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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

async function stopContainer(container: Container): Promise<void> {
  try {
    await container.stop({ t: 10 });
  } catch (error) {
    if (statusCode(error) !== 304) throw error; // 304: already stopped
  }
}

async function ignoreNotFound(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
  }
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
