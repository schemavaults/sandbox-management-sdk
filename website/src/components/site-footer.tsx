import { Separator } from "@/lib/ui";
import type { ReactElement } from "react";
import type { SdkPackageInfo } from "@/lib/sdk-package";
import { LICENSE_URL, NPM_URL, REPO_URL } from "@/lib/site";
import { Container } from "./container";
import { LogoMark } from "./logo-mark";

export function SiteFooter({ sdk }: { sdk: SdkPackageInfo }): ReactElement {
  return (
    <footer className="border-t border-border/60 py-10">
      <Container className="flex flex-col gap-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <LogoMark size="sm" />
          <span>
            <span className="font-mono text-foreground">{sdk.name}</span> v{sdk.version}
          </span>
        </div>
        <nav aria-label="Project links" className="flex h-5 items-center gap-4">
          <a href={REPO_URL} className="hover:text-foreground">
            GitHub
          </a>
          <Separator orientation="vertical" />
          <a href={NPM_URL} className="hover:text-foreground">
            npm
          </a>
          <Separator orientation="vertical" />
          <a href={LICENSE_URL} className="hover:text-foreground">
            {sdk.license} License
          </a>
        </nav>
      </Container>
    </footer>
  );
}
