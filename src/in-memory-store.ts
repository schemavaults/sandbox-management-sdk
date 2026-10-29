import { matchesFilter } from "./store.js";
import type { SandboxListFilter, SandboxRecordPatch, SandboxStore } from "./store.js";
import type { SandboxRecord } from "./types.js";

/** A process-local store for tests and single-process development. */
export class InMemorySandboxStore implements SandboxStore {
  private readonly records = new Map<string, SandboxRecord>();

  async insert(record: SandboxRecord): Promise<void> {
    if (this.records.has(record.id)) {
      throw new Error(`Sandbox record "${record.id}" already exists`);
    }
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<SandboxRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(filter: SandboxListFilter = {}): Promise<SandboxRecord[]> {
    const matches = [...this.records.values()]
      .filter((record) => matchesFilter(record, filter))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = filter.offset ?? 0;
    const end = filter.limit === undefined ? undefined : offset + filter.limit;
    return matches.slice(offset, end).map((record) => structuredClone(record));
  }

  async update(id: string, expectedVersion: number, patch: SandboxRecordPatch): Promise<SandboxRecord | null> {
    const current = this.records.get(id);
    if (!current || current.version !== expectedVersion) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next: SandboxRecord = {
      ...current,
      ...structuredClone(defined),
      version: current.version + 1,
      updatedAt: new Date(),
    };
    this.records.set(id, next);
    return structuredClone(next);
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}
