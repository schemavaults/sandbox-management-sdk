import { SandboxError } from "../errors.js";
import { matchesFilter } from "../store.js";
import type { SandboxListFilter, SandboxRecordPatch, SandboxStore } from "../store.js";
import type { SandboxRecord } from "../types.js";

/**
 * The part of the Web Storage API the store uses. `localStorage` and
 * `sessionStorage` implement it, and so does any object with these members.
 */
export interface WebStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebStorageSandboxStoreOptions {
  /**
   * Where records are kept. Default: `globalThis.localStorage`. Pass
   * `sessionStorage` to keep them for the life of the browser tab.
   */
  storage?: WebStorageLike;
  /**
   * Prefix of every key the store writes; each record is one entry under
   * `prefix + id`. Give stores that share a storage different prefixes.
   * Default: `"sandbox-sdk:sandboxes:"`.
   */
  prefix?: string;
}

export const DEFAULT_WEB_STORAGE_PREFIX = "sandbox-sdk:sandboxes:";

/** A record as it is written to storage: dates become ISO strings. */
type StoredRecord = Omit<SandboxRecord, "createdAt" | "updatedAt" | "expiresAt"> & {
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

/**
 * `SandboxStore` backed by the Web Storage API (`localStorage` or
 * `sessionStorage`), for running the SDK in a browser with no database.
 *
 * Every method reads and writes storage synchronously, so `update` is an
 * atomic compare-and-set within one JavaScript context. Browsers do not make
 * that guarantee across tabs that share a `localStorage`; give each tab its
 * own `prefix` or `ownerId`, or use `sessionStorage`, if they write the same
 * records. Storage quotas are small (around 5 MB per origin), and a write
 * past the quota throws the browser's `QuotaExceededError`.
 */
export class WebStorageSandboxStore implements SandboxStore {
  private readonly storage: WebStorageLike;
  private readonly prefix: string;

  constructor(options: WebStorageSandboxStoreOptions = {}) {
    const storage = options.storage ?? (globalThis as { localStorage?: WebStorageLike }).localStorage;
    if (!storage) {
      throw new SandboxError("No Web Storage is available here; pass `storage` (e.g. sessionStorage)");
    }
    this.storage = storage;
    this.prefix = options.prefix ?? DEFAULT_WEB_STORAGE_PREFIX;
  }

  async insert(record: SandboxRecord): Promise<void> {
    const key = this.prefix + record.id;
    if (this.storage.getItem(key) !== null) {
      throw new SandboxError(`Sandbox record "${record.id}" already exists`);
    }
    this.write(record);
  }

  async get(id: string): Promise<SandboxRecord | null> {
    return this.read(this.prefix + id);
  }

  async list(filter: SandboxListFilter = {}): Promise<SandboxRecord[]> {
    const records: SandboxRecord[] = [];
    for (const key of this.keys()) {
      const record = this.read(key);
      if (record && matchesFilter(record, filter)) records.push(record);
    }
    records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const offset = filter.offset ?? 0;
    const end = filter.limit === undefined ? undefined : offset + filter.limit;
    return records.slice(offset, end);
  }

  async update(id: string, expectedVersion: number, patch: SandboxRecordPatch): Promise<SandboxRecord | null> {
    // No await between the read and the write: nothing else in this
    // JavaScript context can write the record in between.
    const current = this.read(this.prefix + id);
    if (!current || current.version !== expectedVersion) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next: SandboxRecord = {
      ...current,
      ...structuredClone(defined),
      version: current.version + 1,
      updatedAt: new Date(),
    };
    this.write(next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const key = this.prefix + id;
    if (this.storage.getItem(key) === null) return false;
    this.storage.removeItem(key);
    return true;
  }

  /** Every key under the prefix, collected first so writes cannot shift the indexes. */
  private keys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      if (key !== null && key.startsWith(this.prefix)) keys.push(key);
    }
    return keys;
  }

  private write(record: SandboxRecord): void {
    this.storage.setItem(this.prefix + record.id, JSON.stringify(record));
  }

  /** `null` if the entry is missing or is not a sandbox record. */
  private read(key: string): SandboxRecord | null {
    const raw = this.storage.getItem(key);
    if (raw === null) return null;
    let stored: StoredRecord;
    try {
      stored = JSON.parse(raw) as StoredRecord;
    } catch {
      return null;
    }
    if (!isStoredRecord(stored)) return null;
    return {
      ...stored,
      createdAt: new Date(stored.createdAt),
      updatedAt: new Date(stored.updatedAt),
      expiresAt: stored.expiresAt === null ? null : new Date(stored.expiresAt),
    };
  }
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.provider === "string" &&
    typeof record.status === "string" &&
    typeof record.version === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.spec === "object" &&
    record.spec !== null
  );
}
