import { Box } from "lucide-react";
import type { ReactElement } from "react";
import { cx } from "@/lib/cx";

const SIZES = {
  sm: { box: "h-7 w-7 rounded-md", icon: "h-4 w-4" },
  md: { box: "h-8 w-8 rounded-lg", icon: "h-[18px] w-[18px]" },
  lg: { box: "h-12 w-12 rounded-xl", icon: "h-6 w-6" },
} as const;

export function LogoMark({ size = "md", className }: { size?: keyof typeof SIZES; className?: string }): ReactElement {
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center bg-gradient-to-br from-blue-500 to-red-600 text-white shadow-sm",
        SIZES[size].box,
        className,
      )}
    >
      <Box className={SIZES[size].icon} strokeWidth={2.25} />
    </span>
  );
}
