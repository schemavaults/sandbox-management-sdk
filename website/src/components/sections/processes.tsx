import type { ReactElement } from "react";
import { Code } from "@/components/code";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";
import { filesSnippet, logsSnippet } from "@/content/snippets";

export function Processes(): ReactElement {
  return (
    <Section
      id="processes"
      eyebrow="Processes, logs and files"
      title="Talk to the sandbox like a machine"
      description="Run commands, follow the main process and move files in and out with the same calls on every provider."
    >
      <div className="grid gap-10 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">Main process and logs</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            <InlineCode>start</InlineCode> and <InlineCode>resume</InlineCode> run detached. Their stdout and stderr are
            appended to <InlineCode>/tmp/sandbox-sdk/main.log</InlineCode> inside the sandbox, which survives restarts.
            Only the first log read auto-resumes a stopped sandbox, and a <InlineCode>follow</InlineCode> stream ends
            when the sandbox stops or <InlineCode>signal</InlineCode> aborts.
          </p>
          <Code code={logsSnippet} title="logs.ts" className="mt-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">Files</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Write text or bytes with an optional mode, and read them back. Relative paths resolve against the
            sandbox&apos;s <InlineCode>workdir</InlineCode>; <InlineCode>readTextFile</InlineCode> returns{" "}
            <InlineCode>null</InlineCode> when the file is missing.
          </p>
          <Code code={filesSnippet} title="files.ts" className="mt-5" />
        </div>
      </div>
    </Section>
  );
}
