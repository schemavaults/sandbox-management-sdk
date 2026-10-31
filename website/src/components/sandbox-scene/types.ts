import type { Intersection, Object3D } from "three";
import type { Effects } from "./effects";

export interface FrameContext {
  /** Seconds since the scene started (frozen while paused). */
  time: number;
  dt: number;
  /** 0 in the light theme, 1 in the dark theme; eases between the two. */
  night: number;
  fx: Effects;
}

export interface Toy {
  object: Object3D;
  update(context: FrameContext): void;
  /** Meshes that react to a click. */
  targets?: Object3D[];
  onClick?(context: FrameContext, hit: Intersection): void;
}
