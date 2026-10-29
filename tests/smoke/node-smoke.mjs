// Imports the built package (dist/) by its own name under Node, to check that
// every entry point resolves and loads outside Bun. Run after `bun run build`.
import assert from "node:assert/strict";
import { InMemorySandboxStore, SandboxManager } from "@schemavaults/sandbox-management-sdk";
import { DbhSandboxStore, down, up } from "@schemavaults/sandbox-management-sdk/dbh";
import * as migration from "@schemavaults/sandbox-management-sdk/dbh/migration";
import { DockerSandboxProvider } from "@schemavaults/sandbox-management-sdk/docker";
import { MockSandboxProvider } from "@schemavaults/sandbox-management-sdk/testing";
import { VercelSandboxProvider } from "@schemavaults/sandbox-management-sdk/vercel";

const provider = new MockSandboxProvider();
const manager = new SandboxManager({ providers: [provider], store: new InMemorySandboxStore() });

const sandbox = await manager.create({ spec: { setup: "echo hi", start: "serve", ports: [3000] }, ownerId: "smoke" });
assert.equal(sandbox.status, "running");
await manager.stop(sandbox.id);
assert.equal((await manager.exec(sandbox.id, "ls")).exitCode, 0);
assert.equal((await manager.get(sandbox.id)).status, "running");
assert.equal(provider.callsFor(sandbox.id, "wake").length, 1);
assert.equal((await manager.destroy(sandbox.id)).status, "destroyed");

assert.equal(typeof new DockerSandboxProvider().create, "function");
assert.equal(new VercelSandboxProvider().defaultWorkdir, "/vercel/sandbox");
assert.equal(typeof (await import("@vercel/sandbox")).Sandbox.create, "function");
assert.equal(typeof DbhSandboxStore, "function");
assert.equal(migration.up, up);
assert.equal(migration.down, down);

console.log(`Node smoke test passed on ${process.version}`);
