import { Button, ThemeSelector } from "@/lib/ui";
import { Github } from "lucide-react";
import type { ReactElement } from "react";
import { NAV_LINKS, REPO_URL } from "@/lib/site";
import { Container } from "./container";
import { LogoMark } from "./logo-mark";

export function SiteHeader(): ReactElement {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <Container className="flex h-16 items-center gap-6">
        <a href="#top" className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <LogoMark />
          <span className="truncate font-mono text-sm font-semibold tracking-tight sm:text-[15px]">
            sandbox-management-sdk
          </span>
        </a>
        <nav aria-label="Page sections" className="hidden flex-1 items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button asChild variant="ghost" size="icon">
            <a href={REPO_URL} aria-label="GitHub repository">
              <Github className="h-5 w-5" />
            </a>
          </Button>
          <ThemeSelector variant="compact" />
        </div>
      </Container>
    </header>
  );
}
