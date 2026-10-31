import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  MeshStandardMaterial,
  Points,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
  type PerspectiveCamera,
} from "three";
import { createRadialTexture, part, randomBetween, smoothstep, type Kit } from "./helpers";
import type { Palette } from "./palette";
import { sandHeight } from "./terrain";
import type { FrameContext } from "./types";

const POINT_VERTEX = /* glsl */ `
  attribute float aPhase;
  attribute float aSize;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uDrift;
  varying float vTwinkle;
  void main() {
    vec3 p = position;
    p += uDrift * vec3(sin(uTime * 0.5 + aPhase) * 0.5, sin(uTime * 0.8 + aPhase * 1.7) * 0.25, cos(uTime * 0.4 + aPhase * 1.3) * 0.5);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (uDrift > 0.0 ? 28.0 / -mv.z : 1.0);
    vTwinkle = 0.45 + 0.55 * sin(uTime * (1.2 + fract(aPhase) * 2.5) + aPhase * 10.0);
  }
`;

const POINT_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vTwinkle;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float glow = 1.0 - smoothstep(0.0, 0.5, d);
    gl_FragColor = vec4(uColor, glow * glow * vTwinkle * uOpacity);
  }
`;

function createPoints(positions: number[], sizes: [number, number], color: string, drift: number): { points: Points; material: ShaderMaterial } {
  const count = positions.length / 3;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aPhase", new Float32BufferAttribute(Array.from({ length: count }, () => Math.random() * 100), 1));
  geometry.setAttribute("aSize", new Float32BufferAttribute(Array.from({ length: count }, () => randomBetween(...sizes)), 1));
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uDrift: { value: drift },
      uColor: { value: new Color(color) },
      uOpacity: { value: 0 },
    },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  return { points, material };
}

export interface Sky {
  object: Group;
  /** Places the backdrop (stars, sun, moon) for the current camera framing. */
  layout(camera: PerspectiveCamera, pixelRatio: number): void;
  update(context: FrameContext, palette: Palette, camera: PerspectiveCamera): void;
}

/** Points along the ray through a spot on screen (NDC), `distance` away from the camera. */
function onScreen(camera: PerspectiveCamera, x: number, y: number, distance: number, target: Vector3): Vector3 {
  return target.set(x, y, 0.5).unproject(camera).sub(camera.position).normalize().multiplyScalar(distance).add(camera.position);
}

export function createSky(kit: Kit): Sky {
  const object = new Group();

  const stars = createPoints(new Array(260 * 3).fill(0), [1.2, 3.2], "#ffffff", 0);
  object.add(stars.points);

  const fireflyPositions: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    const x = randomBetween(-7.4, 7.4);
    const z = randomBetween(-4, 4);
    fireflyPositions.push(x, sandHeight(x, z) + randomBetween(0.35, 1.6), z);
  }
  const fireflies = createPoints(fireflyPositions, [5, 9], "#fff2a0", 1);
  object.add(fireflies.points);

  const sun = new Sprite(
    new SpriteMaterial({
      map: createRadialTexture([
        [0, "#fffbe8"],
        [0.15, "#ffe08a"],
        [0.19, "rgba(255, 214, 120, 0.55)"],
        [0.45, "rgba(255, 200, 100, 0.12)"],
        [1, "rgba(255, 200, 100, 0)"],
      ], 256),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const moon = new Sprite(
    new SpriteMaterial({
      map: createRadialTexture(
        [
          [0, "rgba(210, 222, 255, 0.4)"],
          [0.5, "rgba(190, 205, 255, 0.08)"],
          [1, "rgba(190, 205, 255, 0)"],
        ],
        256,
        (context, size) => {
          const r = size * 0.17;
          context.fillStyle = "#eef2ff";
          context.beginPath();
          context.arc(size / 2, size / 2, r, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "rgba(165, 180, 230, 0.55)";
          for (const [dx, dy, cr] of [
            [-0.3, -0.25, 0.22],
            [0.35, 0.1, 0.16],
            [-0.05, 0.42, 0.12],
          ] as const) {
            context.beginPath();
            context.arc(size / 2 + dx * r, size / 2 + dy * r, cr * r, 0, Math.PI * 2);
            context.fill();
          }
        },
      ),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sun.renderOrder = moon.renderOrder = -1;
  object.add(sun, moon);

  const cloudMaterial = new MeshStandardMaterial({ color: "#ffffff", roughness: 1, emissive: "#ffffff", emissiveIntensity: 0.35, transparent: true });
  const puffs: [number, number, number, number][] = [
    [0, 0, 0, 1],
    [1.1, -0.18, 0.1, 0.75],
    [-1.05, -0.22, 0, 0.7],
    [0.45, 0.45, -0.1, 0.72],
    [-0.42, 0.36, 0.1, 0.6],
  ];
  const clouds = [
    { x: -0.55, y: 0.78, speed: 0.012, scale: 2.6 },
    { x: 0.35, y: 0.88, speed: 0.008, scale: 2.0 },
    { x: 1.0, y: 0.72, speed: 0.01, scale: 2.3 },
  ].map((cloud) => {
    const group = new Group();
    for (const [x, y, z, r] of puffs) {
      const puff = part(kit.sphere, cloudMaterial, [x, y, z], [r, r * 0.82, r]);
      puff.castShadow = puff.receiveShadow = false;
      group.add(puff);
    }
    group.scale.setScalar(cloud.scale);
    object.add(group);
    return { ...cloud, group };
  });

  const sunBase = new Vector3();
  const moonBase = new Vector3();
  const up = new Vector3();
  const scratch = new Vector3();

  return {
    object,
    layout(camera, pixelRatio) {
      camera.updateMatrixWorld();
      const positions = stars.points.geometry.attributes.position;
      if (positions) {
        for (let i = 0; i < positions.count; i += 1) {
          // Denser towards the top of the frame.
          onScreen(camera, randomBetween(-1.15, 1.15), 1.15 - Math.random() ** 1.5 * 2.3, 110, scratch);
          positions.setXYZ(i, scratch.x, scratch.y, scratch.z);
        }
        positions.needsUpdate = true;
      }
      onScreen(camera, 0.74, 0.68, 80, sunBase);
      onScreen(camera, -0.74, 0.7, 80, moonBase);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      stars.material.uniforms.uPixelRatio!.value = pixelRatio;
      fireflies.material.uniforms.uPixelRatio!.value = pixelRatio;
    },
    update({ time, night }, palette, camera) {
      stars.material.uniforms.uTime!.value = time;
      stars.material.uniforms.uOpacity!.value = smoothstep(0.3, 1, night) * 0.9;
      fireflies.material.uniforms.uTime!.value = time;
      fireflies.material.uniforms.uOpacity!.value = smoothstep(0.4, 1, night) * 1.6;
      fireflies.points.visible = night > 0.4;

      // The sun sets as the moon rises.
      sun.position.copy(sunBase).addScaledVector(up, -night * 9);
      sun.scale.setScalar(16);
      sun.material.opacity = 1 - smoothstep(0.2, 0.8, night);
      sun.visible = night < 0.95;
      moon.position.copy(moonBase).addScaledVector(up, -(1 - night) * 9);
      moon.scale.setScalar(13);
      moon.material.opacity = smoothstep(0.2, 0.8, night);
      moon.visible = night > 0.05;

      cloudMaterial.color.copy(palette.cloud);
      cloudMaterial.emissive.copy(palette.cloud);
      cloudMaterial.opacity = palette.cloudOpacity;
      for (const cloud of clouds) {
        const x = ((((cloud.x + time * cloud.speed + 1.4) % 2.8) + 2.8) % 2.8) - 1.4;
        onScreen(camera, x, cloud.y, 70, cloud.group.position);
        cloud.group.quaternion.copy(camera.quaternion);
      }
    },
  };
}
