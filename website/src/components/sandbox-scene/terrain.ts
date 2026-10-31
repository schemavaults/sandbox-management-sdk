import {
  CatmullRomCurve3,
  Color,
  DataTexture,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createRadialTexture, hash2, smoothstep } from "./helpers";
import type { Palette } from "./palette";

/** Inner half-extents of the sandbox, in world units. */
export const INNER_X = 8;
export const INNER_Z = 4.5;
export const WATER_LEVEL = 0.62;
export const WALL_TOP = 1.32;
const WALL_BOTTOM = -0.3;
const WALL = 0.5;

interface Ellipse {
  x: number;
  z: number;
  rx: number;
  rz: number;
}

export const LAGOON: Ellipse = { x: 4.7, z: -1.75, rx: 3.0, rz: 2.0 };
export const POND: Ellipse = { x: -5.7, z: 2.3, rx: 1.5, rz: 1.05 };
export const CASTLE_SITE = { x: -4.7, z: -2.3 };

/** The channel a kid dug from the pond to the lagoon. */
export const RIVER = new CatmullRomCurve3(
  [
    [-5.7, 2.3],
    [-4.1, 1.55],
    [-2.5, 1.95],
    [-0.8, 1.15],
    [0.7, 0.15],
    [2.2, -0.75],
    [4.0, -1.5],
  ].map(([x = 0, z = 0]) => new Vector3(x, WATER_LEVEL, z)),
);
const RIVER_SAMPLES = RIVER.getSpacedPoints(180);

function distanceToRiver(x: number, z: number): number {
  let best = Infinity;
  for (const point of RIVER_SAMPLES) {
    const dx = point.x - x;
    const dz = point.z - z;
    best = Math.min(best, dx * dx + dz * dz);
  }
  return Math.sqrt(best);
}

const ellipseRadius = (x: number, z: number, e: Ellipse): number => Math.hypot((x - e.x) / e.rx, (z - e.z) / e.rz);

/** Height of the sand surface at (x, z). */
export function sandHeight(x: number, z: number): number {
  let height = 0.86 + 0.06 * Math.sin(x * 0.8 + z * 0.35) + 0.045 * Math.sin(z * 1.4 - x * 0.45 + 1.3) + 0.02 * Math.sin((x - z) * 2.3);
  // Sand piles up a little against the walls.
  const edge = Math.min(INNER_X - Math.abs(x), INNER_Z - Math.abs(z));
  height += 0.16 * (1 - smoothstep(0, 1.1, edge));
  // The mound the sandcastle sits on.
  const cx = x - CASTLE_SITE.x;
  const cz = z - CASTLE_SITE.z;
  height += 0.3 * Math.exp(-(cx * cx + cz * cz) / 2.2);

  const river = distanceToRiver(x, z);
  const lagoon = ellipseRadius(x, z, LAGOON);
  const pond = ellipseRadius(x, z, POND);
  // Dug-out sand heaped along the banks.
  height += 0.08 * Math.exp(-(((river - 0.95) / 0.28) ** 2)) * smoothstep(0.85, 1.25, lagoon) * smoothstep(0.85, 1.3, pond);

  const carve = Math.max(1 - smoothstep(0.3, 0.78, river), 1 - smoothstep(0.6, 1.0, lagoon), 1 - smoothstep(0.6, 1.0, pond));
  const bottom = 0.3 - 0.16 * (1 - smoothstep(0, 0.8, lagoon));
  return height + (bottom - height) * carve;
}

export const isUnderwater = (x: number, z: number): boolean => sandHeight(x, z) < WATER_LEVEL - 0.01;

const WATER_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uTime;
  uniform float uNight;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  varying vec2 vUv;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    float depth = texture2D(uDepth, vUv).r;
    vec3 color = mix(uShallow, uDeep, smoothstep(0.05, 0.75, depth));

    // Gentle moving ripples.
    float ripple = sin(vWorld.x * 3.1 + vWorld.z * 1.7 - uTime * 1.6) * sin(vWorld.z * 2.4 - vWorld.x * 0.9 + uTime * 1.2);
    color = mix(color, uFoam, smoothstep(0.6, 0.98, ripple) * 0.22);

    // Foam hugging the shore, plus a ring that keeps lapping outwards.
    float band = 0.09 + 0.03 * sin(uTime * 1.8 + vWorld.x * 2.0 + vWorld.z * 1.3);
    float foam = 1.0 - smoothstep(band * 0.55, band, depth);
    float lap = fract(uTime * 0.22);
    float ring = (1.0 - smoothstep(0.0, 0.025, abs(depth - (0.05 + lap * 0.22)))) * (1.0 - lap);
    color = mix(color, uFoam, clamp(foam + ring * 0.55, 0.0, 1.0));

    // Glowing plankton at night.
    vec2 cell = floor(vWorld.xz * 5.0);
    float seed = hash(cell);
    vec2 inCell = fract(vWorld.xz * 5.0) - 0.5 - (vec2(hash(cell + 7.0), hash(cell + 13.0)) - 0.5) * 0.6;
    float speck = 1.0 - smoothstep(0.03, 0.11, length(inCell));
    float twinkle = step(0.93, seed) * (0.5 + 0.5 * sin(uTime * 2.5 + seed * 60.0));
    color += vec3(0.35, 0.95, 1.0) * speck * twinkle * uNight * 1.4;

    gl_FragColor = vec4(color, mix(0.78, 0.94, smoothstep(0.0, 0.6, depth)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createDepthTexture(columns: number, rows: number): Texture {
  const data = new Uint8Array(columns * rows * 4);
  for (let row = 0; row < rows; row += 1) {
    // uv.y = 0 is the front (+z) edge of the plane once it is laid flat.
    const z = INNER_Z - (row / (rows - 1)) * INNER_Z * 2;
    for (let column = 0; column < columns; column += 1) {
      const x = -INNER_X + (column / (columns - 1)) * INNER_X * 2;
      const depth = Math.max(0, Math.min(1, (WATER_LEVEL - sandHeight(x, z)) / 0.45));
      const i = (row * columns + column) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(depth * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, columns, rows, RGBAFormat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createSand(): Mesh {
  const geometry = new PlaneGeometry(INNER_X * 2, INNER_Z * 2, 200, 112);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  if (!position) throw new Error("PlaneGeometry has no positions");
  const colors = new Float32Array(position.count * 3);
  const dry = new Color("#f3d59c");
  const dryShade = new Color("#e6c184");
  const wet = new Color("#c9a26a");
  const under = new Color("#b58e5b");
  const color = new Color();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const height = sandHeight(x, z);
    position.setY(i, height);
    const grain = hash2(x * 9.1, z * 8.7);
    color.copy(dry).lerp(dryShade, 0.25 + grain * 0.35 + 0.15 * Math.sin(x * 1.7 + z * 2.3));
    color.lerp(wet, (1 - smoothstep(WATER_LEVEL - 0.02, WATER_LEVEL + 0.17, height)) * 0.9);
    color.lerp(under, 1 - smoothstep(WATER_LEVEL - 0.25, WATER_LEVEL - 0.02, height));
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const sand = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  sand.receiveShadow = true;
  sand.castShadow = true;
  sand.name = "sand";
  return sand;
}

function createFrame(): Group {
  const frame = new Group();
  const boards = [new MeshStandardMaterial({ color: "#d99a5b", roughness: 0.78 }), new MeshStandardMaterial({ color: "#c98a4e", roughness: 0.78 })];
  const boardHeight = (WALL_TOP - WALL_BOTTOM) / 2 - 0.03;
  const long = new RoundedBoxGeometry(INNER_X * 2 + WALL * 2, boardHeight, WALL, 2, 0.09);
  const short = new RoundedBoxGeometry(WALL, boardHeight, INNER_Z * 2, 2, 0.09);
  for (let level = 0; level < 2; level += 1) {
    const y = WALL_BOTTOM + boardHeight / 2 + level * (boardHeight + 0.06);
    const material = boards[level] ?? boards[0];
    for (const side of [-1, 1]) {
      const fb = new Mesh(long, material);
      fb.position.set(0, y, side * (INNER_Z + WALL / 2));
      const lr = new Mesh(short, material);
      lr.position.set(side * (INNER_X + WALL / 2), y, 0);
      for (const board of [fb, lr]) {
        board.castShadow = true;
        board.receiveShadow = true;
        frame.add(board);
      }
    }
  }
  // Corner posts with bright playground caps.
  const post = new RoundedBoxGeometry(0.78, WALL_TOP - WALL_BOTTOM + 0.22, 0.78, 3, 0.14);
  const cap = new SphereGeometry(0.33, 24, 16);
  const postMaterial = new MeshStandardMaterial({ color: "#e0a868", roughness: 0.75 });
  const capColors = ["#f87171", "#60a5fa", "#fbbf24", "#34d399"];
  [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].forEach(([sx = 1, sz = 1], index) => {
    const x = sx * (INNER_X + WALL / 2);
    const z = sz * (INNER_Z + WALL / 2);
    const p = new Mesh(post, postMaterial);
    p.position.set(x, (WALL_TOP + WALL_BOTTOM + 0.22) / 2, z);
    const c = new Mesh(cap, new MeshStandardMaterial({ color: capColors[index], roughness: 0.4 }));
    c.position.set(x, WALL_TOP + 0.3, z);
    for (const mesh of [p, c]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      frame.add(mesh);
    }
  });
  return frame;
}

export interface Terrain {
  object: Group;
  sand: Mesh;
  update(time: number, night: number, palette: Palette): void;
}

export function createTerrain(): Terrain {
  const object = new Group();
  const sand = createSand();
  object.add(sand, createFrame());

  const uniforms = {
    uDepth: { value: createDepthTexture(160, 90) },
    uTime: { value: 0 },
    uNight: { value: 0 },
    uShallow: { value: new Color() },
    uDeep: { value: new Color() },
    uFoam: { value: new Color() },
  };
  const waterGeometry = new PlaneGeometry(INNER_X * 2, INNER_Z * 2);
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new Mesh(
    waterGeometry,
    new ShaderMaterial({ uniforms, vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT, transparent: true, depthWrite: false }),
  );
  water.position.y = WATER_LEVEL;
  water.renderOrder = 1;
  object.add(water);

  // A soft contact shadow so the sandbox sits on the page.
  const shadowMaterial = new MeshBasicMaterial({
    map: createRadialTexture([
      [0, "rgba(15, 23, 42, 0.55)"],
      [0.55, "rgba(15, 23, 42, 0.22)"],
      [1, "rgba(15, 23, 42, 0)"],
    ]),
    transparent: true,
    depthWrite: false,
  });
  const contact = new Mesh(new PlaneGeometry(INNER_X * 2 + 7, INNER_Z * 2 + 6), shadowMaterial);
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = WALL_BOTTOM - 0.02;
  object.add(contact);

  return {
    object,
    sand,
    update(time, night, palette) {
      uniforms.uTime.value = time;
      uniforms.uNight.value = night;
      uniforms.uShallow.value.copy(palette.waterShallow);
      uniforms.uDeep.value.copy(palette.waterDeep);
      uniforms.uFoam.value.copy(palette.waterFoam);
      shadowMaterial.opacity = palette.shadowOpacity / 0.28;
    },
  };
}
