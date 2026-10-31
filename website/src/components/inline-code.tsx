import type { ReactElement, ReactNode } from "react";

export function InlineCode({ children }: { children: ReactNode }): ReactElement {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>
  );
}
