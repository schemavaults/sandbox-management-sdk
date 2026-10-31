"use client";

import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { InlineCode } from "@/components/inline-code";
import { cx } from "@/lib/cx";
import { Button } from "@/lib/ui";
import type { CrateLink } from "./crate-link";
import { createSandboxScene, type SandboxSceneController } from "./engine";
import { SANDBOX_SCENE_FRAME, SandboxSceneSkeleton } from "./sandbox-scene-skeleton";

const DESCRIPTION =
  "Illustration: a wooden toy sandbox with a river dug through the sand. A whale carries a stack of containers around the lagoon, " +
  "a rubber duck paddles down the river, a crab carries a container along the beach, and the sandcastle's keep is a little server rack. " +
  "Small sandbox crates with faces wake up, run, fall asleep and resume.";

type Status = "loading" | "ready" | "failed";

/**
 * A theme-aware Three.js diorama of a kid's sandbox. This module imports
 * Three.js, so render it through `LazySandboxScene`, which loads it with
 * next/dynamic and shows the skeleton in the meantime. The skeleton stays on
 * top here until the first frame is drawn, then fades out as the scene fades in.
 */
export interface SandboxSceneProps {
  /** Links the crates the visitor creates to real sandboxes, e.g. the hero's agent demo. */
  link?: CrateLink;
}

export function SandboxScene({ link }: SandboxSceneProps): ReactElement {
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SandboxSceneController | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let cancelled = false;
    const root = document.documentElement;
    const isDark = (): boolean => root.classList.contains("dark");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(motion.matches);

    try {
      controllerRef.current = createSandboxScene({
        stage,
        backdrop: backdropRef.current ?? undefined,
        dark: isDark(),
        reducedMotion: motion.matches,
        link,
        onReady: () => {
          if (!cancelled) setStatus("ready");
        },
      });
    } catch {
      // No WebGL: the sky backdrop stays on its own.
      setStatus("failed");
    }

    const themeObserver = new MutationObserver(() => controllerRef.current?.setDark(isDark()));
    themeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
    const onMotionChange = (): void => {
      setReducedMotion(motion.matches);
      controllerRef.current?.setReducedMotion(motion.matches);
    };
    motion.addEventListener("change", onMotionChange);

    return () => {
      cancelled = true;
      themeObserver.disconnect();
      motion.removeEventListener("change", onMotionChange);
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
    // The scene is built once per mount; `link` is a module-level singleton.
  }, []);

  useEffect(() => {
    controllerRef.current?.setPaused(paused);
  }, [paused]);

  const ready = status === "ready";
  const interactive = ready && !reducedMotion;

  return (
    <div ref={backdropRef} className={SANDBOX_SCENE_FRAME}>
      <div
        ref={stageRef}
        role="img"
        aria-label={DESCRIPTION}
        className={cx("absolute inset-0 transition-opacity duration-700", ready ? "opacity-100" : "opacity-0")}
      />
      {/* Once the scene is up, the skeleton fades out and its pulse stops where it is. */}
      <SandboxSceneSkeleton
        className={cx(
          "transition-opacity duration-700",
          status === "loading" ? "opacity-100" : "opacity-0 [&_*]:[animation-play-state:paused]",
        )}
      />
      {interactive ? (
        <>
          <p className="pointer-events-none absolute bottom-3 left-3 right-16 hidden text-xs text-slate-700 sm:block dark:text-slate-300">
            <span className="rounded-full bg-background/70 px-3 py-1.5 backdrop-blur-sm">
              Click the sand to <InlineCode>create()</InlineCode> a sandbox with an agent, or click one to{" "}
              <InlineCode>stop()</InlineCode> or <InlineCode>resume()</InlineCode> it.
            </span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-pressed={paused}
            aria-label={paused ? "Play the sandbox animation" : "Pause the sandbox animation"}
            onClick={() => setPaused((value) => !value)}
            className="absolute bottom-3 right-3 h-9 w-9 rounded-full bg-background/70 backdrop-blur-sm"
          >
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </Button>
        </>
      ) : null}
    </div>
  );
}
