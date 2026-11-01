import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/lib/ui";
import { Check, Container as ContainerIcon, Puzzle, Triangle, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Code } from "@/components/code";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";
import { customProviderSnippet, dockerSnippet, vercelSnippet } from "@/content/snippets";

interface ProviderTab {
  id: string;
  label: string;
  icon: LucideIcon;
  file: string;
  code: string;
  notes: ReactNode[];
}

const PROVIDERS: ProviderTab[] = [
  {
    id: "docker",
    label: "Docker",
    icon: ContainerIcon,
    file: "docker.ts",
    code: dockerSnippet,
    notes: [
      <>
        Each sandbox is a long-lived container named <InlineCode>{"sandbox-<id>"}</InlineCode>, labeled{" "}
        <InlineCode>{"dev.schemavaults.sandbox.id=<id>"}</InlineCode>, running an idle PID 1 with{" "}
        <InlineCode>--init</InlineCode>. The image needs <InlineCode>/bin/sh</InlineCode>.
      </>,
      <>
        <InlineCode>stop</InlineCode> and <InlineCode>wake</InlineCode> map to <InlineCode>docker stop</InlineCode>{" "}
        and <InlineCode>docker start</InlineCode>, so the container filesystem persists.
      </>,
      <>
        Published ports get new random host ports on every start, and <InlineCode>getUrl</InlineCode> looks them up.
      </>,
      <>
        Docker has no native timeout: run <InlineCode>sandboxes.stopExpired()</InlineCode> from a cron job.
      </>,
      <>
        If an <InlineCode>exec</InlineCode> with <InlineCode>timeoutMs</InlineCode> or{" "}
        <InlineCode>signal</InlineCode> is abandoned, the process inside the container keeps running.
      </>,
      <>
        A <InlineCode>network</InlineCode> allowlist puts the sandbox on an internal network with no route out. Its
        only way out is an egress proxy container, <InlineCode>{"sandbox-<id>-egress"}</InlineCode>, which enforces
        the allowlist for HTTP and HTTPS (via <InlineCode>HTTP(S)_PROXY</InlineCode>) and publishes the
        sandbox&apos;s ports. Other protocols are blocked.
      </>,
    ],
  },
  {
    id: "vercel",
    label: "Vercel Sandbox",
    icon: Triangle,
    file: "vercel.ts",
    code: vercelSnippet,
    notes: [
      <>
        Sandboxes are created <InlineCode>persistent</InlineCode> and named after the SDK ID.{" "}
        <InlineCode>stop</InlineCode> snapshots the filesystem and <InlineCode>wake</InlineCode> restores it.
      </>,
      <>
        <InlineCode>timeoutMs</InlineCode> becomes the native sandbox timeout, and{" "}
        <InlineCode>extendTimeout(id, ms)</InlineCode> extends it.
      </>,
      <>
        When Vercel stops a sandbox on its own, the SDK notices and resumes it through its own{" "}
        <InlineCode>resume</InlineCode> flow, so your main process is relaunched.
      </>,
      <>
        Authenticates with <InlineCode>VERCEL_OIDC_TOKEN</InlineCode> by default, or with explicit{" "}
        <InlineCode>credentials</InlineCode>.
      </>,
      <>
        <InlineCode>network</InlineCode> becomes the native network policy. For per-domain request rules, such as
        injecting an API key header, pass a <InlineCode>@vercel/sandbox</InlineCode> policy as{" "}
        <InlineCode>providerOptions.vercel.networkPolicy</InlineCode> instead.
      </>,
    ],
  },
  {
    id: "custom",
    label: "Your own",
    icon: Puzzle,
    file: "my-provider.ts",
    code: customProviderSnippet,
    notes: [
      <>
        Implement <InlineCode>SandboxProvider</InlineCode> (see <InlineCode>src/provider.ts</InlineCode>) and register
        it next to the built-in providers.
      </>,
      <>
        For backends that can only &ldquo;run a command&rdquo;, <InlineCode>shellStartMainProcess</InlineCode>,{" "}
        <InlineCode>shellGetMainProcess</InlineCode> and <InlineCode>shellReadMainLog</InlineCode> implement the
        main-process and log bookkeeping on top of <InlineCode>exec</InlineCode>.
      </>,
      <>
        The manager handles the lifecycle, auto-resume and concurrency for you; the provider only maps operations
        onto the backend.
      </>,
      <>
        List the <InlineCode>network</InlineCode> policies your backend enforces in{" "}
        <InlineCode>networkPolicies</InlineCode>. Without it, the provider only gets sandboxes with unrestricted
        access.
      </>,
    ],
  },
];

export function Providers(): ReactElement {
  return (
    <Section
      id="providers"
      eyebrow="Providers"
      title="Docker and Vercel Sandbox included, anything else pluggable"
      description="A provider maps the lifecycle onto a backend. Register as many as you like in one manager and pick one per sandbox."
    >
      <Tabs defaultValue="docker">
        <TabsList aria-label="Provider" className="h-auto flex-wrap">
          {PROVIDERS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="gap-2">
              <Icon aria-hidden className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {PROVIDERS.map(({ id, file, code, notes }) => (
          <TabsContent key={id} value={id} className="mt-6">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <Code code={code} title={file} className="min-w-0" />
              <ul className="space-y-4">
                {notes.map((note, index) => (
                  <li key={index} className="flex gap-3 text-sm leading-relaxed text-muted-foreground">
                    <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </Section>
  );
}
