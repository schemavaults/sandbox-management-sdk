import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from "three";

export type Vec3Tuple = [number, number, number];

export const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * clamp(t)) - 1) / 2;
}

/** Interpolates between two angles along the shorter way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

/** Frame-rate independent smoothing factor for `value += (target - value) * damp(...)`. */
export const damp = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);

export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min);

interface MaterialOptions {
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

/** Shared unit geometries and a material cache, so toys stay cheap to build. */
export class Kit {
  readonly sphere = new SphereGeometry(1, 28, 20);
  readonly cylinder = new CylinderGeometry(1, 1, 1, 24);
  readonly box = new BoxGeometry(1, 1, 1);
  readonly smile = new TorusGeometry(1, 0.22, 8, 18, Math.PI);
  private readonly materials = new Map<string, MeshStandardMaterial>();

  material(color: string, options: MaterialOptions = {}): MeshStandardMaterial {
    const key = [color, options.roughness, options.metalness, options.emissive, options.emissiveIntensity].join("|");
    let material = this.materials.get(key);
    if (!material) {
      material = Kit.createMaterial(color, options);
      this.materials.set(key, material);
    }
    return material;
  }

  /** A material that is not shared, for parts that animate their own color or glow. */
  uniqueMaterial(color: string, options: MaterialOptions = {}): MeshStandardMaterial {
    return Kit.createMaterial(color, options);
  }

  private static createMaterial(color: string, options: MaterialOptions): MeshStandardMaterial {
    return new MeshStandardMaterial({
      color,
      roughness: options.roughness ?? 0.6,
      metalness: options.metalness ?? 0,
      emissive: options.emissive ?? "#000000",
      emissiveIntensity: options.emissiveIntensity ?? 0,
    });
  }
}

export function part(
  geometry: BufferGeometry,
  material: Material,
  position: Vec3Tuple = [0, 0, 0],
  scale: number | Vec3Tuple = 1,
  rotation: Vec3Tuple = [0, 0, 0],
): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(...position);
  if (typeof scale === "number") mesh.scale.setScalar(scale);
  else mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export interface Face {
  group: Group;
  /** 1 = eyes open, 0 = closed. */
  setOpen(open: number): void;
}

/** A tiny kawaii face (eyes with glints, a smile and blushing cheeks) looking down local +z. */
export function createFace(
  kit: Kit,
  spacing: number,
  eyeSize: number,
  options: { smile?: boolean; blush?: boolean; curvature?: number } = {},
): Face {
  const group = new Group();
  // Pulls features near the sides back so they hug a rounded body.
  const sink = (x: number): number => -(options.curvature ?? 0) * x * x;
  const ink = kit.material("#1f2430", { roughness: 0.35 });
  const glint = kit.material("#ffffff", { roughness: 0.2, emissive: "#ffffff", emissiveIntensity: 0.6 });
  const cheek = kit.material("#ff8fab", { roughness: 0.9 });

  const eyes = [-1, 1].map((side) => {
    const eye = part(kit.sphere, ink, [(side * spacing) / 2, 0, sink(spacing / 2)], [eyeSize, eyeSize * 1.1, eyeSize * 0.6]);
    eye.castShadow = false;
    eye.add(part(kit.sphere, glint, [0.35, 0.4, 0.75], 0.32));
    group.add(eye);
    return eye;
  });

  if (options.smile ?? true) {
    const smile = part(kit.smile, ink, [0, -eyeSize * 1.5, 0], eyeSize * 0.75, [0, 0, Math.PI]);
    smile.castShadow = false;
    group.add(smile);
  }
  if (options.blush ?? true) {
    for (const side of [-1, 1]) {
      const cheekX = spacing / 2 + eyeSize * 1.5;
      const blush = part(kit.sphere, cheek, [side * cheekX, -eyeSize * 1.2, sink(cheekX) - eyeSize * 0.2], [
        eyeSize * 1.1,
        eyeSize * 0.6,
        eyeSize * 0.3,
      ]);
      blush.castShadow = false;
      group.add(blush);
    }
  }

  return {
    group,
    setOpen(open) {
      for (const eye of eyes) eye.scale.y = eyeSize * 1.1 * Math.max(0.12, open);
    },
  };
}

interface TextTextureOptions {
  size?: number;
  weight?: number;
  family?: string;
  color?: string;
  background?: string;
  border?: string;
}

/** Renders a line of text to a texture. Returns the texture and its width / height ratio. */
export function createTextTexture(text: string, options: TextTextureOptions = {}): { texture: CanvasTexture; aspect: number } {
  const size = options.size ?? 64;
  const font = `${options.weight ?? 700} ${size}px ${options.family ?? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"}`;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is not available");
  context.font = font;
  const padX = options.background ? size * 0.55 : size * 0.15;
  const padY = options.background ? size * 0.3 : size * 0.1;
  canvas.width = Math.ceil(context.measureText(text).width + padX * 2);
  canvas.height = Math.ceil(size * 1.25 + padY * 2);

  if (options.background) {
    const radius = canvas.height / 2;
    context.beginPath();
    context.roundRect(2, 2, canvas.width - 4, canvas.height - 4, radius - 2);
    context.fillStyle = options.background;
    context.fill();
    if (options.border) {
      context.lineWidth = 4;
      context.strokeStyle = options.border;
      context.stroke();
    }
  }
  context.font = font;
  context.fillStyle = options.color ?? "#ffffff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2 + size * 0.05);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: canvas.width / canvas.height };
}

/** A soft round glow, used for fireflies, stars, the sun and the moon. */
export function createRadialTexture(stops: [offset: number, color: string][], size = 128, draw?: (context: CanvasRenderingContext2D, size: number) => void): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is not available");
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  draw?.(context, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
