import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/lib/ui";
import { Database, HardDrive, Wrench } from "lucide-react";
import type { ReactElement } from "react";
import { Code } from "@/components/code";
import { InlineCode } from "@/components/inline-code";
import { Section } from "@/components/section";
import { dbhStoreSnippet, migrationSnippet } from "@/content/snippets";

export function Stores(): ReactElement {
  return (
    <Section
      id="stores"
      eyebrow="Stores"
      title="Sandbox state lives in your database"
      description={
        <>
          Records go through a <InlineCode>SandboxStore</InlineCode>. Every status change is an atomic compare-and-set,
          so many server processes can share sandboxes safely.
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database aria-hidden className="h-5 w-5" />
              Postgres via @schemavaults/dbh or Kysely
            </CardTitle>
            <CardDescription className="leading-relaxed">
              Add the migration to your dbh migrations directory. The store takes a dbh handler or any Kysely instance
              using the Postgres dialect, and never opens or closes connections itself, so the{" "}
              <InlineCode>postgres-neon-proxy</InlineCode> adapter works unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Code code={migrationSnippet} title="src/db/migrations/00012-create-sandboxes.ts" />
            <Code code={dbhStoreSnippet} title="store.ts" />
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-6 content-start">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <HardDrive aria-hidden className="h-5 w-5" />
                In memory
              </CardTitle>
              <CardDescription className="leading-relaxed">
                <InlineCode>InMemorySandboxStore</InlineCode> ships with the core for a single process, scripts and
                tests.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Wrench aria-hidden className="h-5 w-5" />
                Your own store
              </CardTitle>
              <CardDescription className="leading-relaxed">
                Implement <InlineCode>insert</InlineCode>, <InlineCode>get</InlineCode>, <InlineCode>list</InlineCode>,{" "}
                <InlineCode>update</InlineCode> and <InlineCode>delete</InlineCode>. <InlineCode>update</InlineCode>{" "}
                must be an atomic compare-and-set on <InlineCode>version</InlineCode>. Run the shared contract suite in{" "}
                <InlineCode>tests/contracts/store-contract.ts</InlineCode> against it to check.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </div>
    </Section>
  );
}
