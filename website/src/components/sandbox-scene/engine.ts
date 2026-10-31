import {
  DirectionalLight,
  HemisphereLight,
  Mesh,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PointLight,
  Points,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Sprite,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Intersection,
  type Material,
  type Object3D,
} from "three";
import type { CrateLink } from "./crate-link";
import { Crates } from "./crates";
import { FloatingText, Particles, type Effects } from "./effects";
import { Kit, damp } from "./helpers";
import { createPalette, mixPalette } from "./palette";
import { createSky } from "./sky";
import { WATER_LEVEL, createTerrain, isUnderwater } from "./terrain";
import {
  createBeachBall,
  createBeachDecor,
  createBucketAndShovel,
  createCastle,
  createCrab,
  createDuck,
  createPinwheel,
  createSandMolds,
  createSeagull,
  createWhale,
} from "./toys";
import type { FrameContext, Toy } from "./types";

export interface SandboxSceneOptions {
  /** Element the canvas is appended to; it is sized to fill it. */
  stage: HTMLElement;
  /** Element whose `--night` custom property follows the theme transition (for the CSS sky). */
  backdrop?: HTMLElement;
  dark: boolean;
  reducedMotion: boolean;
  /** Links the crates you create to real sandboxes (see `crate-link.ts`). */
  link?: CrateLink;
  onReady?: () => void;
}

export interface SandboxSceneController {
  setDark(dark: boolean): void;
  setPaused(paused: boolean): void;
  setReducedMotion(reducedMotion: boolean): void;
  dispose(): void;
}

const TARGET = new Vector3(0, 0.7, 0.2);
const ELEVATION = 0.6;
/** Points that must stay in frame: the sandbox corners and the castle flag. */
const FRAME_POINTS = [
  ...[-8.8, 8.8].flatMap((x) => [-0.35, 1.9].flatMap((y) => [-5.25, 5.25].map((z) => new Vector3(x, y, z)))),
  new Vector3(-4.7, 3.2, -2.3),
];
const SPLASH = ["#ffffff", "#bfe9ff", "#8fd3ff"];
const SAND_PUFF = ["#f3d59c", "#e6c184", "#fbe7bf"];

export function createSandboxScene(options: SandboxSceneOptions): SandboxSceneController {
  const { stage, backdrop } = options;
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "manipulation" });
  stage.appendChild(canvas);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.5, 400);
  const kit = new Kit();
  const fx: Effects = { particles: new Particles(), text: new FloatingText() };
  const palette = createPalette();
  const terrain = createTerrain();
  const crates = new Crates(kit);
  crates.quiet = options.reducedMotion;
  crates.setLink(options.link ?? null);
  crates.addAuto(-0.95, 3.05, "running", 2);
  crates.addAuto(0.05, 3.3, "stopped", 1);
  crates.addAuto(1.0, 3.0, "running", 5.5);
  const toys: Toy[] = [
    createCastle(kit),
    createWhale(kit),
    createDuck(kit),
    createCrab(kit),
    createBucketAndShovel(kit),
    createBeachBall(),
    createSandMolds(kit),
    createPinwheel(kit),
    createBeachDecor(kit),
    createSeagull(kit),
    crates,
  ];
  const sky = createSky(kit);
  scene.add(terrain.object, sky.object, fx.particles.mesh, fx.text.group, ...toys.map((toy) => toy.object));

  const hemi = new HemisphereLight();
  const key = new DirectionalLight();
  key.castShadow = true;
  // Phones get a smaller shadow map.
  const shadowSize = stage.clientWidth < 640 ? 1024 : 2048;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(key.shadow.camera, { left: -11, right: 11, top: 9, bottom: -9, near: 1, far: 70 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  // Night-time glows: lantern light spilling from the castle windows, and the lagoon's plankton.
  const lantern = new PointLight("#ffb35c", 0, 8, 1.3);
  lantern.position.set(-4.0, 2.7, 0.3);
  const plankton = new PointLight("#5eead4", 0, 6, 1.2);
  plankton.position.set(4.7, 2.6, -2.6);
  scene.add(hemi, key, key.target, lantern, plankton);

  let night = options.dark ? 1 : 0;
  let nightTarget = night;
  let reducedMotion = options.reducedMotion;
  let paused = false;
  let onScreen = true;
  let disposed = false;
  let time = 0;
  let last = 0;
  let frame = 0;
  let distance = 30;
  let lastNightShown = -1;
  const sway = { azimuth: 0, elevation: 0 };
  const pointer = { x: 0, y: 0, inside: false, hoverDirty: false, downX: 0, downY: 0 };
  const context: FrameContext = { time: 0, dt: 0, night, fx };

  const applyTheme = (): void => {
    mixPalette(palette, night);
    hemi.color.copy(palette.hemiSky);
    hemi.groundColor.copy(palette.hemiGround);
    hemi.intensity = palette.hemiIntensity;
    key.color.copy(palette.keyColor);
    key.intensity = palette.keyIntensity;
    key.position.copy(TARGET).addScaledVector(palette.keyDirection, 30);
    key.target.position.copy(TARGET);
    lantern.intensity = night * 8;
    plankton.intensity = night * 4;
    if (backdrop && Math.abs(night - lastNightShown) > 0.002) {
      lastNightShown = night;
      backdrop.style.setProperty("--night", night.toFixed(3));
    }
  };

  const placeCamera = (azimuth: number, elevation: number, d: number): void => {
    camera.position.set(
      TARGET.x + Math.sin(azimuth) * Math.cos(elevation) * d,
      TARGET.y + Math.sin(elevation) * d,
      TARGET.z + Math.cos(azimuth) * Math.cos(elevation) * d,
    );
    camera.lookAt(TARGET);
    camera.updateMatrixWorld();
  };

  /** Finds the closest camera distance that keeps the whole sandbox in frame for this aspect ratio. */
  const fitCamera = (): void => {
    const projected = new Vector3();
    const fits = (d: number): boolean => {
      placeCamera(0, ELEVATION, d);
      return FRAME_POINTS.every((point) => {
        projected.copy(point).project(camera);
        return Math.abs(projected.x) <= 0.96 && projected.y <= 0.62 && projected.y >= -0.94;
      });
    };
    let lo = 8;
    let hi = 160;
    for (let i = 0; i < 26; i += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    distance = hi;
  };

  const step = (dt: number): void => {
    time += dt;
    context.time = time;
    context.dt = dt;
    night = dt > 0 ? night + (nightTarget - night) * damp(2.6, dt) : nightTarget;
    if (Math.abs(nightTarget - night) < 0.002) night = nightTarget;
    context.night = night;
    applyTheme();

    const idle = Math.sin(time * 0.12) * 0.07;
    const azimuth = idle + (pointer.inside ? pointer.x * 0.09 : 0);
    const elevation = pointer.inside ? pointer.y * 0.035 : 0;
    const k = dt > 0 ? damp(2.2, dt) : 1;
    sway.azimuth += (azimuth - sway.azimuth) * k;
    sway.elevation += (elevation - sway.elevation) * k;
    placeCamera(sway.azimuth, ELEVATION + sway.elevation, distance);

    terrain.update(time, night, palette);
    for (const toy of toys) toy.update(context);
    fx.particles.update(dt);
    fx.text.update(dt);
    sky.update(context, palette, camera);
  };

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const pick = (): { toy: Toy | undefined; hit: Intersection } | null => {
    raycaster.setFromCamera(ndc, camera);
    const owners = new Map<Object3D, Toy>();
    for (const toy of toys) for (const target of toy.targets ?? []) owners.set(target, toy);
    const [hit] = raycaster.intersectObjects([...owners.keys(), terrain.sand], false);
    return hit ? { toy: owners.get(hit.object), hit } : null;
  };

  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    step(dt);
    if (pointer.hoverDirty) {
      pointer.hoverDirty = false;
      canvas.style.cursor = pick() ? "pointer" : "";
    }
    renderer.render(scene, camera);
  };

  const interactive = (): boolean => !paused && !reducedMotion;

  const sync = (): void => {
    if (disposed) return;
    const run = interactive() && onScreen && document.visibilityState === "visible";
    if (run && !frame) {
      last = 0;
      frame = requestAnimationFrame(loop);
    } else if (!run && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  /** Draws one frame without advancing the animation (paused, reduced motion, resize). */
  const renderStill = (): void => {
    if (frame || disposed) return;
    // With reduced motion nothing else moves the crates along, so jump them to where they are heading.
    if (reducedMotion) crates.settle();
    step(0);
    renderer.render(scene, camera);
  };

  const resize = (): void => {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    fitCamera();
    placeCamera(sway.azimuth, ELEVATION + sway.elevation, distance);
    sky.layout(camera, pixelRatio);
    renderStill();
  };

  const toNdc = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  };

  const onPointerMove = (event: PointerEvent): void => {
    toNdc(event);
    pointer.x = ndc.x;
    pointer.y = ndc.y;
    pointer.inside = event.pointerType === "mouse";
    pointer.hoverDirty = interactive();
  };
  const onPointerLeave = (): void => {
    pointer.inside = false;
    canvas.style.cursor = "";
  };
  const onPointerDown = (event: PointerEvent): void => {
    pointer.downX = event.clientX;
    pointer.downY = event.clientY;
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!interactive() || Math.hypot(event.clientX - pointer.downX, event.clientY - pointer.downY) > 8) return;
    toNdc(event);
    const picked = pick();
    if (!picked) return;
    if (picked.toy) {
      picked.toy.onClick?.(context, picked.hit);
      return;
    }
    const { x, z } = picked.hit.point;
    if (isUnderwater(x, z)) {
      fx.particles.burst(new Vector3(x, WATER_LEVEL, z), { count: 14, colors: SPLASH, speed: [0.5, 1.3], up: [1.4, 2.6], size: [0.04, 0.08], life: [0.5, 0.9], floor: WATER_LEVEL - 0.05 });
    } else if (crates.canPlace(x, z)) {
      crates.spawn(context, x, z);
    } else {
      fx.particles.burst(picked.hit.point, { count: 8, colors: SAND_PUFF, speed: [0.4, 1], up: [0.8, 1.6], size: [0.03, 0.06], life: [0.4, 0.7] });
    }
  };

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  document.addEventListener("visibilitychange", sync);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  const intersectionObserver = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    sync();
  });
  intersectionObserver.observe(stage);

  const detachLink = options.link?.attach({
    setTarget(crateId, target) {
      crates.setTarget(crateId, target);
      renderStill();
    },
    spawn() {
      const crate = crates.spawnForLink(context);
      renderStill();
      return crate;
    },
    unlinkAll() {
      crates.unlinkAll();
      renderStill();
    },
  });

  resize();
  renderStill();
  sync();
  requestAnimationFrame(() => options.onReady?.());

  return {
    setDark(dark) {
      nightTarget = dark ? 1 : 0;
      renderStill();
    },
    setPaused(value) {
      paused = value;
      if (paused) canvas.style.cursor = "";
      sync();
    },
    setReducedMotion(value) {
      reducedMotion = value;
      crates.quiet = value;
      sync();
      renderStill();
    },
    dispose() {
      disposed = true;
      detachLink?.();
      crates.setLink(null);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", sync);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      fx.text.dispose();

      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      scene.traverse((object) => {
        if (object instanceof Mesh || object instanceof Points || object instanceof Sprite) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) {
        for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
        if ("uniforms" in material) {
          for (const uniform of Object.values((material as { uniforms: Record<string, { value: unknown }> }).uniforms)) {
            if (uniform.value instanceof Texture) uniform.value.dispose();
          }
        }
        material.dispose();
      }
      fx.particles.mesh.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
