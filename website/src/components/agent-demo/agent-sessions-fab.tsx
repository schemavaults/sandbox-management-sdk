"use client";

import {
  AgentSessionsDialog,
  AgentSessionsDialogContent,
  AgentSessionsDialogTrigger,
} from "@schemavaults/ui/components/ui/agent-sessions/agent-sessions-dialog.js";
import { FloatingActionButton } from "@schemavaults/ui/components/ui/floating-action-button/index.js";
import { Bot, LoaderCircle } from "lucide-react";
import dynamic from "next/dynamic";
import { useState, useSyncExternalStore, type ReactElement } from "react";
import { agentDemoLink } from "./agent-demo-link";

const loadPanel = () => import("./agent-sessions-panel");

function PanelLoading(): ReactElement {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      <LoaderCircle aria-hidden className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
      Loading the agent demo…
    </div>
  );
}

const AgentSessionsPanel = dynamic(() => loadPanel().then((mod) => mod.AgentSessionsPanel), {
  ssr: false,
  loading: PanelLoading,
});

/** Warms both lazy chunks as soon as the visitor reaches for the button. */
function prefetch(): void {
  void loadPanel().catch(() => undefined);
  void agentDemoLink.load().catch(() => undefined);
}

/**
 * A floating button that opens the hero's agent sessions in a chat-widget
 * dialog. The dialog's contents (the `AgentSessions` UI) and the demo
 * itself are further chunks, fetched on hover, focus or the first open.
 */
export function AgentSessionsFab(): ReactElement {
  const [open, setOpen] = useState(false);
  const { sessions } = useSyncExternalStore(agentDemoLink.subscribe, agentDemoLink.getSnapshot, agentDemoLink.getSnapshot);
  const count = sessions.length;
  const unread = sessions.filter((session) => session.unread).length;
  const label =
    count === 0
      ? "Open the agent demo"
      : `Open agent sessions: ${count} running${unread > 0 ? `, ${unread} with new replies` : ""}`;

  return (
    <AgentSessionsDialog open={open} onOpenChange={setOpen}>
      <AgentSessionsDialogTrigger asChild>
        <FloatingActionButton
          variant="brand"
          size="sm"
          position="bottom-right"
          aria-label={label}
          title="Agent sessions"
          onPointerEnter={prefetch}
          onFocus={prefetch}
          className="h-12 w-12 duration-300 animate-in fade-in-0 zoom-in-90 motion-reduce:animate-none [&_svg]:size-5"
          icon={
            <span className="relative inline-flex">
              <Bot aria-hidden />
              {count > 0 ? (
                <span
                  aria-hidden
                  className={`absolute -right-3 -top-3 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.6875rem] font-semibold leading-none ring-2 ring-background ${
                    unread > 0 ? "bg-red-500 text-white" : "bg-background text-foreground"
                  }`}
                >
                  {count}
                </span>
              ) : null}
            </span>
          }
        />
      </AgentSessionsDialogTrigger>
      <AgentSessionsDialogContent
        placement="bottom-right"
        title="Agent sessions"
        description="Dummy agents, each with its own ephemeral sandbox in this browser tab."
      >
        <AgentSessionsPanel />
      </AgentSessionsDialogContent>
    </AgentSessionsDialog>
  );
}
