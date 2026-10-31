import { Check } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Code } from "@/components/code";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";
import { testingSnippet } from "@/content/snippets";

const POINTS: ReactNode[] = [
  <>The mock executes nothing: it records every call and keeps files in memory.</>,
  <>
    Script command results with <InlineCode>execHandler</InlineCode>, then assert with{" "}
    <InlineCode>callsFor(id, operation)</InlineCode>.
  </>,
  <>
    Simulate stop, wake and external stops such as a provider-side timeout with{" "}
    <InlineCode>simulateExternalStop</InlineCode>, and feed the main log with <InlineCode>appendMainLog</InlineCode>.
  </>,
];

export function Testing(): ReactElement {
  return (
    <Section
      id="testing"
      eyebrow="Testing"
      title="Test your app without spinning up a sandbox"
      description={
        <>
          The <InlineCode>/testing</InlineCode> entry point ships a mock provider and an in-memory store that drop into
          the same <InlineCode>SandboxManager</InlineCode> your app uses.
        </>
      }
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Code code={testingSnippet} title="app.test.ts" className="min-w-0" />
        <ul className="space-y-4 lg:pt-2">
          {POINTS.map((point, index) => (
            <li key={index} className="flex gap-3 text-sm leading-relaxed text-muted-foreground">
              <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
