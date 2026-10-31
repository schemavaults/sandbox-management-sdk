import type { ReactElement, ReactNode } from "react";
import { Code } from "@/components/code";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";
import { quickStartSnippet } from "@/content/snippets";

const STEPS: { title: string; body: ReactNode }[] = [
  {
    title: "Register providers",
    body: (
      <>
        Each provider is a backend. <InlineCode>defaultProvider</InlineCode> picks one when{" "}
        <InlineCode>create</InlineCode> is not given a <InlineCode>provider</InlineCode>.
      </>
    ),
  },
  {
    title: "Pick a store",
    body: (
      <>
        <InlineCode>DbhSandboxStore</InlineCode> keeps records in Postgres so every server process sees the same
        sandboxes. <InlineCode>InMemorySandboxStore</InlineCode> suits a single process.
      </>
    ),
  },
  {
    title: "Describe the sandbox",
    body: (
      <>
        The spec is stored with the record, so any process can later resume the sandbox by ID alone.
      </>
    ),
  },
  {
    title: "Drive it",
    body: (
      <>
        <InlineCode>getUrl</InlineCode>, <InlineCode>exec</InlineCode>, <InlineCode>stop</InlineCode>,{" "}
        <InlineCode>list</InlineCode> and <InlineCode>destroy</InlineCode>. A stopped sandbox wakes on the next call.
      </>
    ),
  },
];

export function QuickStart(): ReactElement {
  return (
    <Section
      id="quick-start"
      eyebrow="Quick start"
      title="From zero to a running sandbox"
      description="Register providers and a store once, then manage every sandbox through the same SandboxManager."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Code code={quickStartSnippet} title="sandboxes.ts" className="min-w-0" />
        <ol className="space-y-6 lg:pt-2">
          {STEPS.map(({ title, body }, index) => (
            <li key={title} className="flex gap-4">
              <span
                aria-hidden
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border bg-muted font-mono text-xs font-semibold"
              >
                {index + 1}
              </span>
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
