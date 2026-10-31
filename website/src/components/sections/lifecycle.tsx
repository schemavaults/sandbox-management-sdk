import { Card, CardContent } from "@/lib/ui";
import { cx } from "@/lib/cx";
import { AlertTriangle, ArrowRight, Archive, Lock, RotateCcw, Zap, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";

type Tone = "trigger" | "transition" | "running" | "stopped" | "failed" | "destroyed";

const TONE_CLASSES: Record<Tone, string> = {
  trigger: "border-transparent bg-transparent px-0 text-muted-foreground italic",
  transition: "border-dashed border-border bg-background text-muted-foreground",
  running: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  stopped: "border-border bg-muted text-foreground",
  failed: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  destroyed: "border-border bg-background text-muted-foreground",
};

interface Track {
  label: string;
  via: ReactNode;
  states: [name: string, tone: Tone][];
}

const TRACKS: Track[] = [
  {
    label: "Create",
    via: <InlineCode>create()</InlineCode>,
    states: [
      ["provisioning", "transition"],
      ["setting_up", "transition"],
      ["starting", "transition"],
      ["running", "running"],
    ],
  },
  {
    label: "Stop",
    via: <InlineCode>stop()</InlineCode>,
    states: [
      ["running", "running"],
      ["stopping", "transition"],
      ["stopped", "stopped"],
    ],
  },
  {
    label: "Wake",
    via: (
      <>
        any operation, or <InlineCode>resume()</InlineCode>
      </>
    ),
    states: [
      ["stopped", "stopped"],
      ["resuming", "transition"],
      ["running", "running"],
    ],
  },
  {
    label: "Destroy",
    via: <InlineCode>destroy()</InlineCode>,
    states: [
      ["any state", "trigger"],
      ["destroying", "transition"],
      ["destroyed", "destroyed"],
    ],
  },
  {
    label: "Fail",
    via: "setup or provider error",
    states: [
      ["any step", "trigger"],
      ["failed", "failed"],
    ],
  },
];

function StatePill({ name, tone }: { name: string; tone: Tone }): ReactElement {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 font-mono text-xs",
        TONE_CLASSES[tone],
      )}
    >
      {tone === "running" ? <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {name}
    </span>
  );
}

const NOTES: { title: string; icon: LucideIcon; body: ReactNode }[] = [
  {
    title: "Auto-resume",
    icon: Zap,
    body: (
      <>
        <InlineCode>exec</InlineCode>, <InlineCode>getUrl</InlineCode>, <InlineCode>readFile</InlineCode>,{" "}
        <InlineCode>writeFiles</InlineCode>, <InlineCode>logs</InlineCode> and the other operations wake a stopped
        sandbox and launch <InlineCode>resume</InlineCode> first. Turn it off with{" "}
        <InlineCode>autoResume: false</InlineCode> and call <InlineCode>resume(id)</InlineCode> yourself.
      </>
    ),
  },
  {
    title: "Concurrency",
    icon: Lock,
    body: (
      <>
        Status changes are compare-and-set on a version column. If several requests hit a stopped sandbox at once,
        exactly one resumes it and the others wait, up to <InlineCode>transitionTimeoutMs</InlineCode> (10 minutes
        by default).
      </>
    ),
  },
  {
    title: "Failures",
    icon: AlertTriangle,
    body: (
      <>
        A failing setup step (<InlineCode>SandboxCommandError</InlineCode>) or provider error marks the sandbox{" "}
        <InlineCode>failed</InlineCode> and keeps the provider sandbox so you can inspect it.{" "}
        <InlineCode>resume</InlineCode> retries it without re-running setup.
      </>
    ),
  },
  {
    title: "Reconcile",
    icon: RotateCcw,
    body: (
      <>
        <InlineCode>reconcile(ids?)</InlineCode> marks sandboxes stopped behind the SDK&apos;s back as{" "}
        <InlineCode>stopped</InlineCode>, vanished ones as <InlineCode>failed</InlineCode>, and settles transitions
        abandoned by a crashed process.
      </>
    ),
  },
  {
    title: "Destroyed records are kept",
    icon: Archive,
    body: (
      <>
        <InlineCode>list</InlineCode> hides them unless you pass <InlineCode>includeDestroyed: true</InlineCode>.
      </>
    ),
  },
];

export function Lifecycle(): ReactElement {
  return (
    <Section
      id="lifecycle"
      eyebrow="Lifecycle"
      title="A lifecycle that survives restarts and races"
      description="Every sandbox moves through the same states on every provider. Stopping keeps the filesystem, and touching a stopped sandbox brings it back."
    >
      <Card className="overflow-hidden">
        <CardContent className="divide-y divide-border/70 p-0">
          {TRACKS.map((track) => (
            <div key={track.label} className="grid gap-3 px-5 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:px-6">
              <div>
                <p className="font-semibold">{track.label}</p>
                <p className="text-sm text-muted-foreground">via {track.via}</p>
              </div>
              <ol aria-label={`${track.label} transitions`} className="flex flex-wrap items-center gap-x-2 gap-y-2">
                {track.states.map(([name, tone], index) => (
                  <li key={`${name}-${index}`} className="flex items-center gap-2">
                    {index > 0 ? <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground/70" /> : null}
                    <StatePill name={name} tone={tone} />
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </CardContent>
      </Card>

      <ul className="mt-10 grid gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
        {NOTES.map(({ title, icon: Icon, body }) => (
          <li key={title} className="flex gap-3">
            <Icon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
