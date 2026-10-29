import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SandboxRecord, SandboxStore } from "../../src/index.js";

export interface StoreHarness {
  store: SandboxStore;
  cleanup?: () => Promise<void>;
}

let counter = 0;

export function makeRecord(overrides: Partial<SandboxRecord> = {}): SandboxRecord {
  counter += 1;
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, counter));
  return {
    id: `sbx-test-${counter}-${crypto.randomUUID().slice(0, 8)}`,
    provider: "mock",
    providerRef: null,
    status: "running",
    spec: { setup: ["echo hi"], start: "sleep 1000", env: { A: "1" }, ports: [3000] },
    ownerId: null,
    labels: {},
    metadata: {},
    error: null,
    version: 0,
    createdAt,
    updatedAt: createdAt,
    expiresAt: null,
    ...overrides,
  };
}

/** Behavior every `SandboxStore` implementation must satisfy. */
export function describeStoreContract(name: string, createHarness: () => Promise<StoreHarness>): void {
  describe(`SandboxStore contract: ${name}`, () => {
    let harness: StoreHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    it("round-trips a record", async () => {
      const record = makeRecord({
        ownerId: "user-1",
        providerRef: "ref-1",
        labels: { team: "a" },
        metadata: { nested: { n: 1 }, list: [1, 2] },
        expiresAt: new Date(Date.UTC(2026, 5, 1)),
        spec: { git: { url: "https://example.com/r.git", depth: 1 }, setup: ["a", { cmd: "b", args: ["c"] }] },
      });
      await harness.store.insert(record);
      expect(await harness.store.get(record.id)).toEqual(record);
    });

    it("returns null for unknown ids", async () => {
      expect(await harness.store.get("sbx-missing")).toBeNull();
    });

    it("rejects duplicate ids", async () => {
      const record = makeRecord();
      await harness.store.insert(record);
      await expect(harness.store.insert(record)).rejects.toThrow();
    });

    it("updates with compare-and-set on version", async () => {
      const record = makeRecord();
      await harness.store.insert(record);

      const updated = await harness.store.update(record.id, 0, { status: "stopped", error: "boom" });
      expect(updated?.status).toBe("stopped");
      expect(updated?.error).toBe("boom");
      expect(updated?.version).toBe(1);
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(record.updatedAt.getTime());

      expect(await harness.store.update(record.id, 0, { status: "running" })).toBeNull();
      expect((await harness.store.get(record.id))?.status).toBe("stopped");
      expect(await harness.store.update("sbx-missing", 0, { status: "running" })).toBeNull();
    });

    it("lets exactly one of several concurrent updates win", async () => {
      const record = makeRecord();
      await harness.store.insert(record);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => harness.store.update(record.id, 0, { status: "resuming" })),
      );
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    });

    it("patches only the given fields, including setting null", async () => {
      const record = makeRecord({ providerRef: "ref", error: "old", labels: { a: "1" }, metadata: { m: 1 } });
      await harness.store.insert(record);
      const updated = await harness.store.update(record.id, 0, { error: null, labels: { b: "2" } });
      expect(updated).toMatchObject({
        providerRef: "ref",
        error: null,
        labels: { b: "2" },
        metadata: { m: 1 },
        spec: record.spec,
      });
    });

    it("filters by owner, provider, status and labels, newest first", async () => {
      const a = makeRecord({ ownerId: "u1", labels: { env: "prod", team: "x" } });
      const b = makeRecord({ ownerId: "u1", labels: { env: "dev" }, status: "stopped" });
      const c = makeRecord({ ownerId: "u2", provider: "docker", labels: { env: "prod" } });
      const d = makeRecord({ ownerId: "u1", status: "destroyed" });
      for (const record of [a, b, c, d]) await harness.store.insert(record);

      const ids = async (filter: Parameters<SandboxStore["list"]>[0]) =>
        (await harness.store.list(filter)).map((record) => record.id);

      expect(await ids({ ownerId: "u1" })).toEqual([b.id, a.id]);
      expect(await ids({ ownerId: "u1", includeDestroyed: true })).toEqual([d.id, b.id, a.id]);
      expect(await ids({ status: "destroyed" })).toEqual([d.id]);
      expect(await ids({ status: ["running", "stopped"], ownerId: "u1" })).toEqual([b.id, a.id]);
      expect(await ids({ provider: "docker" })).toEqual([c.id]);
      expect(await ids({ labels: { env: "prod" } })).toEqual([c.id, a.id]);
      expect(await ids({ labels: { env: "prod", team: "x" } })).toEqual([a.id]);
      expect(await ids({ ownerId: "u1", limit: 1 })).toEqual([b.id]);
      expect(await ids({ ownerId: "u1", limit: 1, offset: 1 })).toEqual([a.id]);
      expect(await ids({ status: [] })).toEqual([]);
    });

    it("deletes records", async () => {
      const record = makeRecord();
      await harness.store.insert(record);
      expect(await harness.store.delete(record.id)).toBe(true);
      expect(await harness.store.delete(record.id)).toBe(false);
      expect(await harness.store.get(record.id)).toBeNull();
    });
  });
}
