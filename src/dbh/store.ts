import type { Kysely } from "kysely";
import type { SandboxListFilter, SandboxRecordPatch, SandboxStore } from "../store.js";
import type { SandboxRecord, SandboxSpec, SandboxStatus } from "../types.js";
import { DEFAULT_SANDBOXES_TABLE } from "./migration.js";

/** Row shape of the sandboxes table. */
export interface SandboxRow {
  id: string;
  provider: string;
  provider_ref: string | null;
  status: string;
  spec: unknown;
  owner_id: string | null;
  labels: unknown;
  metadata: unknown;
  error: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
}

type Db = Kysely<Record<string, SandboxRow>>;

export interface DbhSandboxStoreOptions {
  /**
   * Your app's Kysely instance (Postgres dialect), or a `@schemavaults/dbh`
   * handler (anything with a `db` Kysely property). The store never opens or
   * closes connections itself.
   */
  db: Kysely<any> | { db: Kysely<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Default `"sandboxes"`; must match the table name given to the migration. */
  tableName?: string;
}

/** `SandboxStore` backed by a Postgres table, via Kysely / `@schemavaults/dbh`. */
export class DbhSandboxStore implements SandboxStore {
  private readonly db: Db;
  private readonly table: string;

  constructor(options: DbhSandboxStoreOptions) {
    const db = "selectFrom" in options.db ? options.db : options.db.db;
    this.db = db as unknown as Db;
    this.table = options.tableName ?? DEFAULT_SANDBOXES_TABLE;
  }

  async insert(record: SandboxRecord): Promise<void> {
    await this.db
      .insertInto(this.table)
      .values({
        id: record.id,
        provider: record.provider,
        provider_ref: record.providerRef,
        status: record.status,
        spec: JSON.stringify(record.spec),
        owner_id: record.ownerId,
        labels: JSON.stringify(record.labels),
        metadata: JSON.stringify(record.metadata),
        error: record.error,
        version: record.version,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        expires_at: record.expiresAt,
      })
      .execute();
  }

  async get(id: string): Promise<SandboxRecord | null> {
    const row = await this.db.selectFrom(this.table).selectAll().where("id", "=", id).executeTakeFirst();
    return row ? fromRow(row) : null;
  }

  async list(filter: SandboxListFilter = {}): Promise<SandboxRecord[]> {
    let query = this.db.selectFrom(this.table).selectAll();
    if (filter.ownerId !== undefined) query = query.where("owner_id", "=", filter.ownerId);
    if (filter.provider !== undefined) query = query.where("provider", "=", filter.provider);
    if (filter.status !== undefined) {
      const statuses = ([] as SandboxStatus[]).concat(filter.status);
      if (statuses.length === 0) return [];
      query = query.where("status", "in", statuses);
    } else if (!filter.includeDestroyed) {
      query = query.where("status", "!=", "destroyed");
    }
    if (filter.labels && Object.keys(filter.labels).length > 0) {
      query = query.where("labels", "@>", JSON.stringify(filter.labels));
    }
    query = query.orderBy("created_at", "desc").orderBy("id", "desc");
    if (filter.limit !== undefined) query = query.limit(filter.limit);
    if (filter.offset !== undefined) query = query.offset(filter.offset);
    const rows = await query.execute();
    return rows.map(fromRow);
  }

  async update(id: string, expectedVersion: number, patch: SandboxRecordPatch): Promise<SandboxRecord | null> {
    const row = await this.db
      .updateTable(this.table)
      .set({
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.providerRef !== undefined && { provider_ref: patch.providerRef }),
        ...(patch.error !== undefined && { error: patch.error }),
        ...(patch.expiresAt !== undefined && { expires_at: patch.expiresAt }),
        ...(patch.labels !== undefined && { labels: JSON.stringify(patch.labels) }),
        ...(patch.metadata !== undefined && { metadata: JSON.stringify(patch.metadata) }),
        version: expectedVersion + 1,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row ? fromRow(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom(this.table).where("id", "=", id).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}

function fromRow(row: SandboxRow): SandboxRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerRef: row.provider_ref,
    status: row.status as SandboxStatus,
    spec: parseJson(row.spec) as SandboxSpec,
    ownerId: row.owner_id,
    labels: parseJson(row.labels) as Record<string, string>,
    metadata: parseJson(row.metadata) as Record<string, unknown>,
    error: row.error,
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
  };
}

/** jsonb comes back parsed from `pg`, but as text from some drivers. */
function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
