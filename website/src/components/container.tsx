import { cx } from "@/lib/cx";
import type { HTMLAttributes, ReactElement } from "react";

export function Container({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cx("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8", className)} {...props} />;
}
