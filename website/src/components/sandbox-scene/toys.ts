import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferAttribute,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  clamp,
  createFace,
  createTextTexture,
  damp,
  easeInOutSine,
  lerpAngle,
  part,
  randomBetween,
  smoothstep,
  type Kit,
} from "./helpers";
import { CASTLE_SITE, LAGOON, RIVER, WATER_LEVEL, sandHeight } from "./terrain";
import type { Toy } from "./types";

const scratch = new Vector3();
const SAND_PUFF = ["#f3d59c", "#e6c184", "#fbe7bf"];
const SPLASH = ["#ffffff", "#bfe9ff", "#8fd3ff"];

const CONTAINER_COLORS = ["#3b82f6", "#ef4444", "#f59e0b", "#10b981", "#8b5cf6"];

/** A sleepy blue whale giving a ride to a stack of containers. */
export function createWhale(kit: Kit): Toy {
  const root = new Group();
  const bob = new Group();
  root.add(bob);
  const blue = kit.material("#5aa7e8", { roughness: 0.42 });
  const belly = kit.material("#d7ecff", { roughness: 0.5 });

  const body = part(kit.sphere, blue, [0, 0, 0], [1.15, 0.68, 0.8]);
  bob.add(body, part(kit.sphere, belly, [0.38, -0.24, 0], [0.74, 0.4, 0.62]));
  for (const side of [-1, 1]) bob.add(part(kit.sphere, blue, [0.3, -0.32, side * 0.72], [0.32, 0.07, 0.18], [side * 0.5, side * 0.6, 0]));

  const tail = new Group();
  tail.position.set(-0.95, 0.05, 0);
  tail.add(part(kit.sphere, blue, [-0.25, 0.14, 0], [0.42, 0.2, 0.22], [0, 0, 0.55]));
  for (const side of [-1, 1]) tail.add(part(kit.sphere, blue, [-0.55, 0.42, side * 0.2], [0.27, 0.05, 0.19], [side * 0.35, side * 0.55, 0.35]));
  bob.add(tail);

  const face = createFace(kit, 0.62, 0.075, { curvature: 1.1 });
  face.group.position.set(1.1, 0.12, 0);
  face.group.rotation.y = Math.PI / 2;
  bob.add(face.group);

  const crate = new RoundedBoxGeometry(0.3, 0.27, 0.42, 2, 0.05);
  const stack: [number, number, number][] = [
    [-0.55, 0.74, 0.04],
    [-0.22, 0.76, -0.03],
    [0.11, 0.73, 0.05],
    [-0.38, 1.03, 0],
    [-0.05, 1.04, -0.06],
  ];
  stack.forEach(([x, y, tilt], index) => {
    bob.add(part(crate, kit.material(CONTAINER_COLORS[index] ?? "#3b82f6", { roughness: 0.5 }), [x, y, 0], 1, [0, tilt, tilt * 0.5]));
  });

  const blowhole = new Object3D();
  blowhole.position.set(0.55, 0.6, 0);
  bob.add(blowhole);

  let heading = -0.5;
  let spoutTimer = 2.5;
  let spouting = 0;
  let blink = 3;

  const spout = (): void => {
    spouting = 0.7;
  };

  return {
    object: root,
    targets: [body],
    onClick: () => spout(),
    update({ time, dt, fx }) {
      const s = time * 0.16;
      const target = Math.cos(s) >= 0 ? -0.5 : Math.PI + 0.5;
      heading = lerpAngle(heading, target, damp(1.4, dt));
      root.position.set(LAGOON.x + 0.95 * Math.sin(s), WATER_LEVEL + 0.2 + 0.05 * Math.sin(time * 1.7), LAGOON.z + 0.12 + 0.18 * Math.sin(s * 2));
      root.rotation.y = heading;
      bob.rotation.z = 0.06 * Math.sin(time * 1.7 + 1);
      bob.rotation.x = 0.04 * Math.sin(time * 1.3);
      tail.rotation.z = 0.3 * Math.sin(time * 3);

      spoutTimer -= dt;
      if (spoutTimer <= 0) {
        spout();
        spoutTimer = randomBetween(6, 9);
      }
      blink -= dt;
      if (spouting > 0) {
        spouting -= dt;
        face.setOpen(0.15);
        blowhole.getWorldPosition(scratch);
        for (let i = 0; i < 3; i += 1) {
          const velocity = new Vector3(randomBetween(-0.4, 0.4), randomBetween(3, 4.2), randomBetween(-0.4, 0.4));
          fx.particles.emit(scratch, velocity, SPLASH[i % SPLASH.length] ?? "#ffffff", randomBetween(0.05, 0.09), 1.3, 7, WATER_LEVEL);
        }
      } else if (blink < 0.12) {
        face.setOpen(0.1);
        if (blink <= 0) blink = randomBetween(2.5, 5);
      } else {
        face.setOpen(1);
      }
    },
  };
}

const DUCK_SAYS = ["quack!", "LGTM!", "quack?", "ship it!", "it works!"];

/** A rubber debugging duck paddling up and down the river. */
export function createDuck(kit: Kit): Toy {
  const root = new Group();
  const inner = new Group();
  root.add(inner);
  const yellow = kit.material("#ffd23f", { roughness: 0.32 });
  const orange = kit.material("#ff8a3d", { roughness: 0.4 });
  const body = part(kit.sphere, yellow, [0, 0, 0], [0.32, 0.21, 0.25]);
  inner.add(
    body,
    part(kit.sphere, yellow, [-0.25, 0.09, 0], [0.12, 0.09, 0.1], [0, 0, 0.7]),
    part(kit.sphere, yellow, [0.17, 0.24, 0], 0.16),
    part(kit.sphere, orange, [0.32, 0.21, 0], [0.09, 0.035, 0.075]),
  );
  for (const side of [-1, 1]) inner.add(part(kit.sphere, kit.material("#ffc21a", { roughness: 0.35 }), [-0.03, 0.05, side * 0.21], [0.16, 0.09, 0.05], [0, 0, -0.3]));
  const face = createFace(kit, 0.15, 0.026, { smile: false, curvature: 3 });
  face.group.position.set(0.31, 0.29, 0);
  face.group.rotation.y = Math.PI / 2;
  inner.add(face.group);

  let u = 0.12;
  let direction = 1;
  let heading = 0;
  let hop = -1;
  let said = 0;
  const tangent = new Vector3();

  return {
    object: root,
    targets: [body],
    onClick({ fx }) {
      if (hop >= 0) return;
      hop = 0;
      fx.text.spawn(DUCK_SAYS[said % DUCK_SAYS.length] ?? "quack!", root.position.clone().add(new Vector3(0, 0.75, 0)), {
        style: "bubble",
        height: 0.36,
        life: 1.7,
        rise: 0.35,
      });
      said += 1;
    },
    update({ time, dt, fx }) {
      u += direction * 0.026 * dt;
      if (u > 0.9) direction = -1;
      if (u < 0.06) direction = 1;
      const point = RIVER.getPointAt(clamp(u));
      RIVER.getTangentAt(clamp(u), tangent).multiplyScalar(direction);
      heading = lerpAngle(heading, Math.atan2(-tangent.z, tangent.x), damp(2.5, dt));

      let lift = 0;
      let spin = 0;
      if (hop >= 0) {
        hop += dt / 0.75;
        lift = Math.sin(Math.PI * Math.min(1, hop)) * 0.65;
        spin = easeInOutSine(hop) * Math.PI * 2;
        if (hop >= 1) {
          hop = -1;
          fx.particles.burst(root.position, { count: 12, colors: SPLASH, speed: [0.6, 1.4], up: [1.2, 2.2], size: [0.04, 0.07], life: [0.5, 0.8], floor: WATER_LEVEL - 0.05 });
        }
      }
      root.position.set(point.x, WATER_LEVEL + 0.09 + 0.025 * Math.sin(time * 2.6) + lift, point.z);
      root.rotation.y = heading;
      inner.rotation.set(0.07 * Math.sin(time * 2.1), spin, 0.05 * Math.sin(time * 1.7));
      face.setOpen((time % 4.3) < 0.12 ? 0.1 : 1);
    },
  };
}

/** An orange crab scuttling sideways, carrying a container over its head. */
export function createCrab(kit: Kit): Toy {
  const root = new Group();
  const inner = new Group();
  root.add(inner);
  const shell = kit.material("#f4672d", { roughness: 0.5 });
  const shellDark = kit.material("#d9541f", { roughness: 0.55 });
  const white = kit.material("#ffffff", { roughness: 0.3 });
  const ink = kit.material("#1f2430", { roughness: 0.35 });

  const body = part(kit.sphere, shell, [0, 0, 0], [0.36, 0.18, 0.27]);
  inner.add(body);
  for (const side of [-1, 1]) {
    inner.add(
      part(kit.cylinder, shellDark, [side * 0.1, 0.2, 0.1], [0.022, 0.16, 0.022]),
      part(kit.sphere, white, [side * 0.1, 0.3, 0.1], 0.055),
      part(kit.sphere, ink, [side * 0.1, 0.305, 0.145], 0.028),
    );
  }
  inner.add(part(kit.smile, ink, [0, 0.0, 0.265], 0.045, [0, 0, Math.PI]));

  const pincers: Mesh[] = [];
  for (const side of [-1, 1]) {
    const arm = new Group();
    arm.position.set(side * 0.27, 0.06, 0.04);
    arm.rotation.z = side * -0.35;
    arm.add(part(kit.cylinder, shellDark, [0, 0.13, 0], [0.035, 0.26, 0.035]));
    arm.add(part(kit.sphere, shell, [0, 0.3, 0], [0.11, 0.09, 0.08]));
    const pincer = part(kit.sphere, shell, [side * -0.05, 0.37, 0], [0.07, 0.035, 0.06]);
    pincers.push(pincer);
    arm.add(pincer);
    inner.add(arm);
  }
  // The container it is carrying, held up between the claws.
  inner.add(part(new RoundedBoxGeometry(0.3, 0.22, 0.24, 2, 0.04), kit.material("#3b82f6", { roughness: 0.5 }), [0, 0.47, 0.04], 1, [0, 0.15, 0]));

  const legs: { leg: Group; phase: number; side: number }[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i += 1) {
      const leg = new Group();
      leg.position.set(side * 0.26, -0.03, -0.1 + i * 0.1);
      leg.add(part(kit.cylinder, shellDark, [side * 0.1, -0.06, 0], [0.022, 0.2, 0.022], [0, 0, side * 1.0]));
      inner.add(leg);
      legs.push({ leg, phase: i * 1.6 + (side > 0 ? 0.8 : 0), side });
    }
  }

  const z = 1.2;
  let lastX = 3.3;
  let hop = -1;

  return {
    object: root,
    targets: [body],
    onClick({ fx }) {
      if (hop >= 0) return;
      hop = 0;
      fx.text.spawn("snip snap!", root.position.clone().add(new Vector3(0, 1.0, 0)), { style: "bubble", height: 0.32, life: 1.5, rise: 0.3 });
    },
    update({ time, dt, fx }) {
      const cycle = (time * 0.075) % 2;
      const s = cycle < 1 ? cycle : 2 - cycle;
      const x = 3.3 + 3.8 * smoothstep(0.12, 0.88, s);
      const walk = clamp(Math.abs(x - lastX) / Math.max(dt, 1e-3) / 0.35);
      lastX = x;

      let lift = 0;
      let snap = Math.max(0, Math.sin(time * 4)) ** 4;
      if (hop >= 0) {
        hop += dt / 0.6;
        lift = Math.sin(Math.PI * Math.min(1, hop)) * 0.45;
        snap = Math.abs(Math.sin(hop * Math.PI * 4));
        if (hop >= 1) {
          hop = -1;
          fx.particles.burst(root.position, { count: 10, colors: SAND_PUFF, speed: [0.5, 1.2], up: [0.6, 1.4], size: [0.035, 0.06], life: [0.4, 0.7] });
        }
      }
      root.position.set(x, sandHeight(x, z) + 0.2 + lift + 0.025 * Math.abs(Math.sin(time * 14)) * walk, z);
      inner.rotation.z = 0.06 * Math.sin(time * 14) * walk;
      for (const { leg, phase, side } of legs) leg.rotation.z = side * 0.35 * Math.sin(time * 14 + phase) * walk;
      pincers.forEach((pincer, index) => {
        pincer.rotation.z = (index === 0 ? 1 : -1) * 0.5 * snap;
      });
    },
  };
}

/** A sandcastle whose keep is a little server rack with blinking lights. */
export function createCastle(kit: Kit): Toy {
  const castle = new Group();
  castle.position.set(CASTLE_SITE.x, sandHeight(CASTLE_SITE.x, CASTLE_SITE.z) - 0.08, CASTLE_SITE.z);
  castle.rotation.y = 0.12;
  const sandy = kit.material("#e9c17e", { roughness: 1 });
  const sandyDark = kit.material("#c99c5c", { roughness: 1 });
  const merlon = new RoundedBoxGeometry(0.12, 0.13, 0.12, 1, 0.025);
  const windows: MeshStandardMaterial[] = [];

  const crenellate = (radius: number, y: number, count: number, x = 0, z = 0): void => {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      castle.add(part(merlon, sandy, [x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius], 1, [0, -angle, 0]));
    }
  };

  const tower = new CylinderGeometry(0.28, 0.36, 0.95, 22);
  const corners: [number, number][] = [
    [-0.78, -0.62],
    [0.78, -0.62],
    [-0.78, 0.66],
    [0.78, 0.66],
  ];
  for (const [x, z] of corners) {
    castle.add(part(tower, sandy, [x, 0.47, z]));
    crenellate(0.24, 1.0, 6, x, z);
    if (z > 0) {
      const glow = kit.uniqueMaterial("#7a5a35", { roughness: 0.8, emissive: "#ffb347", emissiveIntensity: 0 });
      windows.push(glow);
      castle.add(part(new RoundedBoxGeometry(0.11, 0.17, 0.06, 1, 0.03), glow, [x, 0.6, z + 0.31]));
    }
  }
  const wallX = new RoundedBoxGeometry(1.3, 0.55, 0.22, 2, 0.05);
  const wallZ = new RoundedBoxGeometry(0.22, 0.55, 1.05, 2, 0.05);
  castle.add(
    part(wallX, sandy, [0, 0.27, 0.66]),
    part(wallX, sandy, [0, 0.27, -0.62]),
    part(wallZ, sandy, [-0.78, 0.27, 0.02]),
    part(wallZ, sandy, [0.78, 0.27, 0.02]),
    part(new RoundedBoxGeometry(0.3, 0.34, 0.06, 2, 0.06), sandyDark, [0, 0.17, 0.78]),
  );
  for (let i = 0; i < 4; i += 1) castle.add(part(merlon, sandy, [-0.42 + i * 0.28, 0.6, 0.66]));

  // The keep: a server rack.
  const rack = kit.material("#2b3446", { roughness: 0.45, metalness: 0.25 });
  const unit = kit.material("#3e4b66", { roughness: 0.5, metalness: 0.2 });
  castle.add(part(new RoundedBoxGeometry(0.72, 1.5, 0.62, 3, 0.07), rack, [0, 0.76, 0]));
  const leds: { material: MeshStandardMaterial; rate: number; phase: number }[] = [];
  const ledColors = ["#22c55e", "#22d3ee", "#22c55e", "#f59e0b"];
  const ledGeometry = new RoundedBoxGeometry(0.045, 0.045, 0.03, 1, 0.01);
  for (let i = 0; i < 5; i += 1) {
    const y = 0.22 + i * 0.25;
    castle.add(part(new RoundedBoxGeometry(0.6, 0.18, 0.04, 1, 0.02), unit, [0, y, 0.31]));
    castle.add(part(kit.box, rack, [-0.12, y, 0.335], [0.26, 0.03, 0.01]));
    for (let j = 0; j < 3; j += 1) {
      const color = ledColors[(i + j) % ledColors.length] ?? "#22c55e";
      const material = kit.uniqueMaterial(color, { roughness: 0.3, emissive: color, emissiveIntensity: 1 });
      leds.push({ material, rate: randomBetween(1.5, 6), phase: Math.random() * 10 });
      const led = part(ledGeometry, material, [0.12 + j * 0.07, y, 0.335]);
      led.castShadow = false;
      castle.add(led);
    }
  }

  // A ">_" flag on top of the rack.
  castle.add(part(kit.cylinder, kit.material("#f8fafc", { roughness: 0.5 }), [0, 1.82, 0], [0.018, 0.65, 0.018]));
  const flagTexture = createTextTexture(">_", { size: 72, color: "#ffffff", background: "#2563eb" });
  const flagGeometry = new PlaneGeometry(0.52, 0.32, 12, 4);
  flagGeometry.translate(0.26, 0, 0);
  const flagRest = Float32Array.from((flagGeometry.attributes.position as BufferAttribute).array);
  const flag = new Mesh(flagGeometry, new MeshStandardMaterial({ map: flagTexture.texture, side: DoubleSide, roughness: 0.7 }));
  flag.position.set(0.02, 1.98, 0);
  flag.castShadow = true;
  castle.add(flag);

  // Little pennants on the front towers.
  const pennant = new Shape();
  pennant.moveTo(0, 0);
  pennant.lineTo(0.3, 0.08);
  pennant.lineTo(0, 0.16);
  const pennantGeometry = new ShapeGeometry(pennant);
  const pennants: Mesh[] = [];
  corners.slice(2).forEach(([x, z], index) => {
    castle.add(part(kit.cylinder, kit.material("#f8fafc"), [x, 1.3, z], [0.012, 0.5, 0.012]));
    const p = new Mesh(pennantGeometry, new MeshStandardMaterial({ color: index === 0 ? "#f87171" : "#fbbf24", side: DoubleSide }));
    p.position.set(x, 1.38, z);
    pennants.push(p);
    castle.add(p);
  });

  return {
    object: castle,
    update({ time, night }) {
      const positions = flagGeometry.attributes.position as BufferAttribute;
      for (let i = 0; i < positions.count; i += 1) {
        const x = flagRest[i * 3] ?? 0;
        positions.setZ(i, Math.sin(x * 9 - time * 6) * 0.05 * (x / 0.52));
      }
      positions.needsUpdate = true;
      flagGeometry.computeVertexNormals();
      pennants.forEach((p, index) => {
        p.rotation.y = 0.35 * Math.sin(time * 3 + index * 1.7);
      });
      for (const { material, rate, phase } of leds) {
        const on = Math.sin(time * rate + phase) > -0.2 ? 1 : 0.15;
        material.emissiveIntensity = on * (1.1 + night * 1.6);
      }
      windows.forEach((material, index) => {
        material.emissiveIntensity = night * (1.8 + 0.25 * Math.sin(time * 7 + index * 3) * Math.sin(time * 2.3 + index));
      });
    },
  };
}

/** A pink bucket that serves on port 3000, and a shovel stuck in the sand. */
export function createBucketAndShovel(kit: Kit): Toy {
  const object = new Group();
  const bucket = new Group();
  const bx = 5.95;
  const bz = 2.55;
  bucket.position.set(bx, sandHeight(bx, bz) + 0.3, bz);
  bucket.rotation.z = 0.05;
  const pink = new MeshStandardMaterial({ color: "#ff7aa2", roughness: 0.4, side: DoubleSide });
  bucket.add(
    part(new CylinderGeometry(0.5, 0.38, 0.8, 36, 1, true), pink),
    part(new TorusGeometry(0.5, 0.045, 10, 40), pink, [0, 0.4, 0], 1, [Math.PI / 2, 0, 0]),
    part(kit.sphere, kit.material("#ecc98c", { roughness: 1 }), [0, 0.33, 0], [0.47, 0.12, 0.47]),
    part(new TorusGeometry(0.5, 0.022, 8, 32, Math.PI), kit.material("#f8fafc", { roughness: 0.4 }), [0, 0.38, 0], 1, [-0.55, 0, 0]),
  );
  const label = createTextTexture(":3000", { size: 72, color: "#ffffff" });
  const labelMesh = new Mesh(
    new CylinderGeometry(0.474, 0.432, 0.3, 32, 1, true, -0.78, 1.56),
    new MeshStandardMaterial({ map: label.texture, transparent: true, roughness: 0.5 }),
  );
  labelMesh.position.y = 0.03;
  bucket.add(labelMesh);
  object.add(bucket);

  const shovel = new Group();
  const sx = 6.95;
  const sz = 3.2;
  shovel.position.set(sx, sandHeight(sx, sz) - 0.05, sz);
  const blue = kit.material("#3b82f6", { roughness: 0.4 });
  shovel.add(
    part(kit.cylinder, blue, [0, 0.62, 0], [0.045, 1.0, 0.045]),
    part(new TorusGeometry(0.11, 0.035, 8, 20), blue, [0, 1.2, 0]),
    part(kit.sphere, kit.material("#60a5fa", { roughness: 0.4 }), [0, 0.08, 0], [0.22, 0.28, 0.06]),
  );
  object.add(shovel);

  return {
    object,
    update({ time }) {
      shovel.rotation.set(-0.25, 0, -0.42 + 0.025 * Math.sin(time * 1.3));
    },
  };
}

/** A bouncing beach ball. Click it for a big bounce. */
export function createBeachBall(): Toy {
  const geometry = new SphereGeometry(0.4, 36, 18);
  const positions = geometry.attributes.position as BufferAttribute;
  const colors = new Float32Array(positions.count * 3);
  const stripes = ["#ef4444", "#ffffff", "#3b82f6", "#facc15", "#ffffff", "#22c55e"].map((hex) => new Color(hex));
  const white = new Color("#ffffff");
  for (let i = 0; i < positions.count; i += 1) {
    const angle = Math.atan2(positions.getZ(i), positions.getX(i)) + Math.PI;
    const stripe = stripes[Math.floor((angle / (Math.PI * 2)) * stripes.length) % stripes.length] ?? white;
    (Math.abs(positions.getY(i)) > 0.35 ? white : stripe).toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const ball = part(geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.35 }));
  const holder = new Group();
  holder.add(ball);
  const x = 3.45;
  const z = 2.85;
  const ground = sandHeight(x, z) + 0.38;
  let phase = 0;
  let kick = 0;

  return {
    object: holder,
    targets: [ball],
    onClick() {
      kick = Math.min(2.2, kick + 1.3);
    },
    update({ dt, fx }) {
      const previous = phase;
      phase = (phase + dt * 0.85) % 1;
      if (phase < previous) {
        kick *= 0.45;
        fx.particles.burst(new Vector3(x, ground - 0.35, z), { count: 5, colors: SAND_PUFF, speed: [0.4, 0.9], up: [0.5, 1.1], size: [0.03, 0.05], life: [0.35, 0.6] });
      }
      const height = 4 * phase * (1 - phase) * (0.5 + kick);
      const contact = 1 - smoothstep(0, 0.07, Math.min(phase, 1 - phase));
      holder.position.set(x, ground + height - contact * 0.05, z);
      holder.scale.set(1 + 0.12 * contact, 1 - 0.2 * contact, 1 + 0.12 * contact);
      ball.rotation.z -= dt * 1.6;
      ball.rotation.x += dt * 0.5;
    },
  };
}

/** Sand molds: a triangle pyramid and a stack of database disks. */
export function createSandMolds(kit: Kit): Toy {
  const object = new Group();
  const sandy = kit.material("#e9c17e", { roughness: 1 });
  const groove = kit.material("#d2a564", { roughness: 1 });

  const px = -1.95;
  const pz = -2.95;
  object.add(part(new ConeGeometry(0.66, 0.88, 3), sandy, [px, sandHeight(px, pz) + 0.36, pz], 1, [0, Math.PI, 0]));

  const dx = 0.2;
  const dz = -3.05;
  const base = sandHeight(dx, dz) - 0.02;
  const disk = new CylinderGeometry(0.42, 0.44, 0.22, 32);
  for (let i = 0; i < 3; i += 1) {
    object.add(part(disk, sandy, [dx, base + 0.11 + i * 0.25, dz], [1 - i * 0.03, 1, 1 - i * 0.03]));
    if (i < 2) object.add(part(kit.cylinder, groove, [dx, base + 0.235 + i * 0.25, dz], [0.405 - i * 0.012, 0.03, 0.405 - i * 0.012]));
  }
  object.add(part(new SphereGeometry(0.11, 16, 8, 0, Math.PI), kit.material("#fde2e4", { roughness: 0.6 }), [dx, base + 0.73, dz], [1, 0.45, 1], [0, 0.6, 0]));
  return { object, update() {} };
}

/** A pinwheel turning in the breeze. */
export function createPinwheel(kit: Kit): Toy {
  const object = new Group();
  const x = -7.15;
  const z = 3.55;
  object.position.set(x, sandHeight(x, z) - 0.05, z);
  object.add(part(kit.cylinder, kit.material("#f8fafc", { roughness: 0.5 }), [0, 0.6, 0], [0.025, 1.2, 0.025]));
  const wheel = new Group();
  wheel.position.set(0, 1.2, 0.06);
  const blade = new Shape();
  blade.moveTo(0, 0);
  blade.lineTo(0.38, 0);
  blade.lineTo(0.38, 0.38);
  const bladeGeometry = new ShapeGeometry(blade);
  ["#f87171", "#fbbf24", "#60a5fa", "#34d399"].forEach((color, index) => {
    const mesh = new Mesh(bladeGeometry, new MeshStandardMaterial({ color, side: DoubleSide, roughness: 0.5 }));
    mesh.rotation.z = (index * Math.PI) / 2;
    mesh.castShadow = true;
    wheel.add(mesh);
  });
  wheel.add(part(kit.sphere, kit.material("#f8fafc"), [0, 0, 0.02], 0.05));
  object.add(wheel);
  return {
    object,
    update({ dt, time }) {
      wheel.rotation.z -= dt * (3 + 2 * Math.sin(time * 0.4));
    },
  };
}

/** Starfish with sleepy faces and a seashell. */
export function createBeachDecor(kit: Kit): Toy {
  const object = new Group();
  const star = new Shape();
  for (let i = 0; i <= 10; i += 1) {
    const angle = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const radius = i % 2 === 0 ? 0.27 : 0.12;
    const px = Math.cos(angle) * radius;
    const py = Math.sin(angle) * radius;
    if (i === 0) star.moveTo(px, py);
    else star.lineTo(px, py);
  }
  const starGeometry = new ExtrudeGeometry(star, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 });
  const starfish: Group[] = [];
  (
    [
      [-2.9, 3.45, "#ff8a65", 0.3],
      [4.45, 3.8, "#f472b6", -0.4],
    ] as const
  ).forEach(([x, z, color, spin]) => {
    const group = new Group();
    group.position.set(x, sandHeight(x, z) + 0.02, z);
    group.rotation.y = spin;
    group.add(part(starGeometry, kit.material(color, { roughness: 0.7 }), [0, 0, 0], 1, [-Math.PI / 2, 0, 0]));
    const face = createFace(kit, 0.08, 0.018, { blush: false });
    face.group.position.set(0, 0.075, 0.01);
    face.group.rotation.x = -Math.PI / 2;
    group.add(face.group);
    starfish.push(group);
    object.add(group);
  });
  const sx = 1.9;
  const sz = 3.7;
  object.add(part(new SphereGeometry(0.17, 18, 8, 0, Math.PI), kit.material("#fde2e4", { roughness: 0.6 }), [sx, sandHeight(sx, sz), sz], [1, 0.45, 1], [0, 2.2, 0]));
  return {
    object,
    update({ time }) {
      starfish.forEach((group, index) => {
        group.scale.setScalar(1 + 0.04 * Math.sin(time * 1.5 + index * 2));
      });
    },
  };
}

/** A seagull gliding over the sandbox in the daytime. */
export function createSeagull(kit: Kit): Toy {
  const root = new Group();
  const inner = new Group();
  root.add(inner);
  const white = kit.material("#ffffff", { roughness: 0.6 });
  const grey = kit.material("#cbd5e1", { roughness: 0.6 });
  const ink = kit.material("#1f2430", { roughness: 0.35 });
  inner.add(
    part(kit.sphere, white, [0, 0, 0], [0.3, 0.14, 0.15]),
    part(kit.sphere, white, [0.26, 0.07, 0], 0.11),
    part(kit.sphere, kit.material("#ff9f43", { roughness: 0.4 }), [0.38, 0.05, 0], [0.08, 0.025, 0.03]),
    part(kit.sphere, grey, [-0.3, 0.03, 0], [0.13, 0.02, 0.09]),
  );
  for (const side of [-1, 1]) inner.add(part(kit.sphere, ink, [0.33, 0.1, side * 0.06], 0.018));
  const wings = [-1, 1].map((side) => {
    const wing = new Group();
    wing.position.set(0, 0.05, side * 0.1);
    wing.add(part(kit.sphere, white, [0, 0, side * 0.32], [0.17, 0.025, 0.36]));
    wing.add(part(kit.sphere, grey, [-0.04, 0, side * 0.62], [0.11, 0.02, 0.12]));
    inner.add(wing);
    return { wing, side };
  });

  return {
    object: root,
    update({ time, night }) {
      const angle = time * 0.3;
      root.position.set(Math.cos(angle) * 6.2, 3.3 + 0.25 * Math.sin(time * 0.9), -0.6 + Math.sin(angle) * 3.4);
      const tx = -Math.sin(angle) * 6.2;
      const tz = Math.cos(angle) * 3.4;
      root.rotation.y = Math.atan2(-tz, tx);
      inner.rotation.x = -0.3;
      const flapping = Math.sin(time * 0.8) > -0.3;
      for (const { wing, side } of wings) wing.rotation.x = side * (flapping ? 0.55 * Math.sin(time * 9) : 0.12);
      const visible = 1 - smoothstep(0.15, 0.6, night);
      root.scale.setScalar(visible);
      root.visible = visible > 0.01;
    },
  };
}

