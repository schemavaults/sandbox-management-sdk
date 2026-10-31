import { afterEach, describe, expect, it } from "bun:test";
import { SandboxManager } from "../../src/index.js";
import { MockSandboxProvider } from "../../src/testing/index.js";
import { DEFAULT_WEB_STORAGE_PREFIX, WebStorageSandboxStore } from "../../src/web-storage/index.js";
import type { WebStorageLike } from "../../src/web-storage/index.js";
import { describeStoreContract, makeRecord } from "../contracts/store-contract.js";

/** A Web Storage stand-in with the same string-only, ordered-keys behavior. */
class MemoryStorage implements WebStorageLike {
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

describeStoreContract("WebStorageSandboxStore", async () => ({
  store: new WebStorageSandboxStore({ storage: new MemoryStorage() }),
}));

describe("WebStorageSandboxStore", () => {
  const globals = globalThis as { localStorage?: WebStorageLike };
  const originalLocalStorage = globals.localStorage;
  afterEach(() => {
    globals.localStorage = originalLocalStorage;
  });

  it("writes one JSON entry per record under the prefix, with ISO dates", async () => {
    const storage = new MemoryStorage();
    const store = new WebStorageSandboxStore({ storage });
    const record = makeRecord({ expiresAt: new Date(Date.UTC(2026, 5, 1)) });
    await store.insert(record);

    const raw = storage.getItem(DEFAULT_WEB_STORAGE_PREFIX + record.id);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.createdAt).toBe(record.createdAt.toISOString());
    expect(parsed.expiresAt).toBe("2026-06-01T00:00:00.000Z");

    const read = await store.get(record.id);
    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.expiresAt).toEqual(record.expiresAt);
  });

  it("shares records between instances on the same storage and prefix", async () => {
    const storage = new MemoryStorage();
    const a = new WebStorageSandboxStore({ storage });
    const b = new WebStorageSandboxStore({ storage });
    const record = makeRecord();
    await a.insert(record);
    expect(await b.update(record.id, 0, { status: "stopped" })).not.toBeNull();
    expect(await a.update(record.id, 0, { status: "running" })).toBeNull();
    expect((await a.get(record.id))?.status).toBe("stopped");
  });

  it("keeps stores with different prefixes apart and ignores other keys", async () => {
    const storage = new MemoryStorage();
    storage.setItem("theme", "dark");
    storage.setItem(`${DEFAULT_WEB_STORAGE_PREFIX}corrupt`, "{not json");
    storage.setItem(`${DEFAULT_WEB_STORAGE_PREFIX}foreign`, JSON.stringify({ hello: "world" }));
    const a = new WebStorageSandboxStore({ storage, prefix: "a:" });
    const b = new WebStorageSandboxStore({ storage });
    const ra = makeRecord();
    const rb = makeRecord();
    await a.insert(ra);
    await b.insert(rb);

    expect((await a.list()).map((r) => r.id)).toEqual([ra.id]);
    expect((await b.list()).map((r) => r.id)).toEqual([rb.id]);
    expect(await b.get("corrupt")).toBeNull();
    expect(await a.get(rb.id)).toBeNull();
    expect(storage.getItem("theme")).toBe("dark");
  });

  it("lists every record while records are deleted along the way", async () => {
    const storage = new MemoryStorage();
    const store = new WebStorageSandboxStore({ storage });
    const records = Array.from({ length: 4 }, () => makeRecord());
    for (const record of records) await store.insert(record);
    for (const record of await store.list()) await store.delete(record.id);
    expect(await store.list({ includeDestroyed: true })).toEqual([]);
    expect(storage.length).toBe(0);
  });

  it("uses globalThis.localStorage by default and says so when there is none", async () => {
    globals.localStorage = undefined;
    expect(() => new WebStorageSandboxStore()).toThrow("No Web Storage");

    const storage = new MemoryStorage();
    globals.localStorage = storage;
    const record = makeRecord();
    await new WebStorageSandboxStore().insert(record);
    expect(storage.getItem(DEFAULT_WEB_STORAGE_PREFIX + record.id)).not.toBeNull();
  });

  it("backs a SandboxManager through the whole lifecycle", async () => {
    const storage = new MemoryStorage();
    const provider = new MockSandboxProvider();
    const manager = new SandboxManager({
      providers: [provider],
      store: new WebStorageSandboxStore({ storage, prefix: "demo:" }),
    });

    const sandbox = await manager.create({ spec: { setup: "echo hi", start: "agent" }, ownerId: "tab-1" });
    expect(sandbox.status).toBe("running");
    expect((await manager.stop(sandbox.id)).status).toBe("stopped");
    await manager.exec(sandbox.id, "ls"); // auto-resumes
    expect(provider.callsFor(sandbox.id, "wake")).toHaveLength(1);

    // A second manager on the same storage (e.g. after a reload) sees the same record.
    const other = new SandboxManager({ providers: [provider], store: new WebStorageSandboxStore({ storage, prefix: "demo:" }) });
    expect((await other.list({ ownerId: "tab-1" })).map((r) => r.status)).toEqual(["running"]);
    expect((await other.destroy(sandbox.id)).status).toBe("destroyed");
    expect((await manager.get(sandbox.id)).status).toBe("destroyed");
  });
});
