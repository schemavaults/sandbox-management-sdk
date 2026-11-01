import { Callout, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/lib/ui";
import type { ReactElement, ReactNode } from "react";
import { Code } from "@/components/code";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";
import { networkSnippet } from "@/content/snippets";

const FIELDS: { field: string; meaning: ReactNode }[] = [
  {
    field: "workdir",
    meaning: (
      <>
        Absolute directory commands run in. Default: <InlineCode>/workspace</InlineCode> (Docker),{" "}
        <InlineCode>/vercel/sandbox</InlineCode> (Vercel).
      </>
    ),
  },
  { field: "env", meaning: "Environment variables for every command." },
  {
    field: "git",
    meaning: (
      <>
        <InlineCode>{"{ url, revision?, depth?, auth? }"}</InlineCode>, cloned into <InlineCode>workdir</InlineCode>{" "}
        before setup. <InlineCode>revision</InlineCode> may be a branch, tag or commit SHA.{" "}
        <InlineCode>auth</InlineCode> is sent as a one-off HTTP header and never written to{" "}
        <InlineCode>.git/config</InlineCode>. The image needs <InlineCode>git</InlineCode>.
      </>
    ),
  },
  {
    field: "setup",
    meaning: "One command or a list of them, run once after creation. Stops at the first non-zero exit.",
  },
  { field: "start", meaning: "The main process, launched detached after setup." },
  {
    field: "resume",
    meaning: (
      <>
        Launched detached as the new main process whenever a stopped sandbox is woken. Defaults to{" "}
        <InlineCode>start</InlineCode>.
      </>
    ),
  },
  {
    field: "ports",
    meaning: (
      <>
        Ports reachable through <InlineCode>getUrl</InlineCode>.
      </>
    ),
  },
  {
    field: "timeoutMs",
    meaning: (
      <>
        Maximum run time. Vercel enforces it itself. For Docker, call <InlineCode>stopExpired()</InlineCode>{" "}
        periodically.
      </>
    ),
  },
  {
    field: "resources",
    meaning: (
      <>
        <InlineCode>{"{ vcpus?, memoryMb? }"}</InlineCode>. Vercel only supports <InlineCode>vcpus</InlineCode> (2 GB
        of memory per vCPU).
      </>
    ),
  },
  {
    field: "network",
    meaning: (
      <>
        Outbound access: <InlineCode>&quot;allow-all&quot;</InlineCode> (default),{" "}
        <InlineCode>&quot;deny-all&quot;</InlineCode>, or an allowlist{" "}
        <InlineCode>{"{ allowDomains?, allowCidrs?, denyCidrs? }"}</InlineCode>.
      </>
    ),
  },
  {
    field: "providerOptions",
    meaning: (
      <>
        Provider-specific settings:{" "}
        <InlineCode>{"{ docker: { image, user, network, pullPolicy, labels } }"}</InlineCode> or{" "}
        <InlineCode>{"{ vercel: { image | runtime, region, networkPolicy, tags } }"}</InlineCode>.
      </>
    ),
  },
];

export function Spec(): ReactElement {
  return (
    <Section
      id="spec"
      eyebrow="The spec"
      title="Describe a sandbox once, resume it from anywhere"
      description={
        <>
          The <InlineCode>SandboxSpec</InlineCode> is stored with the sandbox, so any process can later resume it by ID
          alone. Every field is optional.
        </>
      }
    >
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Field</TableHead>
              <TableHead>Meaning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {FIELDS.map(({ field, meaning }) => (
              <TableRow key={field}>
                <TableCell className="whitespace-nowrap align-top font-mono text-sm font-medium">{field}</TableCell>
                <TableCell className="min-w-[18rem] align-top leading-relaxed text-muted-foreground">{meaning}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Callout intent="note" title="Commands">
          A command is either a string, run with <InlineCode>sh -c</InlineCode>, or{" "}
          <InlineCode>{"{ cmd, args?, cwd?, env? }"}</InlineCode>, run as an exact argv with no shell. A relative{" "}
          <InlineCode>cwd</InlineCode> resolves against <InlineCode>workdir</InlineCode>.
        </Callout>
        <Callout intent="caution" title="Secrets in the spec">
          <InlineCode>spec.env</InlineCode> and <InlineCode>git.auth</InlineCode> are stored in your store as-is.
          Treat the table as sensitive, or pass short-lived credentials.
        </Callout>
      </div>

      <div className="mt-10 min-w-0">
        <h3 className="text-lg font-semibold">Network access</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          <InlineCode>network</InlineCode> limits where a sandbox can connect, for example so that an agent can only
          reach the platforms it works with. Everything not on the allowlist is blocked, and the policy applies from
          creation, so <InlineCode>git</InlineCode> and <InlineCode>setup</InlineCode> run under it too. A provider
          only gets sandboxes whose policy it can enforce; otherwise <InlineCode>create</InlineCode> throws before
          anything is created, so a policy is never silently ignored. Vercel enforces allowlists natively; Docker
          enforces <InlineCode>&quot;deny-all&quot;</InlineCode> only.
        </p>
        <Code code={networkSnippet} title="network.ts" className="mt-5" />
      </div>
    </Section>
  );
}
