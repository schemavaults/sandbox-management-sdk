import type { HTMLAttributes, ReactElement } from "react";
import { cx } from "@/lib/cx";
import { Skeleton } from "@/lib/ui";

/**
 * The scene's frame: the CSS sky at a fixed aspect ratio per breakpoint. The
 * skeleton and the scene share it, so the scene loads without a layout shift.
 */
export const SANDBOX_SCENE_FRAME =
  "sandbox-sky relative isolate aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border/70 shadow-sm sm:aspect-[2/1] lg:aspect-[16/7]";

/** Placeholders read as faint shapes against the sky in both themes. */
const SHAPE = "bg-white/55 motion-reduce:animate-none dark:bg-white/10";

/**
 * Placeholders for the sandbox and the scene's controls, laid over the sky.
 * The camera fits the sandbox to the frame's width, so the box placeholder is
 * sized by width and keeps its proportions at every aspect ratio. The control
 * placeholders show only where the controls will: never with reduced motion,
 * and the hint only from the `sm` breakpoint up.
 */
export function SandboxSceneSkeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div aria-hidden className={cx("pointer-events-none absolute inset-0", className)} {...props}>
      <div className="absolute left-1/2 top-[54%] aspect-[20/7] w-[86%] -translate-x-1/2 -translate-y-1/2">
        {/* The sand, seen from above: narrower at the back. */}
        <Skeleton
          className={cx(SHAPE, "absolute inset-x-0 top-0 h-[72%] rounded-none [clip-path:polygon(18%_0,82%_0,100%_100%,0_100%)]")}
        />
        {/* The front boards. */}
        <Skeleton className={cx(SHAPE, "absolute inset-x-0 bottom-0 h-1/4 rounded-lg")} />
      </div>
      <Skeleton
        className={cx(SHAPE, "absolute bottom-3 left-3 hidden h-7 w-[min(32rem,calc(100%-5rem))] rounded-full sm:motion-safe:block")}
      />
      <Skeleton className={cx(SHAPE, "absolute bottom-3 right-3 h-9 w-9 rounded-full motion-reduce:hidden")} />
    </div>
  );
}

/** What next/dynamic renders, and the static export prerenders, until the scene's chunk arrives. */
export function SandboxSceneLoading(): ReactElement {
  return (
    <div className={SANDBOX_SCENE_FRAME}>
      <SandboxSceneSkeleton />
    </div>
  );
}
