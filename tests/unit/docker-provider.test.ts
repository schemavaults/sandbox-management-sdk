import { describe, expect, it } from "bun:test";
import type Docker from "dockerode";
import { SandboxManager } from "../../src/index.js";
import type { SandboxSpec } from "../../src/index.js";
import { DockerSandboxProvider } from "../../src/docker/index.js";
import { InMemorySandboxStore } from "../../src/testing/index.js";

/** Just enough of dockerode for `create`: records the container options it was given. */
function fakeDocker() {
  const created: Docker.ContainerCreateOptions[] = [];
  const docker = {
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      created.push(options);
      return { id: `container-${created.length}`, start: async () => undefined, remove: async () => undefined };
    },
  };
  return { docker: docker as unknown as Docker, created };
}

function setup() {
  const { docker, created } = fakeDocker();
  const provider = new DockerSandboxProvider({ docker, defaultImage: "alpine" });
  const create = (spec: SandboxSpec) => provider.create({ id: "sbx-1", spec, workdir: "/workspace", ownerId: null, labels: {} });
  return { provider, created, create };
}

describe("DockerSandboxProvider network policies", () => {
  it('runs "deny-all" sandboxes with --network none, and leaves other sandboxes on their configured network', async () => {
    const { created, create } = setup();
    await create({ network: "deny-all" });
    await create({ network: "deny-all", providerOptions: { docker: { network: "none" } } });
    await create({});
    await create({ network: "allow-all", providerOptions: { docker: { network: "my-net" } } });
    expect(created.map((options) => options.HostConfig?.NetworkMode)).toEqual(["none", "none", undefined, "my-net"]);
  });

  it("rejects specs it cannot honor before touching Docker", async () => {
    const { created, create } = setup();
    await expect(create({ network: "deny-all", ports: [3000] })).rejects.toThrow("spec.ports cannot be published");
    await expect(create({ network: "deny-all", providerOptions: { docker: { network: "my-net" } } })).rejects.toThrow(
      'conflicts with spec.providerOptions.docker.network "my-net"',
    );
    // The manager refuses allowlists up front; the provider refuses them too when called directly.
    await expect(create({ network: { allowDomains: ["github.com"] } })).rejects.toThrow(
      'Provider "docker" cannot enforce a network allowlist',
    );
    expect(created).toHaveLength(0);
  });

  it("is refused an allowlist by the manager without a record or container being created", async () => {
    const { provider, created } = setup();
    const store = new InMemorySandboxStore();
    const manager = new SandboxManager({ providers: [provider], store });
    await expect(manager.create({ spec: { network: { allowDomains: ["github.com"] } } })).rejects.toThrow(
      'cannot enforce a network allowlist (spec.network): it enforces only "deny-all"',
    );
    expect(await store.list()).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});
