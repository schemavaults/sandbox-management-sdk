// Code samples shown on the landing page. They mirror the examples in the
// repository README; keep the two in step when the API changes.

export const heroSnippet = `const sandbox = await sandboxes.create({
  spec: {
    git: { url: "https://github.com/acme/app.git" },
    setup: ["npm ci"],
    start: "npm run dev -- --port 3000",
    ports: [3000],
  },
});

await sandboxes.getUrl(sandbox.id, 3000); // https://….vercel.run
await sandboxes.stop(sandbox.id);         // filesystem is kept
await sandboxes.exec(sandbox.id, "ls");   // auto-resumes first`;

export const installCommands = {
  bun: `bun add @schemavaults/sandbox-management-sdk
# plus whichever backends you use (all optional peer dependencies):
bun add dockerode              # Docker provider
bun add @vercel/sandbox        # Vercel provider
bun add @schemavaults/dbh      # Postgres store (or any Kysely instance)`,
  npm: `npm install @schemavaults/sandbox-management-sdk
# plus whichever backends you use (all optional peer dependencies):
npm install dockerode              # Docker provider
npm install @vercel/sandbox        # Vercel provider
npm install @schemavaults/dbh      # Postgres store (or any Kysely instance)`,
  pnpm: `pnpm add @schemavaults/sandbox-management-sdk
# plus whichever backends you use (all optional peer dependencies):
pnpm add dockerode              # Docker provider
pnpm add @vercel/sandbox        # Vercel provider
pnpm add @schemavaults/dbh      # Postgres store (or any Kysely instance)`,
} as const;

export const quickStartSnippet = `import { SandboxManager } from "@schemavaults/sandbox-management-sdk";
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
    resume: "npm run dev -- --port 3000", // defaults to \`start\`
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
await sandboxes.destroy(sandbox.id);`;

export const logsSnippet = `await sandboxes.getMainProcess(id); // { pid, running, exitCode }
await sandboxes.readLogs(id);       // everything so far

const signal = AbortSignal.timeout(60_000);

for await (const chunk of sandboxes.logs(id, { follow: true, signal })) {
  process.stdout.write(chunk);
}`;

export const filesSnippet = `await sandboxes.writeFiles(id, [
  { path: "prompt.md", content: "…" },
  { path: "/usr/local/bin/x", content: bytes, mode: 0o755 },
]);

// null if the file is missing
await sandboxes.readTextFile(id, "out/result.json");`;

export const dockerSnippet = `import Docker from "dockerode";
import { DockerSandboxProvider } from "@schemavaults/sandbox-management-sdk/docker";

new DockerSandboxProvider({
  // default: new Docker(), which honors DOCKER_HOST
  docker: new Docker({ socketPath: "/var/run/docker.sock" }),
  defaultImage: "node:24-bookworm",
  pullPolicy: "if-not-present",   // or "always" / "never"
  portBindingHost: "127.0.0.1",   // where published ports bind
  urlHost: "localhost",           // host used in getUrl() URLs
});`;

export const vercelSnippet = `import { VercelSandboxProvider } from "@schemavaults/sandbox-management-sdk/vercel";

new VercelSandboxProvider({
  credentials: { token, teamId, projectId }, // omit to use VERCEL_OIDC_TOKEN
  defaultImage: "vercel/sandbox/universal",
});

// timeoutMs becomes the native sandbox timeout; extend it when needed:
await sandboxes.extendTimeout(id, 10 * 60_000);`;

export const customProviderSnippet = `import {
  shellGetMainProcess,
  shellReadMainLog,
  shellStartMainProcess,
  type NormalizedCommand,
  type ProviderSandbox,
  type SandboxProvider,
} from "@schemavaults/sandbox-management-sdk";

export class MyProvider implements SandboxProvider {
  readonly name = "my-backend";
  readonly defaultWorkdir = "/workspace";

  // create, wake, stop, destroy, status, exec,
  // writeFiles, readFile, getUrl …

  // Main process and logs, built on top of exec() and your backend's
  // own way to run a command without waiting for it (spawnDetached):
  startMainProcess(sandbox: ProviderSandbox, command: NormalizedCommand) {
    return shellStartMainProcess(
      (cmd) => this.exec(sandbox, cmd),
      (cmd) => this.spawnDetached(sandbox, cmd),
      command,
    );
  }
  getMainProcess(sandbox: ProviderSandbox) {
    return shellGetMainProcess((cmd) => this.exec(sandbox, cmd));
  }
  readMainLog(sandbox: ProviderSandbox, offset: number) {
    return shellReadMainLog((cmd) => this.exec(sandbox, cmd), offset);
  }
}`;

export const migrationSnippet = `export { up, down } from "@schemavaults/sandbox-management-sdk/dbh/migration";`;

export const dbhStoreSnippet = `import {
  DbhSandboxStore,
  createSandboxesMigration,
} from "@schemavaults/sandbox-management-sdk/dbh";

// a dbh handler, or any Kysely instance using the Postgres dialect
const store = new DbhSandboxStore({ db: dbh });

// custom table name:
const { up, down } = createSandboxesMigration("my_sandboxes");
const custom = new DbhSandboxStore({ db: dbh, tableName: "my_sandboxes" });`;

export const testingSnippet = `import { SandboxManager } from "@schemavaults/sandbox-management-sdk";
import {
  InMemorySandboxStore,
  MockSandboxProvider,
} from "@schemavaults/sandbox-management-sdk/testing";

const provider = new MockSandboxProvider({
  execHandler: ({ command }) =>
    command.args.includes("npm test")
      ? { exitCode: 1, stderr: "1 failing" }
      : undefined,
});
const sandboxes = new SandboxManager({
  providers: [provider],
  store: new InMemorySandboxStore(),
});

// …exercise your code, then assert on what happened:
provider.callsFor(id, "exec");
provider.simulateExternalStop(id); // e.g. a provider-side timeout
provider.appendMainLog(id, "server listening\\n");`;
