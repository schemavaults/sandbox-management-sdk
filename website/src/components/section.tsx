import { cx } from "@/lib/cx";
import type { ReactElement, ReactNode } from "react";
import { Container } from "./container";

export interface SectionProps {
  id: string;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ id, eyebrow, title, description, children, className }: SectionProps): ReactElement {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cx("scroll-mt-16 border-t border-border/60 py-20 sm:py-24", className)}
    >
      <Container>
        <div className="max-w-3xl">
          <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <span aria-hidden className="h-1.5 w-6 rounded-full bg-gradient-to-r from-schemavaults-brand-blue to-schemavaults-brand-red" />
            {eyebrow}
          </p>
          <h2 id={`${id}-title`} className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            {title}
          </h2>
          {description ? (
            <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="mt-12">{children}</div>
      </Container>
    </section>
  );
}
