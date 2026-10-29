import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import createDbh from "@schemavaults/dbh";
import type { IDatabaseHandler } from "@schemavaults/dbh/types/IDatabaseHandler.js";
import { Migrator } from "kysely/migration";
import { SandboxManager } from "../../src/index.js";
import { DbhSandboxStore, createSandboxesMigration, down, up } from "../../src/dbh/index.js";
import { MockSandboxProvider } from "../../src/testing/index.js";
import { describeStoreContract } from "../contracts/store-contract.js";

// Requires Postgres; connection settings come from the POSTGRES_* variables below.
const credentials = {
  POSTGRES_HOST: process.env.POSTGRES_HOST ?? "localhost",
  POSTGRES_PORT: process.env.POSTGRES_PORT ?? "5432",
  POSTGRES_USER: process.env.POSTGRES_USER ?? "postgres",
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? "postgres",
  POSTGRES_DATABASE: process.env.POSTGRES_DATABASE ?? "sandbox_sdk_test",
};

let dbh: IDatabaseHandler<object>;

beforeAll(async () => {
  process.env.SCHEMAVAULTS_DBH_DEBUG = "false"; // keep dbh from logging credential parsing
  dbh = await createDbh("postgres", { environment: "test", credentials });
  await down(dbh.db);
  // Apply the migration the way a host app would: through Kysely's Migrator, as `dbh migrate` does.
  const migrator = new Migrator({
    db: dbh.db,
    provider: { getMigrations: async () => ({ "00000-create-sandboxes": { up, down } }) },
    migrationTableName: "sandbox_sdk_test_migrations",
    migrationLockTableName: "sandbox_sdk_test_migrations_lock",
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await down(dbh.db);
  await dbh.db.schema.dropTable("sandbox_sdk_test_migrations").ifExists().execute();
  await dbh.db.schema.dropTable("sandbox_sdk_test_migrations_lock").ifExists().execute();
  await dbh.destroy();
});

describeStoreContract("DbhSandboxStore", async () => {
  await dbh.db.deleteFrom("sandboxes" as never).execute();
  return { store: new DbhSandboxStore({ db: dbh }) };
});

describe("DbhSandboxStore e2e", () => {
  it("supports a custom table name and a bare Kysely instance", async () => {
    const migration = createSandboxesMigration("custom_sandboxes");
    await migration.down(dbh.db);
    await migration.up(dbh.db);
    try {
      const store = new DbhSandboxStore({ db: dbh.db, tableName: "custom_sandboxes" });
      const manager = new SandboxManager({ providers: [new MockSandboxProvider()], store });
      const { id } = await manager.create({ spec: { start: "serve" }, ownerId: "u1", labels: { kind: "agent" } });
      expect((await manager.list({ ownerId: "u1", labels: { kind: "agent" } })).map((r) => r.id)).toEqual([id]);
    } finally {
      await migration.down(dbh.db);
    }
  });

  it("drives the full manager lifecycle, resuming exactly once across concurrent managers", async () => {
    await dbh.db.deleteFrom("sandboxes" as never).execute();
    const provider = new MockSandboxProvider({ lifecycleDelayMs: 20 });
    // Two managers sharing one database stand in for two server processes.
    const managers = [0, 1].map(
      () => new SandboxManager({ providers: [provider], store: new DbhSandboxStore({ db: dbh }), pollIntervalMs: 10 }),
    );
    const [first, second] = managers as [SandboxManager, SandboxManager];

    const record = await first.create({ spec: { start: "serve", timeoutMs: 60_000 }, ownerId: "owner" });
    expect(await second.get(record.id)).toEqual(record);

    await second.stop(record.id);
    const results = await Promise.all([
      first.exec(record.id, "echo a"),
      second.exec(record.id, "echo b"),
      first.exec(record.id, "echo c"),
    ]);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    expect(provider.callsFor(record.id, "wake")).toHaveLength(1);

    const resumed = await first.get(record.id);
    expect(resumed.status).toBe("running");
    expect(resumed.expiresAt).not.toBeNull();

    await second.destroy(record.id);
    expect(await first.list({ ownerId: "owner" })).toHaveLength(0);
    expect((await first.list({ ownerId: "owner", includeDestroyed: true }))[0]?.status).toBe("destroyed");
  });
});
