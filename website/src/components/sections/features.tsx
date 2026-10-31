import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/lib/ui";
import {
  Cloud,
  Database,
  FlaskConical,
  History,
  type LucideIcon,
  Plug,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Zap,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";

interface Feature {
  title: string;
  icon: LucideIcon;
  body: ReactNode;
}

const FEATURES: Feature[] = [
  {
    title: "One lifecycle everywhere",
    icon: RefreshCw,
    body: (
      <>
        <InlineCode>create</InlineCode> clones an optional git repo, runs <InlineCode>setup</InlineCode> once and
        launches <InlineCode>start</InlineCode> as the long-running main process. <InlineCode>stop</InlineCode> keeps
        the filesystem.
      </>
    ),
  },
  {
    title: "Auto-resume",
    icon: Zap,
    body: (
      <>
        Touch a stopped sandbox with <InlineCode>exec</InlineCode>, <InlineCode>getUrl</InlineCode>,{" "}
        <InlineCode>readFile</InlineCode> or <InlineCode>logs</InlineCode> and it wakes up and runs{" "}
        <InlineCode>resume</InlineCode> first, even if the provider stopped it on its own.
      </>
    ),
  },
  {
    title: "State in your database",
    icon: Database,
    body: (
      <>
        Records go through a <InlineCode>SandboxStore</InlineCode>. An in-memory store, a Kysely /{" "}
        <InlineCode>@schemavaults/dbh</InlineCode> Postgres store with a migration, and a browser{" "}
        <InlineCode>localStorage</InlineCode> store ship in the box.
      </>
    ),
  },
  {
    title: "Safe under concurrency",
    icon: ShieldCheck,
    body: (
      <>
        Every status change is a compare-and-set on a version column. When many requests hit a stopped sandbox at
        once, exactly one resumes it and the others wait for it.
      </>
    ),
  },
  {
    title: "Pluggable providers",
    icon: Plug,
    body: (
      <>
        Docker and Vercel Sandbox adapters are included. Implement <InlineCode>SandboxProvider</InlineCode> for any
        other backend; shell helpers cover the main-process bookkeeping.
      </>
    ),
  },
  {
    title: "Runs where your app runs",
    icon: Cloud,
    body: (
      <>
        Node.js 24+ and Bun. The core, the Vercel adapter and the dbh Postgres store also run in serverless
        functions, and the core and the Web Storage store run in browsers.
      </>
    ),
  },
  {
    title: "Exec, files and logs",
    icon: SquareTerminal,
    body: (
      <>
        <InlineCode>exec</InlineCode> returns the exit code, stdout and stderr. Read and write files, and read or
        follow main-process logs that survive restarts.
      </>
    ),
  },
  {
    title: "Self-healing records",
    icon: History,
    body: (
      <>
        <InlineCode>reconcile()</InlineCode> syncs records with what the providers report and settles transitions a
        crashed process left behind.
      </>
    ),
  },
  {
    title: "Built for tests",
    icon: FlaskConical,
    body: (
      <>
        <InlineCode>MockSandboxProvider</InlineCode> records every call, keeps files in memory and simulates stops,
        wakes and provider-side timeouts. No Docker required.
      </>
    ),
  },
];

export function Features(): ReactElement {
  return (
    <Section
      id="features"
      eyebrow="Features"
      title="Everything a sandbox needs, behind one interface"
      description="Write your sandbox logic once. Swap Docker for Vercel Sandbox, or run both side by side, without touching the code that drives them."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ title, icon: Icon, body }) => (
          <Card key={title} className="group relative overflow-hidden transition-colors hover:border-foreground/20">
            <CardHeader className="pb-3">
              <span className="feature-icon mb-3 grid h-10 w-10 place-items-center rounded-lg border border-border/80 bg-background">
                <Icon aria-hidden className="h-5 w-5" />
              </span>
              <CardTitle className="text-lg">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-[0.9375rem] leading-relaxed">{body}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}
