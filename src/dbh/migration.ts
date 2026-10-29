import type { Kysely } from "kysely";

export const DEFAULT_SANDBOXES_TABLE = "sandboxes";

export interface SandboxesMigration {
  up(db: Kysely<any>): Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any
  down(db: Kysely<any>): Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Kysely migration creating the sandboxes table (Postgres) under `tableName`. */
export function createSandboxesMigration(tableName: string = DEFAULT_SANDBOXES_TABLE): SandboxesMigration {
  return {
    async up(db) {
      await db.schema
        .createTable(tableName)
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("provider", "text", (col) => col.notNull())
        .addColumn("provider_ref", "text")
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("spec", "jsonb", (col) => col.notNull())
        .addColumn("owner_id", "text")
        .addColumn("labels", "jsonb", (col) => col.notNull().defaultTo("{}"))
        .addColumn("metadata", "jsonb", (col) => col.notNull().defaultTo("{}"))
        .addColumn("error", "text")
        .addColumn("version", "integer", (col) => col.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (col) => col.notNull())
        .addColumn("updated_at", "timestamptz", (col) => col.notNull())
        .addColumn("expires_at", "timestamptz")
        .execute();
      await db.schema.createIndex(`${tableName}_owner_id_idx`).on(tableName).column("owner_id").execute();
      await db.schema.createIndex(`${tableName}_status_idx`).on(tableName).column("status").execute();
      await db.schema.createIndex(`${tableName}_labels_idx`).on(tableName).using("gin").column("labels").execute();
    },
    async down(db) {
      await db.schema.dropTable(tableName).ifExists().execute();
    },
  };
}

const migration = createSandboxesMigration();

/**
 * Re-export from a file in your dbh migrations directory:
 *
 * ```ts
 * // src/db/migrations/00012-create-sandboxes.ts
 * export { up, down } from "@schemavaults/sandbox-management-sdk/dbh/migration";
 * ```
 */
export const up = migration.up;
export const down = migration.down;
