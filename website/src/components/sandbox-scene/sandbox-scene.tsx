"use client";

import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { InlineCode } from "@/components/inline-code";
import { cx } from "@/lib/cx";
import { Button } from "@/lib/ui";
import type { SandboxSceneController } from "./engine";

const DESCRIPTION =
  "Illustration: a wooden toy sandbox with a river dug through the sand. A whale carries a stack of containers around the lagoon, " +
  "a rubber duck paddles down the river, a crab carries a container along the beach, and the sandcastle's keep is a little server rack. " +
  "Small sandbox crates with faces wake up, run, fall asleep and resume.";

/**
 * A theme-aware Three.js diorama of a kid's sandbox. Three.js and the scene
 * load after hydration, so they stay out of the page's initial JavaScript.
 */
export function SandboxScene({ className }: { className?: string }): ReactElement {
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SandboxSceneController | null>(null);
  const [ready, setReady] = useState(false);
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

    import("./engine")
      .then(({ createSandboxScene }) => {
        if (cancelled) return;
        controllerRef.current = createSandboxScene({
          stage,
          backdrop: backdropRef.current ?? undefined,
          dark: isDark(),
          reducedMotion: motion.matches,
          onReady: () => setReady(true),
        });
      })
      .catch(() => {
        // No WebGL (or the chunk failed to load): the sky backdrop stays on its own.
      });

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
  }, []);

  useEffect(() => {
    controllerRef.current?.setPaused(paused);
  }, [paused]);

  const interactive = ready && !reducedMotion;

  return (
    <div
      ref={backdropRef}
      className={cx(
        "sandbox-sky relative isolate aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border/70 shadow-sm sm:aspect-[2/1] lg:aspect-[16/7]",
        className,
      )}
    >
      <div
        ref={stageRef}
        role="img"
        aria-label={DESCRIPTION}
        className={cx("absolute inset-0 transition-opacity duration-700", ready ? "opacity-100" : "opacity-0")}
      />
      {interactive ? (
        <>
          <p className="pointer-events-none absolute bottom-3 left-3 right-16 hidden text-xs text-slate-700 sm:block dark:text-slate-300">
            <span className="rounded-full bg-background/70 px-3 py-1.5 backdrop-blur-sm">
              Click the sand to <InlineCode>create()</InlineCode> a sandbox, or click one to <InlineCode>stop()</InlineCode> or{" "}
              <InlineCode>resume()</InlineCode> it.
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
