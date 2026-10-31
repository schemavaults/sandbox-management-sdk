import { Fragment, type ReactElement, type ReactNode } from "react";
import { Code } from "@/components/code";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";
import { installCommands } from "@/content/snippets";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/lib/ui";

/** Lets an import path wrap after each "/" on narrow screens. */
function BreakablePath({ path }: { path: string }): ReactElement {
  const segments = path.split("/");
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment}
          {index < segments.length - 1 ? (
            <>
              /<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

const ENTRY_POINTS: { path: string; contents: ReactNode }[] = [
  {
    path: "@schemavaults/sandbox-management-sdk",
    contents: (
      <>
        <InlineCode>SandboxManager</InlineCode>, <InlineCode>InMemorySandboxStore</InlineCode>, types, errors, helpers for
        writing providers
      </>
    ),
  },
  { path: "…/docker", contents: <InlineCode>DockerSandboxProvider</InlineCode> },
  { path: "…/vercel", contents: <InlineCode>VercelSandboxProvider</InlineCode> },
  {
    path: "…/dbh",
    contents: (
      <>
        <InlineCode>DbhSandboxStore</InlineCode>, <InlineCode>createSandboxesMigration</InlineCode>,{" "}
        <InlineCode>up</InlineCode> / <InlineCode>down</InlineCode>
      </>
    ),
  },
  {
    path: "…/dbh/migration",
    contents: (
      <>
        <InlineCode>up</InlineCode> / <InlineCode>down</InlineCode> only, to re-export from a migrations directory
      </>
    ),
  },
  {
    path: "…/testing",
    contents: (
      <>
        <InlineCode>MockSandboxProvider</InlineCode>, <InlineCode>InMemorySandboxStore</InlineCode>
      </>
    ),
  },
];

const PACKAGE_MANAGERS = Object.keys(installCommands) as (keyof typeof installCommands)[];

export function Install(): ReactElement {
  return (
    <Section
      id="install"
      eyebrow="Install"
      title="Install the core, add only the backends you use"
      description="Docker, Vercel Sandbox and the Postgres store are optional peer dependencies, and each one lives behind its own entry point."
    >
      <div className="grid gap-12">
        <Tabs defaultValue="bun" className="min-w-0">
          <TabsList aria-label="Package manager">
            {PACKAGE_MANAGERS.map((pm) => (
              <TabsTrigger key={pm} value={pm} className="font-mono">
                {pm}
              </TabsTrigger>
            ))}
          </TabsList>
          {PACKAGE_MANAGERS.map((pm) => (
            <TabsContent key={pm} value={pm} className="mt-4">
              <Code code={installCommands[pm]} language="bash" title="Terminal" />
            </TabsContent>
          ))}
        </Tabs>

        <div className="min-w-0">
          <h3 className="text-lg font-semibold">Entry points</h3>
          <div className="mt-4 overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Import from</TableHead>
                  <TableHead>Contents</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ENTRY_POINTS.map(({ path, contents }) => (
                  <TableRow key={path}>
                    <TableCell className="align-top font-mono text-sm font-medium sm:whitespace-nowrap">
                      <BreakablePath path={path} />
                    </TableCell>
                    <TableCell className="min-w-[10rem] align-top text-muted-foreground">{contents}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </Section>
  );
}
