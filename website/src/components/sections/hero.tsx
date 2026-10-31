import { Badge, Button, Snippet, Wordmark } from "@/lib/ui";
import { ArrowRight, Container as ContainerIcon, Database, Github, Puzzle, Triangle } from "lucide-react";
import type { ReactElement } from "react";
import { Code } from "@/components/code";
import { Container } from "@/components/container";
import { SandboxScene } from "@/components/sandbox-scene/sandbox-scene";
import { heroSnippet } from "@/content/snippets";
import type { SdkPackageInfo } from "@/lib/sdk-package";
import { NPM_URL, PACKAGE_NAME, REPO_URL } from "@/lib/site";

const BACKENDS = [
  { label: "Docker", icon: ContainerIcon },
  { label: "Vercel Sandbox", icon: Triangle },
  { label: "Postgres via Kysely / dbh", icon: Database },
  { label: "Your own provider", icon: Puzzle },
] as const;

/** ">=24" reads better as "24+" in a sentence. */
function formatNodeEngine(range: string | undefined): string {
  if (!range) return "24+";
  const match = /^>=\s*(\d+(?:\.\d+)*)$/.exec(range.trim());
  return match ? `${match[1]}+` : range;
}

export function Hero({ sdk }: { sdk: SdkPackageInfo }): ReactElement {
  return (
    <section id="top" className="relative isolate overflow-hidden">
      <div aria-hidden className="hero-grid pointer-events-none absolute inset-0 -z-10" />
      <div aria-hidden className="hero-glow pointer-events-none absolute -top-48 left-1/2 -z-10 h-[32rem] w-[64rem] -translate-x-1/2 rounded-full blur-3xl" />

      <Container className="grid items-center gap-12 pb-12 pt-14 sm:pb-16 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:pt-24">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge asChild variant="outline" className="bg-background/60 font-mono">
              <a href={NPM_URL}>v{sdk.version}</a>
            </Badge>
            <Badge variant="secondary">{sdk.license} licensed</Badge>
            <Badge variant="secondary">TypeScript</Badge>
          </div>

          <h1 className="mt-6 text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            One API for{" "}
            <Wordmark
              wordmarkText="every sandbox"
              gradientColors={["var(--hero-gradient-from)", "var(--hero-gradient-to)"]}
            />
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
            Create, set up, start, stop, resume, list and destroy sandboxes on Docker or Vercel Sandbox through a
            single TypeScript SDK, while the sandbox state lives in your app&apos;s own database.
          </p>

          <Snippet className="mt-8 max-w-xl" variant="brand" size="lg" value={`bun add ${PACKAGE_NAME}`} />

          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="#quick-start">
                Get started
                <ArrowRight className="ml-1 h-4 w-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="bg-background/60">
              <a href={REPO_URL}>
                <Github className="mr-1 h-4 w-4" />
                View on GitHub
              </a>
            </Button>
          </div>

          <p className="mt-8 text-sm text-muted-foreground">
            Runs on Node.js {formatNodeEngine(sdk.nodeEngine)} and Bun. The core, the Vercel adapter and the dbh store also
            run in serverless functions.
          </p>
        </div>

        <div className="relative min-w-0">
          <div aria-hidden className="hero-code-glow absolute -inset-6 -z-10 rounded-[2rem] blur-2xl" />
          <Code code={heroSnippet} title="app.ts" className="bg-card shadow-2xl shadow-black/5" />
        </div>
      </Container>

      <Container className="pb-8 sm:pb-10">
        <SandboxScene />
      </Container>

      <Container className="pb-16 sm:pb-20">
        <ul aria-label="Supported backends" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
          <li className="font-medium text-foreground">Works with</li>
          {BACKENDS.map(({ label, icon: Icon }) => (
            <li key={label} className="flex items-center gap-2">
              <Icon aria-hidden className="h-4 w-4" />
              {label}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
