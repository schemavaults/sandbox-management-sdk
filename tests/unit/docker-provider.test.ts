import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Docker from "dockerode";
import { SandboxManager } from "../../src/index.js";
import type { SandboxSpec } from "../../src/index.js";
import { DOCKER_EGRESS_PROXY_IMAGE, DOCKER_EGRESS_PROXY_LABEL, DockerSandboxProvider } from "../../src/docker/index.js";
import { InMemorySandboxStore } from "../../src/testing/index.js";

/** Just enough of dockerode for `create`: records what was created and in which order. */
function fakeDocker({ proxyHealth = "healthy" }: { proxyHealth?: string } = {}) {
  const events: string[] = [];
  const containers: Docker.ContainerCreateOptions[] = [];
  const networks: Docker.NetworkCreateOptions[] = [];
  const docker = {
    getImage: (image: string) => ({ inspect: async () => events.push(`inspect image ${image}`) }),
    createNetwork: async (options: Docker.NetworkCreateOptions) => {
      networks.push(options);
      events.push(`create network ${options.Name}`);
      return {
        id: "network-1",
        inspect: async () => ({ IPAM: { Config: [{ Subnet: "172.30.0.0/16" }] } }),
        connect: async ({ Container, EndpointConfig }: { Container: string; EndpointConfig: { Aliases: string[] } }) =>
          events.push(`connect ${Container} as ${EndpointConfig.Aliases.join(",")}`),
        remove: async () => events.push(`remove network ${options.Name}`),
      };
    },
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      containers.push(options);
      events.push(`create ${options.name}`);
      const isProxy = options.Image === DOCKER_EGRESS_PROXY_IMAGE;
      return {
        id: `id-${options.name}`,
        start: async () => events.push(`start ${options.name}`),
        inspect: async () => ({
          Name: `/${options.name}`,
          State: { Running: true, Health: isProxy ? { Status: proxyHealth } : undefined },
        }),
        remove: async () => events.push(`remove ${options.name}`),
      };
    },
  };
  return { docker: docker as unknown as Docker, events, containers, networks };
}

function setup(options: { proxyHealth?: string } = {}) {
  const fake = fakeDocker(options);
  const provider = new DockerSandboxProvider({ docker: fake.docker, defaultImage: "alpine", egressProxyStartTimeoutMs: 200 });
  const create = (spec: SandboxSpec) => provider.create({ id: "sbx-1", spec, workdir: "/workspace", ownerId: null, labels: {} });
  return { ...fake, provider, create };
}

const envOf = (options: Docker.ContainerCreateOptions) =>
  Object.fromEntries((options.Env ?? []).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));

describe("DockerSandboxProvider network policies", () => {
  it('uses --network none for "deny-all" without ports, and the configured network otherwise', async () => {
    const { containers, networks, create } = setup();
    await create({ network: "deny-all" });
    await create({ network: "deny-all", providerOptions: { docker: { network: "none" } } });
    await create({});
    await create({ network: "allow-all", providerOptions: { docker: { network: "my-net" } } });
    expect(containers.map((options) => options.HostConfig?.NetworkMode)).toEqual(["none", "none", undefined, "my-net"]);
    expect(networks).toHaveLength(0);
  });

  it("puts an allowlisted sandbox on an internal network behind a hardened egress proxy", async () => {
    const { create, events, containers, networks } = setup();
    await create({
      network: { allowDomains: ["github.com"], allowCidrs: ["10.0.0.0/8"] },
      ports: [3000],
      env: { NO_PROXY: "localhost,internal.dev" },
      providerOptions: { docker: { network: "outside", labels: { team: "a" } } },
    });

    expect(networks).toEqual([
      { Name: "sandbox-sbx-1-net", Driver: "bridge", Internal: true, Labels: { [DOCKER_EGRESS_PROXY_LABEL]: "sbx-1" } },
    ]);
    const [proxy, sandbox] = containers;
    expect(proxy).toMatchObject({
      name: "sandbox-sbx-1-egress",
      Image: DOCKER_EGRESS_PROXY_IMAGE,
      Labels: { team: "a", [DOCKER_EGRESS_PROXY_LABEL]: "sbx-1" },
      HostConfig: {
        NetworkMode: "outside",
        PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
      },
    });
    expect(JSON.parse(envOf(proxy!).SANDBOX_EGRESS_PROXY_CONFIG!)).toEqual({
      port: 3128,
      policy: { allowDomains: ["github.com"], allowCidrs: ["10.0.0.0/8"] },
      clients: ["172.30.0.0/16"],
      forwards: [{ port: 3000, host: "sandbox", targetPort: 3000 }],
    });

    expect(sandbox).toMatchObject({
      name: "sandbox-sbx-1",
      HostConfig: { NetworkMode: "sandbox-sbx-1-net", PortBindings: {} },
      NetworkingConfig: { EndpointsConfig: { "sandbox-sbx-1-net": { Aliases: ["sandbox"] } } },
    });
    expect(envOf(sandbox!)).toMatchObject({
      HTTPS_PROXY: "http://egress-proxy:3128",
      http_proxy: "http://egress-proxy:3128",
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "localhost,internal.dev", // spec.env wins
    });

    // The proxy is up and healthy before the sandbox starts.
    expect(events.filter((event) => !event.startsWith("inspect image"))).toEqual([
      "create network sandbox-sbx-1-net",
      "create sandbox-sbx-1-egress",
      "connect id-sandbox-sbx-1-egress as egress-proxy",
      "create sandbox-sbx-1",
      "start sandbox-sbx-1-egress",
      "start sandbox-sbx-1",
    ]);
  });

  it('runs "deny-all" with ports behind a proxy that allows nothing, on a port clear of the published ones', async () => {
    const { create, containers } = setup();
    await create({ network: "deny-all", ports: [3128, 3129, 8080] });
    const config = JSON.parse(envOf(containers[0]!).SANDBOX_EGRESS_PROXY_CONFIG!);
    expect(config).toMatchObject({ port: 3130, policy: {} });
    expect(envOf(containers[1]!).HTTP_PROXY).toBe("http://egress-proxy:3130");
  });

  it("rejects specs it cannot honor before touching Docker", async () => {
    const { events, create } = setup();
    await expect(create({ network: "deny-all", providerOptions: { docker: { network: "my-net" } } })).rejects.toThrow(
      'conflicts with spec.providerOptions.docker.network "my-net"',
    );
    for (const network of ["none", "host", "container:other"]) {
      await expect(create({ network: { allowDomains: ["github.com"] }, providerOptions: { docker: { network } } })).rejects.toThrow(
        `docker.network "${network}" cannot carry the egress proxy's traffic`,
      );
    }
    expect(events).toHaveLength(0);
  });

  it("removes what it created when the proxy does not become healthy", async () => {
    const { create, events } = setup({ proxyHealth: "starting" });
    await expect(create({ network: { allowDomains: ["github.com"] } })).rejects.toThrow(
      "Egress proxy sandbox-sbx-1-egress did not become healthy; see `docker logs sandbox-sbx-1-egress`",
    );
    expect(events.slice(-3)).toEqual(["remove sandbox-sbx-1", "remove sandbox-sbx-1-egress", "remove network sandbox-sbx-1-net"]);
  });

  it("enforces every network policy through the manager", async () => {
    const { provider } = setup();
    const manager = new SandboxManager({ providers: [provider], store: new InMemorySandboxStore() });
    expect((await manager.create({ spec: { network: { allowDomains: ["github.com"] } } })).status).toBe("running");
  });

  it("defaults to the proxy image published for this version", () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    expect(DOCKER_EGRESS_PROXY_IMAGE).toBe(`ghcr.io/schemavaults/sandbox-egress-proxy:${version}`);
  });
});
