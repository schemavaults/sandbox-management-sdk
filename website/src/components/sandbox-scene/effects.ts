import {
  Color,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Sprite,
  SpriteMaterial,
  Vector3,
  type CanvasTexture,
} from "three";
import { createTextTexture, easeOutBack, randomBetween } from "./helpers";

interface Particle {
  alive: boolean;
  position: Vector3;
  velocity: Vector3;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
  floor: number;
}

export interface BurstOptions {
  count: number;
  colors: string[];
  speed: [number, number];
  up: [number, number];
  size: [number, number];
  life: [number, number];
  gravity?: number;
  floor?: number;
}

const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/** A fixed pool of little spheres: water droplets, sand puffs, splashes. */
export class Particles {
  readonly mesh: InstancedMesh;
  private readonly items: Particle[];
  private cursor = 0;
  private active = false;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly velocity = new Vector3();

  constructor(capacity = 240) {
    this.mesh = new InstancedMesh(new IcosahedronGeometry(1, 1), new MeshStandardMaterial({ roughness: 0.5 }), capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < capacity; i += 1) {
      this.mesh.setMatrixAt(i, HIDDEN);
      this.mesh.setColorAt(i, this.color.set("#ffffff"));
    }
    this.items = Array.from({ length: capacity }, () => ({
      alive: false,
      position: new Vector3(),
      velocity: new Vector3(),
      life: 0,
      maxLife: 1,
      size: 0.05,
      gravity: 9.8,
      floor: -Infinity,
    }));
  }

  burst(origin: Vector3, options: BurstOptions): void {
    for (let i = 0; i < options.count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = randomBetween(...options.speed);
      this.velocity.set(Math.cos(angle) * speed, randomBetween(...options.up), Math.sin(angle) * speed);
      const color = options.colors[i % options.colors.length] ?? "#ffffff";
      this.emit(origin, this.velocity, color, randomBetween(...options.size), randomBetween(...options.life), options.gravity, options.floor);
    }
  }

  emit(position: Vector3, velocity: Vector3, color: string, size: number, life: number, gravity = 9.8, floor = -Infinity): void {
    const index = this.cursor;
    const particle = this.items[index];
    if (!particle) return;
    this.cursor = (this.cursor + 1) % this.items.length;
    particle.alive = true;
    particle.position.copy(position);
    particle.velocity.copy(velocity);
    particle.life = particle.maxLife = life;
    particle.size = size;
    particle.gravity = gravity;
    particle.floor = floor;
    this.mesh.setColorAt(index, this.color.set(color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.active = true;
  }

  update(dt: number): void {
    if (!this.active) return;
    let alive = 0;
    this.items.forEach((particle, index) => {
      if (!particle.alive) return;
      particle.life -= dt;
      particle.velocity.y -= particle.gravity * dt;
      particle.position.addScaledVector(particle.velocity, dt);
      if (particle.life <= 0 || particle.position.y < particle.floor) {
        particle.alive = false;
        this.mesh.setMatrixAt(index, HIDDEN);
        return;
      }
      alive += 1;
      const k = particle.life / particle.maxLife;
      this.dummy.position.copy(particle.position);
      this.dummy.scale.setScalar(particle.size * (0.35 + 0.65 * Math.sqrt(k)));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(index, this.dummy.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.active = alive > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
    this.mesh.dispose();
  }
}

export type TextStyle = "bubble" | "label" | "plain";

interface Floater {
  sprite: Sprite;
  life: number;
  maxLife: number;
  rise: number;
  drift: number;
  width: number;
  height: number;
}

const TEXT_STYLES: Record<TextStyle, Parameters<typeof createTextTexture>[1]> = {
  bubble: { size: 56, color: "#1f2430", background: "#ffffff", border: "#1f2430" },
  label: { size: 44, weight: 600, color: "#f8fafc", background: "rgba(15, 23, 42, 0.82)" },
  plain: { size: 72, weight: 800, color: "#c4b5fd" },
};

/** Little sprites of text that pop in, float up and fade out ("quack!", "z", "create()"). */
export class FloatingText {
  readonly group = new Group();
  private readonly textures = new Map<string, { texture: CanvasTexture; aspect: number }>();
  private readonly items: Floater[] = [];

  spawn(text: string, position: Vector3, options: { style: TextStyle; height: number; life?: number; rise?: number; drift?: number }): void {
    const key = `${options.style}:${text}`;
    let entry = this.textures.get(key);
    if (!entry) {
      entry = createTextTexture(text, TEXT_STYLES[options.style]);
      this.textures.set(key, entry);
    }
    const sprite = new Sprite(new SpriteMaterial({ map: entry.texture, transparent: true, depthWrite: false, toneMapped: false }));
    sprite.position.copy(position);
    sprite.renderOrder = 10;
    this.group.add(sprite);
    const life = options.life ?? 1.6;
    this.items.push({
      sprite,
      life,
      maxLife: life,
      rise: options.rise ?? 0.6,
      drift: options.drift ?? 0,
      width: options.height * entry.aspect,
      height: options.height,
    });
    if (this.items.length > 24) this.remove(0);
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i];
      if (!item) continue;
      item.life -= dt;
      if (item.life <= 0) {
        this.remove(i);
        continue;
      }
      const age = item.maxLife - item.life;
      const pop = easeOutBack(Math.min(1, age * 5));
      item.sprite.scale.set(item.width * pop, item.height * pop, 1);
      item.sprite.position.y += item.rise * dt;
      item.sprite.position.x += item.drift * Math.sin(age * 3) * dt;
      item.sprite.material.opacity = Math.min(1, item.life / (item.maxLife * 0.35));
    }
  }

  private remove(index: number): void {
    const [item] = this.items.splice(index, 1);
    if (!item) return;
    this.group.remove(item.sprite);
    item.sprite.material.dispose();
  }

  dispose(): void {
    while (this.items.length > 0) this.remove(0);
    for (const { texture } of this.textures.values()) texture.dispose();
    this.textures.clear();
  }
}

export interface Effects {
  particles: Particles;
  text: FloatingText;
}
