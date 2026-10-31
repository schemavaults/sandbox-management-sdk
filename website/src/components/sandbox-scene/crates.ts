import { Color, Group, Vector3, type Intersection, type Mesh, type MeshStandardMaterial, type Object3D } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createFace, easeOutBack, easeInOutSine, part, randomBetween, type Face, type Kit } from "./helpers";
import { INNER_X, INNER_Z, sandHeight } from "./terrain";
import type { FrameContext, Toy } from "./types";

type CrateState = "creating" | "running" | "stopping" | "stopped" | "resuming" | "destroying";

const DURATION: Partial<Record<CrateState, number>> = { creating: 0.8, stopping: 0.6, resuming: 0.75, destroying: 0.65 };
const CRATE_COLORS = ["#60a5fa", "#f87171", "#fbbf24", "#34d399", "#a78bfa", "#f472b6"];
const SAND_PUFF = ["#f3d59c", "#e6c184", "#fbe7bf"];
const LED = { running: new Color("#22c55e"), busy: new Color("#f59e0b"), stopped: new Color("#64748b") };
const HALF_HEIGHT = 0.26;
const SUNK = -0.13;
const MAX_SPAWNED = 6;

interface Crate {
  group: Group;
  body: Mesh;
  led: MeshStandardMaterial;
  face: Face;
  state: CrateState;
  age: number;
  x: number;
  z: number;
  ground: number;
  /** Pre-placed crates cycle on their own; ones you create sleep until clicked. */
  auto: boolean;
  runFor: number;
  sleepFor: number;
  snooze: number;
  blink: number;
  phase: number;
}

/** No-go zones (x, z, radius) so new crates do not land inside other toys. */
const KEEP_OUT: [number, number, number][] = [
  [-4.7, -2.3, 1.55],
  [-1.95, -2.95, 0.8],
  [0.2, -3.05, 0.65],
  [5.95, 2.55, 0.75],
  [6.95, 3.2, 0.45],
  [3.45, 2.85, 0.65],
  [-7.15, 3.55, 0.4],
];

export class Crates implements Toy {
  readonly object = new Group();
  private readonly crates: Crate[] = [];
  private readonly geometry = new RoundedBoxGeometry(0.62, 0.52, 0.62, 3, 0.11);
  private readonly lid = new RoundedBoxGeometry(0.66, 0.07, 0.66, 2, 0.03);
  private colorIndex = 0;

  constructor(private readonly kit: Kit) {}

  get targets(): Object3D[] {
    return this.crates.filter((crate) => crate.state !== "destroying").map((crate) => crate.body);
  }

  /** Adds one of the crates that act out the lifecycle on their own. */
  addAuto(x: number, z: number, state: "running" | "stopped", age: number): void {
    const crate = this.create(x, z, true);
    crate.state = state;
    crate.age = age;
  }

  /** Whether a new crate fits at (x, z). */
  canPlace(x: number, z: number): boolean {
    if (Math.abs(x) > INNER_X - 0.5 || Math.abs(z) > INNER_Z - 0.5) return false;
    if (KEEP_OUT.some(([kx, kz, r]) => Math.hypot(x - kx, z - kz) < r)) return false;
    if (Math.abs(z - 1.2) < 0.5 && x > 2.9 && x < 7.5) return false; // the crab's beach
    return this.crates.every((crate) => crate.state === "destroying" || Math.hypot(crate.x - x, crate.z - z) > 0.72);
  }

  spawn(context: FrameContext, x: number, z: number): void {
    const spawned = this.crates.filter((crate) => !crate.auto && crate.state !== "destroying");
    const oldest = spawned[0];
    if (spawned.length >= MAX_SPAWNED && oldest) this.transition(context, oldest, "destroying", "destroy()");
    this.transition(context, this.create(x, z, false), "creating", "create()");
  }

  onClick(context: FrameContext, hit: Intersection): void {
    const crate = this.crates.find((c) => c.body === hit.object);
    if (!crate) return;
    if (crate.state === "stopped") this.transition(context, crate, "resuming", "resume()");
    else if (crate.state === "running") this.transition(context, crate, "stopping", "stop()");
  }

  update(context: FrameContext): void {
    const { dt, time, night, fx } = context;
    for (let i = this.crates.length - 1; i >= 0; i -= 1) {
      const crate = this.crates[i];
      if (!crate) continue;
      crate.age += dt;
      const duration = DURATION[crate.state];
      const t = duration ? Math.min(1, crate.age / duration) : 0;
      let offset = 0;
      let squash = 0;
      let open = 1;
      let led = LED.running;
      let glow = 0.9 + 0.5 * Math.sin(time * 3 + crate.phase);

      switch (crate.state) {
        case "creating": {
          offset = -0.62 + 0.62 * easeOutBack(t);
          squash = Math.sin(t * Math.PI) * 0.18;
          led = LED.busy;
          glow = Math.sin(time * 18) > 0 ? 1.4 : 0.3;
          if (t >= 1) this.transition(context, crate, "running");
          break;
        }
        case "running": {
          squash = -0.02 * Math.sin(time * 2.4 + crate.phase);
          crate.blink -= dt;
          if (crate.blink < 0.12) open = 0.1;
          if (crate.blink <= 0) crate.blink = randomBetween(2, 5);
          if (crate.auto && crate.age > crate.runFor) this.transition(context, crate, "stopping", "stop()");
          break;
        }
        case "stopping": {
          offset = SUNK * easeInOutSine(t);
          open = 1 - t;
          led = LED.busy;
          if (t >= 1) this.transition(context, crate, "stopped");
          break;
        }
        case "stopped": {
          offset = SUNK + 0.015 * Math.sin(time * 1.6 + crate.phase);
          open = 0;
          led = LED.stopped;
          glow = 0.05;
          crate.snooze -= dt;
          if (crate.snooze <= 0) {
            crate.snooze = 1.3;
            fx.text.spawn("z", new Vector3(crate.x + 0.15, crate.ground + 0.55, crate.z), { style: "plain", height: 0.26, life: 1.8, rise: 0.45, drift: 0.25 });
          }
          if (crate.auto && crate.age > crate.sleepFor) this.transition(context, crate, "resuming", "resume()");
          break;
        }
        case "resuming": {
          offset = SUNK * (1 - easeOutBack(t)) + Math.sin(t * Math.PI) * 0.3;
          squash = Math.sin(t * Math.PI * 2) * 0.12;
          open = t;
          led = LED.busy;
          glow = Math.sin(time * 18) > 0 ? 1.4 : 0.3;
          if (t >= 1) this.transition(context, crate, "running");
          break;
        }
        case "destroying": {
          offset = -0.75 * easeInOutSine(t);
          crate.group.scale.setScalar(1 - 0.6 * t);
          open = 0;
          led = LED.stopped;
          if (t >= 1) {
            this.object.remove(crate.group);
            crate.led.dispose();
            this.crates.splice(i, 1);
            continue;
          }
          break;
        }
      }

      crate.group.position.set(crate.x, crate.ground + HALF_HEIGHT - 0.04 + offset, crate.z);
      if (crate.state !== "destroying") crate.group.scale.set(1 - squash * 0.5, 1 + squash, 1 - squash * 0.5);
      crate.face.setOpen(open);
      crate.led.color.copy(led);
      crate.led.emissive.copy(led);
      crate.led.emissiveIntensity = glow * (1 + night * 1.2);
    }
  }

  private create(x: number, z: number, auto: boolean): Crate {
    const color = CRATE_COLORS[this.colorIndex % CRATE_COLORS.length] ?? "#60a5fa";
    this.colorIndex += 1;
    const group = new Group();
    const material = this.kit.material(color, { roughness: 0.45 });
    const body = part(this.geometry, material, [0, 0, 0]);
    const tint = new Color(color).multiplyScalar(0.82);
    group.add(body, part(this.lid, this.kit.material(`#${tint.getHexString()}`, { roughness: 0.5 }), [0, 0.2, 0]));
    const led = this.kit.uniqueMaterial("#22c55e", { roughness: 0.3, emissive: "#22c55e", emissiveIntensity: 1 });
    const ledMesh = part(this.kit.sphere, led, [0.19, 0.27, 0.19], 0.055);
    ledMesh.castShadow = false;
    group.add(ledMesh);
    const face = createFace(this.kit, 0.2, 0.038);
    face.group.position.set(0, -0.02, 0.315);
    group.add(face.group);
    group.rotation.y = randomBetween(-0.25, 0.25);
    this.object.add(group);

    const crate: Crate = {
      group,
      body,
      led,
      face,
      state: "running",
      age: 0,
      x,
      z,
      ground: sandHeight(x, z),
      auto,
      runFor: randomBetween(6, 10),
      sleepFor: randomBetween(3.5, 5.5),
      snooze: 0.4,
      blink: randomBetween(1, 4),
      phase: Math.random() * 10,
    };
    this.crates.push(crate);
    return crate;
  }

  private transition(context: FrameContext, crate: Crate, state: CrateState, label?: string): void {
    crate.state = state;
    crate.age = 0;
    if (state === "running") crate.runFor = randomBetween(6, 10);
    if (state === "stopped") crate.snooze = 0.5;
    if (state === "creating" || state === "destroying" || state === "resuming") {
      context.fx.particles.burst(new Vector3(crate.x, crate.ground + 0.05, crate.z), {
        count: state === "resuming" ? 8 : 16,
        colors: SAND_PUFF,
        speed: [0.6, 1.5],
        up: [1.0, 2.2],
        size: [0.035, 0.07],
        life: [0.45, 0.8],
      });
    }
    if (label) {
      context.fx.text.spawn(label, new Vector3(crate.x, crate.ground + 0.95, crate.z), { style: "label", height: 0.24, life: 1.5, rise: 0.3 });
    }
  }
}
