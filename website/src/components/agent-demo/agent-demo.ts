import {
  InMemorySandboxStore,
  SandboxManager,
  generateSandboxId,
  type ExecResult,
  type SandboxListFilter,
  type SandboxRecord,
  type SandboxRecordPatch,
  type SandboxSpec,
  type SandboxStatus,
  type SandboxStore,
} from "@schemavaults/sandbox-management-sdk";
import { WebStorageSandboxStore } from "@schemavaults/sandbox-management-sdk/web-storage";
import type { AgentSession, AgentSessionStatusId } from "@schemavaults/ui/components/ui/agent-sessions/agent-sessions-model.js";
import { CRATE_COLORS, type CrateTarget, type SceneCrates, type SpawnedCrate } from "@/components/sandbox-scene/crate-link";
import { runAgentTurn, type AgentEvent } from "./agent";
import { BrowserSandboxProvider } from "./browser-provider";
import { DummyLlm, type LlmMessage } from "./dummy-llm";

export type DemoMessage =
  | { id: string; kind: "user"; text: string; at: number }
  | { id: string; kind: "assistant"; text: string; at: number; streaming: boolean }
  | { id: string; kind: "tool"; command: string; at: number; result: ExecResult | null }
  | { id: string; kind: "event"; text: string; at: number; tone: "info" | "destructive" };

/** One agent session; its id is its sandbox's id. */
export interface DemoSession extends AgentSession {
  updatedAt: number;
  status: AgentSessionStatusId;
  unread: boolean;
  /** One of `CRATE_COLORS[*].hex`. */
  color: string;
  /** The scene crate that stands for the sandbox, if there is one. */
  crateId: string | null;
  sandboxStatus: SandboxStatus;
  /** The agent is working on a reply. */
  busy: boolean;
  /** The agent is working but has not said anything yet. */
  thinking: boolean;
  messages: readonly DemoMessage[];
}

export interface AgentDemoSnapshot {
  ready: boolean;
  /** Sessions whose sandboxes have not been destroyed. */
  sessions: readonly DemoSession[];
  /** Where sandbox records are kept, for the UI to say so. */
  storage: "sessionStorage" | "memory";
  /** Key prefix of the records in sessionStorage. */
  storePrefix: string;
}

/** Keys in sessionStorage start with this, one per sandbox record. */
export const DEMO_STORE_PREFIX = "sandbox-demo:sandboxes:";
const OWNER_ID = "hero-demo";

const SPEC: SandboxSpec = {
  env: { AGENT_MODEL: "dummy-1" },
  setup: [
    "echo '# A sandbox in your browser tab' > README.md",
    "echo 'Created by @schemavaults/sandbox-management-sdk. Its record is in sessionStorage; its files are in memory.' >> README.md",
    "mkdir -p src && echo 'console.log(\"hello from the sandbox\")' > src/index.js",
  ],
  start: "dummy-agent --model dummy-1",
};

const TRANSITIONAL: readonly SandboxStatus[] = ["provisioning", "setting_up", "starting", "stopping", "resuming", "destroying"];

/** Where a crate is heading for each sandbox status. */
function crateTarget(status: SandboxStatus): CrateTarget {
  switch (status) {
    case "provisioning":
    case "setting_up":
    case "starting":
      return "busy";
    case "running":
    case "resuming":
      return "running";
    case "stopping":
    case "stopped":
    case "failed":
      return "stopped";
    case "destroying":
    case "destroyed":
      return "destroyed";
  }
}

type Listener = () => void;

/** A `SandboxStore` wrapper that reports every record it writes. */
class ObservedStore implements SandboxStore {
  constructor(
    private readonly inner: SandboxStore,
    private readonly onChange: (record: SandboxRecord) => void,
  ) {}
  async insert(record: SandboxRecord): Promise<void> {
    await this.inner.insert(record);
    this.onChange(record);
  }
  get(id: string): Promise<SandboxRecord | null> {
    return this.inner.get(id);
  }
  list(filter?: SandboxListFilter): Promise<SandboxRecord[]> {
    return this.inner.list(filter);
  }
  async update(id: string, expectedVersion: number, patch: SandboxRecordPatch): Promise<SandboxRecord | null> {
    const updated = await this.inner.update(id, expectedVersion, patch);
    if (updated) this.onChange(updated);
    return updated;
  }
  delete(id: string): Promise<boolean> {
    return this.inner.delete(id);
  }
}

/**
 * The hero's agent demo: every session is an agent (the dummy model plus the
 * loop in `agent.ts`) with its own ephemeral browser sandbox, created and
 * driven by a real `SandboxManager`. Sandbox records go through
 * `WebStorageSandboxStore` into this tab's sessionStorage; the sandboxes
 * themselves live in memory and end with the page. Status changes in the
 * store drive the session list and the scene's crates alike.
 */
export class AgentDemo {
  readonly manager: SandboxManager;
  private readonly llm = new DummyLlm();
  private sessions = new Map<string, DemoSession>();
  private readonly history = new Map<string, LlmMessage[]>();
  private readonly turns = new Map<string, AbortController>();
  private readonly listeners = new Set<Listener>();
  private readonly pendingIds: string[] = [];
  private scene: SceneCrates | null = null;
  private viewing: string | null = null;
  private colorIndex = 0;
  private sessionCount = 0;
  private nextMessageId = 1;
  private snapshot: AgentDemoSnapshot;

  constructor(store: SandboxStore, storage: AgentDemoSnapshot["storage"]) {
    this.manager = new SandboxManager({
      providers: [new BrowserSandboxProvider()],
      store: new ObservedStore(store, (record) => this.onRecord(record)),
      pollIntervalMs: 100,
      // Sessions are keyed by sandbox id, so the id is picked before `create` is called.
      generateId: () => this.pendingIds.shift() ?? generateSandboxId(),
    });
    this.snapshot = { ready: true, sessions: [], storage, storePrefix: DEMO_STORE_PREFIX };
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AgentDemoSnapshot => this.snapshot;

  /** The scene's crates, or `null` once the scene is gone. */
  attachScene(scene: SceneCrates | null): void {
    this.scene = scene;
  }

  /** Which session the dialog shows (`null` when closed or on the new-session screen); it is never unread. */
  setViewing(sessionId: string | null): void {
    this.viewing = sessionId;
    if (sessionId) this.patch(sessionId, { unread: false });
  }

  /**
   * Starts a session: a new sandbox (standing for `crate`, or for a crate
   * spawned anywhere in the scene) and an agent in it. Resolves the
   * session's id straight away; the sandbox keeps setting up meanwhile.
   */
  createSession(options: { crate?: SpawnedCrate; prompt?: string } = {}): string {
    const crate = options.crate ?? this.scene?.spawn() ?? null;
    const colorEntry = CRATE_COLORS.find((entry) => entry.hex === crate?.color) ?? CRATE_COLORS[this.colorIndex++ % CRATE_COLORS.length]!;
    this.sessionCount += 1;
    const id = generateSandboxId();
    const now = Date.now();
    this.sessions.set(id, {
      id,
      title: `${colorEntry.name} sandbox #${this.sessionCount}`,
      preview: "Setting up its sandbox…",
      updatedAt: now,
      status: "running",
      unread: false,
      color: colorEntry.hex,
      crateId: crate?.id ?? null,
      sandboxStatus: "provisioning",
      busy: false,
      thinking: false,
      messages: [],
    });
    this.history.set(id, []);
    this.emit();

    // `create` takes its id from `generateId` before its first await.
    this.pendingIds.push(id);
    this.manager
      .create({
        spec: SPEC,
        ownerId: OWNER_ID,
        labels: { demo: "hero", ...(crate && { crate: crate.id }) },
        metadata: { color: colorEntry.hex },
      })
      .catch((error: unknown) => {
        // A failed record already says why (see `onRecord`); report failures that never reached the store.
        if (this.sessions.get(id)?.sandboxStatus !== "failed") this.addEvent(id, `create() failed: ${messageOf(error)}`, "destructive");
      });
    if (options.prompt) this.send(id, options.prompt);
    return id;
  }

  /** Sends `text` to the session's agent. Ignored while it is still replying. */
  send(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    const history = this.history.get(sessionId);
    if (!session || !history || session.busy || !text.trim()) return;
    const controller = new AbortController();
    this.turns.set(sessionId, controller);
    this.addMessage(sessionId, { id: this.messageId(), kind: "user", text, at: Date.now() }, { busy: true, thinking: true });
    history.push({ role: "user", content: text });

    void runAgentTurn({
      llm: this.llm,
      history,
      signal: controller.signal,
      // `exec` waits for a sandbox that is still setting up, and resumes a stopped one first.
      exec: (command) => this.manager.exec(sessionId, command),
      onEvent: (event) => this.onAgentEvent(sessionId, event),
    })
      .catch((error: unknown) => this.addEvent(sessionId, `The agent crashed: ${messageOf(error)}`, "destructive"))
      .finally(() => {
        this.turns.delete(sessionId);
        const current = this.sessions.get(sessionId);
        if (!current) return;
        const messages = current.messages.map((message) =>
          message.kind === "assistant" && message.streaming ? { ...message, streaming: false } : message,
        );
        this.patch(sessionId, { busy: false, thinking: false, messages, unread: this.viewing !== sessionId });
      });
  }

  /** Stops the agent's current reply. */
  interrupt(sessionId: string): void {
    this.turns.get(sessionId)?.abort();
  }

  stop(sessionId: string): void {
    this.manager.stop(sessionId).catch((error: unknown) => this.addEvent(sessionId, `stop() failed: ${messageOf(error)}`, "destructive"));
  }

  resume(sessionId: string): void {
    this.manager.resume(sessionId).catch((error: unknown) => this.addEvent(sessionId, `resume() failed: ${messageOf(error)}`, "destructive"));
  }

  destroy(sessionId: string): void {
    this.interrupt(sessionId);
    this.manager.destroy(sessionId).catch((error: unknown) => this.addEvent(sessionId, `destroy() failed: ${messageOf(error)}`, "destructive"));
  }

  /** A crate was clicked: stop its sandbox if it is running, resume it if it is stopped. */
  toggleCrate(crateId: string): void {
    const session = this.byCrate(crateId);
    if (!session) return;
    if (session.sandboxStatus === "running") this.stop(session.id);
    else if (session.sandboxStatus === "stopped" || session.sandboxStatus === "failed") this.resume(session.id);
  }

  /** A crate was evicted to make room for a new one: its sandbox goes with it. */
  destroyCrate(crateId: string): void {
    const session = this.byCrate(crateId);
    if (session) this.destroy(session.id);
  }

  private byCrate(crateId: string): DemoSession | undefined {
    return [...this.sessions.values()].find((session) => session.crateId === crateId);
  }

  /** Every record write from the manager lands here. */
  private onRecord(record: SandboxRecord): void {
    const session = this.sessions.get(record.id);
    if (!session) return;
    const previous = session.sandboxStatus;
    if (session.crateId) this.scene?.setTarget(session.crateId, crateTarget(record.status));

    if (record.status === "destroyed") {
      this.interrupt(record.id);
      this.sessions.delete(record.id);
      this.history.delete(record.id);
      this.emit();
      return;
    }
    this.patch(record.id, { sandboxStatus: record.status });
    if (record.status === previous) return;

    if (record.status === "running" && previous === "starting") {
      this.addEvent(record.id, "create() → running. Ran 3 setup steps and started the agent's main process.", "info");
      if (!this.sessions.get(record.id)?.busy) this.patch(record.id, { preview: "Ready. Say hi, or ask it to list the files." });
    } else if (record.status === "running" && previous === "resuming") {
      this.addEvent(record.id, "resume() → running. Same files as before, fresh main process.", "info");
    } else if (record.status === "stopped") {
      this.addEvent(record.id, "stop() → stopped. The files stay; send a message and it resumes on its own.", "info");
    } else if (record.status === "failed") {
      this.addEvent(record.id, `The sandbox failed: ${record.error ?? "unknown error"}`, "destructive");
    }
  }

  private onAgentEvent(sessionId: string, event: AgentEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const messages = [...session.messages];
    const last = messages.at(-1);
    switch (event.type) {
      case "text-start":
        messages.push({ id: this.messageId(), kind: "assistant", text: "", at: Date.now(), streaming: true });
        this.patch(sessionId, { messages, thinking: false });
        return;
      case "text-delta":
        if (last?.kind !== "assistant") return;
        messages[messages.length - 1] = { ...last, text: last.text + event.delta };
        this.patch(sessionId, { messages, preview: last.text + event.delta });
        return;
      case "text-end":
        if (last?.kind !== "assistant") return;
        messages[messages.length - 1] = { ...last, streaming: false };
        this.patch(sessionId, { messages });
        return;
      case "tool-start":
        messages.push({ id: this.messageId(), kind: "tool", command: event.command, at: Date.now(), result: null });
        this.patch(sessionId, { messages, thinking: true, preview: `$ ${event.command}` });
        return;
      case "tool-end": {
        const index = messages.findLastIndex((message) => message.kind === "tool" && message.result === null);
        const tool = messages[index];
        if (tool?.kind !== "tool") return;
        messages[index] = { ...tool, result: event.result };
        this.patch(sessionId, { messages });
        return;
      }
    }
  }

  /**
   * Lifecycle notes go before a command that is still waiting on them (e.g.
   * "resumed" before the `ls` that resumed the sandbox), so they read in
   * cause-and-effect order.
   */
  private addEvent(sessionId: string, text: string, tone: "info" | "destructive"): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const event: DemoMessage = { id: this.messageId(), kind: "event", text, at: Date.now(), tone };
    const messages = [...session.messages];
    const last = messages.at(-1);
    if (last?.kind === "tool" && last.result === null) messages.splice(-1, 0, event);
    else messages.push(event);
    this.patch(sessionId, { messages });
  }

  private addMessage(sessionId: string, message: DemoMessage, extra: Partial<DemoSession> = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const preview = message.kind === "user" ? message.text : session.preview;
    this.patch(sessionId, { messages: [...session.messages, message], preview, ...extra });
  }

  private patch(sessionId: string, patch: Partial<DemoSession>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const next = { ...session, ...patch };
    if (patch.messages || patch.preview) next.updatedAt = Date.now();
    next.status = next.busy || TRANSITIONAL.includes(next.sandboxStatus) ? "running" : next.sandboxStatus === "failed" ? "failed" : "idle";
    this.sessions.set(sessionId, next);
    this.emit();
  }

  private emit(): void {
    this.snapshot = { ...this.snapshot, sessions: [...this.sessions.values()] };
    for (const listener of this.listeners) listener();
  }

  private messageId(): string {
    return `m${this.nextMessageId++}`;
  }
}

/**
 * Opens the store and builds the demo. Records go to this tab's
 * sessionStorage (in memory if storage is blocked). The provider keeps its
 * sandboxes in memory, so records an earlier page load left behind point at
 * sandboxes that no longer exist; they are cleared first.
 */
export async function createAgentDemo(): Promise<AgentDemo> {
  let store: SandboxStore;
  let storage: AgentDemoSnapshot["storage"];
  try {
    const probe = `${DEMO_STORE_PREFIX}probe`;
    window.sessionStorage.setItem(probe, "1");
    window.sessionStorage.removeItem(probe);
    store = new WebStorageSandboxStore({ storage: window.sessionStorage, prefix: DEMO_STORE_PREFIX });
    storage = "sessionStorage";
  } catch {
    store = new InMemorySandboxStore();
    storage = "memory";
  }
  for (const record of await store.list({ includeDestroyed: true })) await store.delete(record.id);
  return new AgentDemo(store, storage);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
