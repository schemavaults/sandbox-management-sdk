/**
 * How the scene's crates stand in for real sandboxes. This module has no
 * Three.js in it, so code outside the scene's chunk (the agent demo) can
 * import it without pulling the 3D engine along.
 */

/** Crate colors, in the order new crates take them. */
export const CRATE_COLORS = [
  { hex: "#60a5fa", name: "Blue" },
  { hex: "#f87171", name: "Red" },
  { hex: "#fbbf24", name: "Amber" },
  { hex: "#34d399", name: "Green" },
  { hex: "#a78bfa", name: "Violet" },
  { hex: "#f472b6", name: "Pink" },
] as const;

/** At most this many crates you create stay in the sandbox; a new one evicts the oldest. */
export const MAX_SPAWNED_CRATES = 6;

/**
 * What a linked crate should look like, following its sandbox: `busy`
 * while the sandbox is being set up, then `running`, `stopped` or
 * `destroyed`. The crate animates its way there.
 */
export type CrateTarget = "busy" | "running" | "stopped" | "destroyed";

export interface SpawnedCrate {
  id: string;
  /** One of `CRATE_COLORS[*].hex`. */
  color: string;
}

/** What the scene hands its link once it is up. */
export interface SceneCrates {
  setTarget(crateId: string, target: CrateTarget): void;
  /** Drops a new linked crate on a free spot of sand; `null` if none is free. */
  spawn(): SpawnedCrate | null;
  /** Lets every linked crate go back to acting on its own (the link is gone). */
  unlinkAll(): void;
}

/**
 * Receives the visitor's actions on crates that stand for sandboxes. A
 * crate you create is linked while a link is set: it waits in `busy` until
 * the link sets its target, and clicks on it go to the link instead of
 * animating straight away.
 */
export interface CrateLink {
  /** The scene is up. Returns a function to call when it goes away. */
  attach(crates: SceneCrates): () => void;
  /** The visitor clicked free sand and a linked crate appeared. */
  spawned(crate: SpawnedCrate): void;
  /** The visitor clicked a linked crate. */
  clicked(crateId: string): void;
  /** A linked crate is being removed to make room for a new one. */
  evicted(crateId: string): void;
}
