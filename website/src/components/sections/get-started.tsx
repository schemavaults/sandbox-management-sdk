import { Button, Snippet } from "@/lib/ui";
import { BookOpen, Github, Package } from "lucide-react";
import type { ReactElement } from "react";
import { Container } from "@/components/container";
import { NPM_URL, PACKAGE_NAME, README_URL, REPO_URL } from "@/lib/site";

export function GetStarted(): ReactElement {
  return (
    <section aria-labelledby="get-started-title" className="border-t border-border/60 py-20 sm:py-24">
      <Container>
        <div className="cta-panel relative isolate overflow-hidden rounded-2xl border border-border px-6 py-12 text-center sm:px-12 sm:py-16">
          <h2 id="get-started-title" className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Spin up your first sandbox
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-lg text-muted-foreground">
            Install the SDK, register a provider and a store, and call <code className="font-mono">create</code>.
          </p>
          <Snippet className="mx-auto mt-8 max-w-lg text-left" value={`bun add ${PACKAGE_NAME}`} />
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <a href={REPO_URL}>
                <Github className="mr-1 h-4 w-4" />
                GitHub
              </a>
            </Button>
            <Button asChild variant="outline" className="bg-background/60">
              <a href={NPM_URL}>
                <Package className="mr-1 h-4 w-4" />
                npm
              </a>
            </Button>
            <Button asChild variant="outline" className="bg-background/60">
              <a href={README_URL}>
                <BookOpen className="mr-1 h-4 w-4" />
                Read the README
              </a>
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}
