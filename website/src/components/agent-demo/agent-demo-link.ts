import type { CrateLink, SceneCrates, SpawnedCrate } from "@/components/sandbox-scene/crate-link";
import type { AgentDemo, AgentDemoSnapshot } from "./agent-demo";

const NOT_LOADED: AgentDemoSnapshot = { ready: false, sessions: [], storage: "sessionStorage", storePrefix: "" };

/**
 * The always-loaded end of the agent demo: a few lines that sit between the
 * scene, the floating button and the demo itself. The demo (the SDK, the
 * browser provider, the dummy model) is a separate chunk that `load()`
 * fetches the first time something needs it: a click on the sand, or the
 * visitor reaching for the agent sessions button.
 */
class AgentDemoLink implements CrateLink {
  private demo: AgentDemo | null = null;
  private loading: Promise<AgentDemo> | null = null;
  private scene: SceneCrates | null = null;
  private readonly listeners = new Set<() => void>();

  load(): Promise<AgentDemo> {
    this.loading ??= import("./agent-demo")
      .then(({ createAgentDemo }) => createAgentDemo())
      .then((demo) => {
        this.demo = demo;
        demo.attachScene(this.scene);
        demo.subscribe(this.notify);
        this.notify();
        return demo;
      })
      .catch((error: unknown) => {
        // Let the next attempt try again, and free the crates waiting on a sandbox.
        this.loading = null;
        this.scene?.unlinkAll();
        throw error;
      });
    return this.loading;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AgentDemoSnapshot => this.demo?.getSnapshot() ?? NOT_LOADED;

  attach(scene: SceneCrates): () => void {
    this.scene = scene;
    this.demo?.attachScene(scene);
    return () => {
      if (this.scene !== scene) return;
      this.scene = null;
      this.demo?.attachScene(null);
    };
  }

  spawned(crate: SpawnedCrate): void {
    this.load().then((demo) => demo.createSession({ crate }), ignore);
  }

  clicked(crateId: string): void {
    this.load().then((demo) => demo.toggleCrate(crateId), ignore);
  }

  evicted(crateId: string): void {
    this.load().then((demo) => demo.destroyCrate(crateId), ignore);
  }

  private notify = (): void => {
    for (const listener of this.listeners) listener();
  };
}

function ignore(): void {}

export const agentDemoLink = new AgentDemoLink();
