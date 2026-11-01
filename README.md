# @schemavaults/sandbox-management-sdk

A TypeScript SDK for running sandboxes on any backend through one API. You can create, set up, start, stop, resume, list and destroy sandboxes on Docker or [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), and the sandbox state lives in your app's own database.

- **One lifecycle everywhere.** `create` clones an optional git repo, runs `setup` once and launches `start` as the long-running main process. `stop` keeps the filesystem. Touching a stopped sandbox wakes it and runs `resume`.
- **State in your database.** Records go through a `SandboxStore`. The SDK ships an in-memory store, a Kysely / [`@schemavaults/dbh`](https://github.com/schemavaults/dbh) Postgres store with a migration, and a Web Storage store (`localStorage` / `sessionStorage`) for browsers. Every status change is a compare-and-set, so many server processes can share sandboxes safely.
- **Runtimes.** Runs on Node.js ≥ 24 and Bun, and the core, Vercel adapter and dbh store also run in serverless functions. The core and the Web Storage store also run in browsers.

```
bun add @schemavaults/sandbox-management-sdk
# plus whichever backends you use (all optional peer dependencies):
bun add dockerode              # Docker provider
bun add @vercel/sandbox        # Vercel provider
bun add @schemavaults/dbh      # Postgres store (or any Kysely instance)
```

| Entry point | Contents |
| --- | --- |
| `@schemavaults/sandbox-management-sdk` | `SandboxManager`, `InMemorySandboxStore`, types, errors, helpers for writing providers |
| `…/docker` | `DockerSandboxProvider` |
| `…/vercel` | `VercelSandboxProvider` |
| `…/dbh` | `DbhSandboxStore`, `createSandboxesMigration`, `up` / `down` |
| `…/dbh/migration` | `up` / `down` only, to re-export from a migrations directory |
| `…/web-storage` | `WebStorageSandboxStore` (browser `localStorage` / `sessionStorage`) |
| `…/testing` | `MockSandboxProvider`, `InMemorySandboxStore` |

## Quick start

```ts
import { SandboxManager } from "@schemavaults/sandbox-management-sdk";
import { DockerSandboxProvider } from "@schemavaults/sandbox-management-sdk/docker";
import { VercelSandboxProvider } from "@schemavaults/sandbox-management-sdk/vercel";
import { DbhSandboxStore } from "@schemavaults/sandbox-management-sdk/dbh";
import createDbh from "@schemavaults/dbh";

const dbh = await createDbh("postgres", { environment: "production" });

const sandboxes = new SandboxManager({
  providers: [
    new DockerSandboxProvider({ defaultImage: "node:24-bookworm" }),
    new VercelSandboxProvider(), // uses VERCEL_OIDC_TOKEN, or pass { credentials }
  ],
  defaultProvider: "vercel",
  store: new DbhSandboxStore({ db: dbh }),
});

const sandbox = await sandboxes.create({
  ownerId: user.id,
  labels: { project: "acme" },
  spec: {
    git: { url: "https://github.com/acme/app.git", revision: "main", depth: 1 },
    setup: ["npm ci", "npm run build"],
    start: "npm run dev -- --port 3000",
    resume: "npm run dev -- --port 3000", // defaults to `start`
    ports: [3000],
    env: { NODE_ENV: "development" },
    timeoutMs: 30 * 60_000,
    resources: { vcpus: 2 },
  },
  onStdout: (chunk) => process.stdout.write(chunk), // setup output
});

await sandboxes.getUrl(sandbox.id, 3000);           // https://….vercel.run
await sandboxes.exec(sandbox.id, "npm test");        // { exitCode, stdout, stderr }
await sandboxes.stop(sandbox.id);                    // filesystem is kept
await sandboxes.exec(sandbox.id, "ls");              // auto-resumes first
await sandboxes.list({ ownerId: user.id, labels: { project: "acme" } });
await sandboxes.destroy(sandbox.id);
```

## Concepts

### The spec

The `SandboxSpec` is stored with the sandbox, so any process can later resume it by ID alone. Any of these fields can be left out:

| Field | Meaning |
| --- | --- |
| `workdir` | Absolute directory commands run in. Default: `/workspace` (Docker), `/vercel/sandbox` (Vercel). |
| `env` | Environment variables for every command. |
| `git` | `{ url, revision?, depth?, auth? }`, cloned into `workdir` before setup. `revision` may be a branch, tag or commit SHA. `auth` is sent as a one-off HTTP header and never written to `.git/config`. The image needs `git`. |
| `setup` | One command or a list of them, run once after creation. Stops at the first non-zero exit. |
| `start` | The main process, launched detached after setup. |
| `resume` | Launched detached as the new main process whenever a stopped sandbox is woken. Defaults to `start`. |
| `ports` | Ports reachable through `getUrl`. |
| `timeoutMs` | Maximum run time. Vercel enforces it itself. For Docker, call `stopExpired()` periodically. |
| `resources` | `{ vcpus?, memoryMb? }`. Vercel only supports `vcpus` (2 GB of memory per vCPU). |
| `network` | Outbound access: `"allow-all"` (default), `"deny-all"`, or an allowlist `{ allowDomains?, allowCidrs?, denyCidrs? }`. See [Network access](#network-access). |
| `providerOptions` | Provider-specific settings: `{ docker: { image, user, network, pullPolicy, labels } }` or `{ vercel: { image \| runtime, region, networkPolicy, tags } }`. |

A command is either a string, run with `sh -c`, or `{ cmd, args?, cwd?, env? }`, run as an exact argv with no shell. A relative `cwd` resolves against `workdir`.

> `spec.env` and `git.auth` are stored in your store as-is. Treat the table as sensitive, or pass short-lived credentials.

### Network access

`spec.network` limits where a sandbox can connect, for example so that an agent can only reach the platforms it works with:

```ts
await sandboxes.create({
  spec: {
    git: { url: "https://github.com/acme/agent.git" },
    setup: "npm ci",
    start: "node agent.js",
    network: {
      allowDomains: ["github.com", "*.github.com", "registry.npmjs.org", "api.acme.dev"],
      allowCidrs: ["203.0.113.10", "198.51.100.0/24"], // IP addresses or CIDR ranges
      denyCidrs: ["169.254.169.254"],                  // always blocked, even for allowed domains
    },
  },
});
```

- Everything not on the allowlist is blocked. `"deny-all"` blocks everything, and `"allow-all"` (the default) blocks nothing.
- The policy applies from creation, so `git` and `setup` run under it too. Allow your git host and package registries, or those steps fail.
- A provider only gets sandboxes whose policy it can enforce. Otherwise `create` throws before anything is created or stored, so a policy is never silently ignored.

| Provider | `"deny-all"` | Allowlist |
| --- | --- | --- |
| Vercel | Yes | Yes, as the native network policy |
| Docker | Yes, with `--network none` (so no `ports`) | No |

### Lifecycle

```
create ─► provisioning ─► setting_up ─► starting ─► running ◄──► stopping ─► stopped
                                                        ▲                       │
                                                        └──────── resuming ◄────┘
any ─► destroying ─► destroyed          failures ─► failed
```

- **Auto-resume.** `exec`, `getUrl`, `readFile`, `writeFiles`, `logs` and the other operations on a stopped sandbox first wake it and launch `resume`. This also covers a sandbox the provider stopped by itself (for example a Vercel timeout). Turn it off with `autoResume: false`, and call `resume(id)` yourself.
- **Concurrency.** Status changes are compare-and-set on a version column. If several requests hit a stopped sandbox at once, exactly one resumes it and the others wait for it (up to `transitionTimeoutMs`, default 10 minutes).
- **Failures.** A failing setup step (`SandboxCommandError`) or provider error marks the sandbox `failed` and keeps the provider sandbox so you can inspect it. Call `destroy` to remove it. `resume` also retries a failed sandbox (without re-running setup).
- **Destroyed records are kept**, but `list` hides them unless you pass `includeDestroyed: true`.
- **`reconcile(ids?)`** syncs records with what the providers report: sandboxes stopped behind the SDK's back become `stopped`, vanished ones become `failed`, and transitions abandoned by a crashed process are settled.

### Main process and logs

`start` and `resume` run detached. Their stdout and stderr are appended to `/tmp/sandbox-sdk/main.log` inside the sandbox, which survives restarts:

```ts
await sandboxes.getMainProcess(id); // { pid, running, exitCode }
await sandboxes.readLogs(id);       // everything so far
for await (const chunk of sandboxes.logs(id, { follow: true, signal })) {
  process.stdout.write(chunk);
}
```

Only the first log read auto-resumes a stopped sandbox. A `follow` stream ends when the sandbox stops or `signal` aborts.

### Files

```ts
await sandboxes.writeFiles(id, [{ path: "prompt.md", content: "…" }, { path: "/usr/local/bin/x", content: bytes, mode: 0o755 }]);
await sandboxes.readTextFile(id, "out/result.json"); // null if missing
```

## Providers

### Docker

```ts
new DockerSandboxProvider({
  docker: new Docker({ socketPath: "/var/run/docker.sock" }), // default: new Docker() (honors DOCKER_HOST)
  defaultImage: "node:24-bookworm",
  pullPolicy: "if-not-present",   // or "always" / "never"
  portBindingHost: "127.0.0.1",   // where published ports bind
  urlHost: "localhost",           // host used in getUrl() URLs
});
```

- Each sandbox is a long-lived container named `sandbox-<id>` and labeled `dev.schemavaults.sandbox.id=<id>`. It runs an idle PID 1 (the entrypoint is overridden; the image needs `/bin/sh`) with `--init`.
- `stop` and `wake` map to `docker stop` and `docker start`, so the container filesystem persists. Published ports get random host ports again on every start, and `getUrl` looks them up.
- Docker has no native timeout. Run `sandboxes.stopExpired()` from a cron job.
- If a command passed to `exec` with `timeoutMs` or `signal` is abandoned, the process inside the container keeps running.
- `spec.network: "deny-all"` runs the container with `--network none`, so it cannot publish `ports` or join `providerOptions.docker.network`. Docker cannot enforce allowlists, so `create` refuses them. To filter traffic yourself, attach the containers to an `--internal` network behind a proxy you run, with `providerOptions.docker.network`.

### Vercel Sandbox

```ts
new VercelSandboxProvider({
  credentials: { token, teamId, projectId }, // omit to use VERCEL_OIDC_TOKEN
  defaultImage: "vercel/sandbox/universal",
});
```

- Sandboxes are created `persistent` and named after the SDK ID. `stop` snapshots the filesystem and `wake` restores it.
- `timeoutMs` becomes the native sandbox timeout, and `extendTimeout(id, ms)` extends it. The SDK detects when Vercel has stopped a sandbox and resumes it through its own `resume` flow, instead of letting `@vercel/sandbox` resume it silently without relaunching your main process.
- `spec.network` becomes the sandbox's native network policy. For rules `spec.network` cannot express, such as injecting an API key header into requests to one domain, pass a `@vercel/sandbox` `NetworkPolicy` as `providerOptions.vercel.networkPolicy` instead (`toVercelNetworkPolicy(network)` gives you a starting point). The two cannot be combined.

### Writing a provider

Implement `SandboxProvider` (see `src/provider.ts`). For backends that can only "run a command", the exported `shellStartMainProcess`, `shellGetMainProcess` and `shellReadMainLog` implement the main-process and log bookkeeping on top of `exec`.

If your backend can restrict network access, list what it enforces in `networkPolicies` (`"deny-all"`, `"allowlist"`) and apply `spec.network` in `create`. A provider without `networkPolicies` is only given sandboxes with unrestricted access. `networkPolicyKind` and `normalizeCidr` help with the mapping.

## Stores

### Postgres via `@schemavaults/dbh` / Kysely

Add the migration to your dbh migrations directory:

```ts
// src/db/migrations/00012-create-sandboxes.ts
export { up, down } from "@schemavaults/sandbox-management-sdk/dbh/migration";
```

For a different table name, use `createSandboxesMigration("my_sandboxes")` and `new DbhSandboxStore({ db, tableName: "my_sandboxes" })`. The store takes a dbh handler or any Kysely instance using the Postgres dialect. It never opens or closes connections itself, so the `postgres-neon-proxy` adapter works unchanged.

### Browser storage (`localStorage` / `sessionStorage`)

For an app with no database, such as a demo or a local-first tool, keep records in the browser. The core has no Node.js dependencies, so `SandboxManager` runs in the page too:

```ts
import { WebStorageSandboxStore } from "@schemavaults/sandbox-management-sdk/web-storage";

const store = new WebStorageSandboxStore();                          // localStorage
const perTab = new WebStorageSandboxStore({ storage: sessionStorage, prefix: "my-app:sandboxes:" });
```

Each record is one JSON entry under `prefix + id` (default prefix `sandbox-sdk:sandboxes:`), with dates as ISO strings, so you can inspect it in the browser's dev tools. `update` reads and writes synchronously, which makes it an atomic compare-and-set within one page. Browsers do not guarantee that across tabs sharing `localStorage`, so give tabs that write the same records their own `prefix` or `ownerId`, or use `sessionStorage`. The store also accepts any object with the Web Storage API (`length`, `key`, `getItem`, `setItem`, `removeItem`). Storage quotas are around 5 MB per origin.

### Your own store

Implement `SandboxStore` (`insert`, `get`, `list`, `update`, `delete`). `update` must be an atomic compare-and-set on `version`. Run the shared contract suite in `tests/contracts/store-contract.ts` against your store to check it.

## Testing your app

```ts
import { MockSandboxProvider, InMemorySandboxStore } from "@schemavaults/sandbox-management-sdk/testing";

const provider = new MockSandboxProvider({
  execHandler: ({ command }) => (command.args.includes("npm test") ? { exitCode: 1, stderr: "1 failing" } : undefined),
});
const sandboxes = new SandboxManager({ providers: [provider], store: new InMemorySandboxStore() });

// …exercise your code, then assert on what happened:
provider.callsFor(id, "exec");
provider.simulateExternalStop(id); // e.g. a provider-side timeout
provider.appendMainLog(id, "server listening\n");
```

The mock executes nothing. It records every call, keeps files in memory, and simulates stop, wake and external stops. It accepts every `spec.network` policy; pass `networkPolicies` to simulate a provider that enforces fewer.

## Development

```bash
bun install
bun run lint && bun run typecheck && bun run build
bun run test:unit                                  # no external services needed

bun run test:e2e:fixture-image && bun run test:e2e:docker    # needs a Docker daemon
bun run test:e2e:dbh                                         # needs Postgres (POSTGRES_* env vars)
node ./tests/smoke/node-smoke.mjs                            # built package under Node (after build)
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, build, the unit tests and a Node 24 smoke test. It also runs the Docker e2e suite against the runner's Docker daemon, and the store suite against a Postgres service container. The Vercel adapter is tested against a fake `@vercel/sandbox` client, with no live API calls.

### Website

The landing page in `website/` is a static Next.js export built with [`@schemavaults/ui`](https://github.com/schemavaults/ui), with its own `package.json` and lockfile. Its hero runs an agent demo on the SDK's own build, so build the SDK first:

```bash
bun install && bun run build                       # the SDK, into dist/
cd website && bun install
bun run dev                                        # http://localhost:3000
bun run build                                      # static export in website/out
```

`.github/workflows/pages.yml` builds it on pull requests that touch it and deploys it to GitHub Pages on every push to `main` (set **Settings → Pages → Source** to **GitHub Actions** once). Its code samples live in `website/src/content/snippets.ts`; keep them in step with this README. See [`website/README.md`](website/README.md) for details.

### Releasing

Bump `version` in `package.json`, merge, and publish a GitHub release. `.github/workflows/publish.yml` publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no token), and skips if that version is already on npm.
