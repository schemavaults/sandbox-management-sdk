import type { SandboxRecord, SandboxStatus } from "./types.js";

export interface SandboxListFilter {
  ownerId?: string;
  provider?: string;
  status?: SandboxStatus | SandboxStatus[];
  /** Matches records whose labels contain every given key/value pair. */
  labels?: Record<string, string>;
  /** Destroyed sandboxes are excluded unless this is set (or `status` asks for them). */
  includeDestroyed?: boolean;
  limit?: number;
  offset?: number;
}

/** Fields the manager may change after insert. `version` and `updatedAt` are managed by the store. */
export type SandboxRecordPatch = Partial<
  Pick<SandboxRecord, "status" | "providerRef" | "error" | "expiresAt" | "labels" | "metadata">
>;

/**
 * Persistence for sandbox records. Implementations must make `update` an
 * atomic compare-and-set on `version`, which is what makes concurrent
 * resume/stop calls from different processes safe.
 */
export interface SandboxStore {
  insert(record: SandboxRecord): Promise<void>;
  get(id: string): Promise<SandboxRecord | null>;
  /** Newest first. */
  list(filter?: SandboxListFilter): Promise<SandboxRecord[]>;
  /**
   * Apply `patch` only if the stored version equals `expectedVersion`; the
   * stored version is then incremented and `updatedAt` set to now.
   * Resolves the updated record, or `null` if the version did not match (or
   * the record does not exist).
   */
  update(id: string, expectedVersion: number, patch: SandboxRecordPatch): Promise<SandboxRecord | null>;
  /** Hard-delete a record. Resolves whether a record was deleted. */
  delete(id: string): Promise<boolean>;
}

/** Shared filter semantics, for stores that filter in memory. */
export function matchesFilter(record: SandboxRecord, filter: SandboxListFilter): boolean {
  if (filter.ownerId !== undefined && record.ownerId !== filter.ownerId) return false;
  if (filter.provider !== undefined && record.provider !== filter.provider) return false;
  const statuses = filter.status === undefined ? undefined : ([] as SandboxStatus[]).concat(filter.status);
  if (statuses && !statuses.includes(record.status)) return false;
  if (!statuses && !filter.includeDestroyed && record.status === "destroyed") return false;
  if (filter.labels) {
    for (const [key, value] of Object.entries(filter.labels)) {
      if (record.labels[key] !== value) return false;
    }
  }
  return true;
}
