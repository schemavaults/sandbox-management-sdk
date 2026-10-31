"use client";

import dynamic from "next/dynamic";
import type { ReactElement } from "react";
import { SANDBOX_SCENE_FRAME, SandboxSceneLoading } from "./sandbox-scene-skeleton";

/** The empty sky, for when the scene's chunk fails to load. */
function SandboxSceneUnavailable(): ReactElement {
  return <div aria-hidden className={SANDBOX_SCENE_FRAME} />;
}

/**
 * The hero's sandbox scene, loaded with next/dynamic. The scene and Three.js
 * are one separate chunk that the browser fetches after hydration, so they
 * stay out of the page's initial JavaScript. Until it arrives, a skeleton the
 * same size holds the scene's place; it is also what the static HTML contains.
 * `ssr: false` needs a Client Component, which is why this file exists.
 */
export const LazySandboxScene = dynamic(
  () =>
    import("./sandbox-scene").then(
      (mod) => mod.SandboxScene,
      // Resolving to a fallback keeps a failed chunk from surfacing as an error.
      () => SandboxSceneUnavailable,
    ),
  { ssr: false, loading: () => <SandboxSceneLoading /> },
);
