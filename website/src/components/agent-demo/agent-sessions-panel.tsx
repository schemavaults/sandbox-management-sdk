"use client";

import { AgentChatAnnouncement } from "@schemavaults/ui/components/ui/agent-chat-messages/agent-chat-announcement.js";
import { AgentChatArtifactMessage } from "@schemavaults/ui/components/ui/agent-chat-messages/agent-chat-artifact-message.js";
import { AgentChatBubble } from "@schemavaults/ui/components/ui/agent-chat-messages/agent-chat-bubble.js";
import { AgentChatMessages } from "@schemavaults/ui/components/ui/agent-chat-messages/agent-chat-messages.js";
import { AgentTypingIndicator } from "@schemavaults/ui/components/ui/agent-chat-messages/agent-typing-indicator.js";
import {
  AgentSessions,
  AgentSessionsComposer,
  AgentSessionsConversation,
  AgentSessionsHeader,
  AgentSessionsHeaderActions,
  AgentSessionsList,
  AgentSessionsListItem,
  AgentSessionsMain,
  AgentSessionsNewSessionButton,
  AgentSessionsPromptInput,
  AgentSessionsSearch,
  AgentSessionsSidebar,
  AgentSessionsSidebarContent,
  AgentSessionsSidebarFooter,
  AgentSessionsSidebarHeader,
  AgentSessionsSidebarToggle,
  AgentSessionsStart,
  AgentSessionsStartHeader,
  AgentSessionsSuggestion,
  AgentSessionsSuggestions,
  AgentSessionsTitle,
  AgentSessionStatusIndicator,
  useAgentSessions,
} from "@schemavaults/ui/components/ui/agent-sessions/index.js";
import { Button } from "@schemavaults/ui/components/ui/button/index.js";
import { PromptInputSubmit, PromptInputTextarea, PromptInputToolbar } from "@schemavaults/ui/components/ui/prompt-input/index.js";
import {
  TerminalFrame,
  TerminalFrameBody,
  TerminalFrameOutput,
  TerminalFramePrompt,
} from "@schemavaults/ui/components/ui/terminal-frame/index.js";
import type { SandboxStatus } from "@schemavaults/sandbox-management-sdk";
import { Bot, Clock, FileText, FolderOpen, Moon, Play, Sparkles, Trash2 } from "lucide-react";
import { Fragment, useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import type { AgentDemo, DemoMessage, DemoSession } from "./agent-demo";
import { agentDemoLink } from "./agent-demo-link";

const STATUS_LABELS: Record<SandboxStatus, string> = {
  provisioning: "Provisioning",
  setting_up: "Setting up",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  resuming: "Resuming",
  failed: "Failed",
  destroying: "Destroying",
  destroyed: "Destroyed",
};

const SUGGESTIONS = [
  { prompt: "List the files in your sandbox", label: "List the files", description: "Runs ls -la", icon: <FolderOpen aria-hidden /> },
  { prompt: "Read the README", label: "Read the README", description: "Written by setup", icon: <FileText aria-hidden /> },
  { prompt: "Write me a haiku", label: "Write a haiku", description: "Saved to haiku.txt", icon: <Sparkles aria-hidden /> },
  { prompt: "What time is it?", label: "Ask the time", description: "Runs date", icon: <Clock aria-hidden /> },
] as const;

/** Renders `code` spans in a model reply. */
function withInlineCode(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={index} className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/** The crate's color, with the session's status dot on its corner. */
function CrateSwatch({ session }: { session: DemoSession }): ReactElement {
  return (
    <span className="relative inline-flex">
      <span aria-hidden className="h-3.5 w-3.5 rounded-[4px] ring-1 ring-black/10" style={{ backgroundColor: session.color }} />
      {session.status === "idle" ? null : (
        <AgentSessionStatusIndicator status={session.status} className="absolute -right-1 -top-1 ring-2 ring-background" />
      )}
    </span>
  );
}

function Message({ message }: { message: DemoMessage }): ReactElement {
  switch (message.kind) {
    case "user":
      return <AgentChatBubble from="user">{message.text}</AgentChatBubble>;
    case "assistant":
      return (
        <AgentChatBubble from="assistant" senderName="dummy-1">
          {withInlineCode(message.text)}
          {message.streaming ? <span aria-hidden className="ml-0.5 inline-block h-[1em] w-[0.45em] translate-y-[0.15em] animate-pulse bg-current motion-reduce:animate-none" /> : null}
        </AgentChatBubble>
      );
    case "tool": {
      const output = message.result ? (message.result.stdout + message.result.stderr).trimEnd() : "";
      const failed = message.result !== null && message.result.exitCode !== 0;
      return (
        <AgentChatArtifactMessage from="assistant">
          <TerminalFrame variant="minimal" size="sm" theme="dark" className="w-full rounded-lg">
            <TerminalFrameBody size="sm" theme="dark" className="max-h-64">
              <TerminalFramePrompt prompt="$" promptTone="success" cursor={message.result === null}>
                {message.command}
              </TerminalFramePrompt>
              {message.result === null ? null : (
                <TerminalFrameOutput tone={failed ? "danger" : "default"}>{output || "(no output)"}</TerminalFrameOutput>
              )}
              {failed ? <TerminalFrameOutput tone="muted">exit code {message.result?.exitCode}</TerminalFrameOutput> : null}
            </TerminalFrameBody>
          </TerminalFrame>
        </AgentChatArtifactMessage>
      );
    }
    case "event":
      return (
        <AgentChatAnnouncement variant={message.tone === "destructive" ? "destructive" : "info"}>
          {withInlineCode(message.text)}
        </AgentChatAnnouncement>
      );
  }
}

/** Stop / resume and destroy for the open session's sandbox. */
function SandboxActions({ demo }: { demo: AgentDemo }): ReactElement | null {
  const { activeSession } = useAgentSessions<DemoSession>();
  if (!activeSession) return null;
  const { id, sandboxStatus } = activeSession;
  const canStop = sandboxStatus === "running";
  const canResume = sandboxStatus === "stopped" || sandboxStatus === "failed";
  return (
    <AgentSessionsHeaderActions>
      <span className="mr-1 hidden text-xs text-muted-foreground min-[380px]:inline">{STATUS_LABELS[sandboxStatus]}</span>
      {canResume ? (
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Resume the sandbox" title="resume()" onClick={() => demo.resume(id)}>
          <Play aria-hidden className="h-4 w-4" />
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Stop the sandbox" title="stop()" disabled={!canStop} onClick={() => demo.stop(id)}>
          <Moon aria-hidden className="h-4 w-4" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="Destroy the sandbox and end the session"
        title="destroy()"
        disabled={sandboxStatus === "destroying"}
        onClick={() => demo.destroy(id)}
      >
        <Trash2 aria-hidden className="h-4 w-4" />
      </Button>
    </AgentSessionsHeaderActions>
  );
}

function Conversation({ demo, session }: { demo: AgentDemo; session: DemoSession }): ReactElement {
  return (
    <>
      <AgentChatMessages aria-label={`Conversation with ${session.title}`} className="px-3">
        <AgentChatAnnouncement key="intro" icon={<Bot aria-hidden className="h-4 w-4" />}>
          Sandbox <code className="font-mono text-[0.85em]">{session.id.slice(0, 12)}…</code> runs in this tab. Its record is
          in sessionStorage; its files are in memory and vanish with the page.
        </AgentChatAnnouncement>
        {session.messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {session.thinking ? <AgentTypingIndicator key="typing" label="The agent is working" /> : null}
      </AgentChatMessages>
      <AgentSessionsComposer>
        <AgentSessionsPromptInput<DemoSession>
          isLoading={session.busy}
          onStop={() => demo.interrupt(session.id)}
          onSubmit={(value) => demo.send(session.id, value)}
        >
          <PromptInputTextarea placeholder={session.sandboxStatus === "stopped" ? "Say something to wake it up…" : "Ask the dummy agent something…"} />
          <PromptInputToolbar>
            <span className="truncate pl-1 text-xs text-muted-foreground">Try “list the files”, or a command in `backticks`</span>
            <PromptInputSubmit />
          </PromptInputToolbar>
        </AgentSessionsPromptInput>
      </AgentSessionsComposer>
    </>
  );
}

/**
 * The hero's agent sessions: every session is a dummy agent with its own
 * ephemeral browser sandbox, created by clicking the sand (or from the
 * new-session screen here). Lives in its own lazily loaded chunk.
 */
export function AgentSessionsPanel(): ReactElement {
  const [demo, setDemo] = useState<AgentDemo | null>(null);
  const [failed, setFailed] = useState(false);
  const snapshot = useSyncExternalStore(agentDemoLink.subscribe, agentDemoLink.getSnapshot, agentDemoLink.getSnapshot);
  const { sessions } = snapshot;
  // Open on the most recently active session, if there is one.
  const [activeId, setActiveId] = useState<string | null>(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null,
  );
  // A destroyed session leaves the list; fall back to the new-session screen.
  const shownId = activeId !== null && sessions.some((session) => session.id === activeId) ? activeId : null;

  useEffect(() => {
    let cancelled = false;
    agentDemoLink.load().then(
      (loaded) => {
        if (!cancelled) setDemo(loaded);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    demo?.setViewing(shownId);
    return () => demo?.setViewing(null);
  }, [demo, shownId]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        The agent demo failed to load. Check your connection and try again.
      </div>
    );
  }

  return (
    <AgentSessions<DemoSession>
      sessions={sessions}
      activeSessionId={shownId}
      onActiveSessionIdChange={setActiveId}
      newSessionTitle="New agent session"
    >
      <AgentSessionsSidebar>
        <AgentSessionsSidebarHeader>
          <AgentSessionsNewSessionButton />
          <AgentSessionsSearch placeholder="Search sessions" />
        </AgentSessionsSidebarHeader>
        <AgentSessionsSidebarContent>
          <AgentSessionsList<DemoSession>
            groupBy="none"
            empty={<span className="text-sm text-muted-foreground">No sessions yet. Click the sand in the hero to start one.</span>}
            renderItem={(session) => (
              <AgentSessionsListItem
                key={session.id}
                session={session}
                icon={<CrateSwatch session={session} />}
                description={`${STATUS_LABELS[session.sandboxStatus]} · ${session.preview ?? ""}`}
              />
            )}
          />
        </AgentSessionsSidebarContent>
        <AgentSessionsSidebarFooter>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {snapshot.storage === "sessionStorage" ? (
              <>
                Sandbox records live in this tab&apos;s sessionStorage (<code className="break-all font-mono">{snapshot.storePrefix}*</code>)
                through <code className="font-mono">WebStorageSandboxStore</code>.
              </>
            ) : (
              <>Storage is blocked here, so sandbox records live in memory.</>
            )}
          </p>
        </AgentSessionsSidebarFooter>
      </AgentSessionsSidebar>

      <AgentSessionsMain>
        <AgentSessionsHeader>
          <AgentSessionsSidebarToggle />
          <AgentSessionsTitle />
          {demo ? <SandboxActions demo={demo} /> : null}
        </AgentSessionsHeader>

        <AgentSessionsConversation<DemoSession>>
          {({ session }) => (demo && session ? <Conversation demo={demo} session={session} /> : null)}
        </AgentSessionsConversation>

        <AgentSessionsStart>
          <AgentSessionsStartHeader
            icon={<Bot aria-hidden />}
            title="Start a sandboxed agent"
            description="Each session is a virtually useless dummy agent with its own sandbox, created in this tab by SandboxManager. Click the sand in the hero, or type here."
          />
          <AgentSessionsPromptInput<DemoSession>
            disabled={!demo}
            onSubmit={(value, { selectSession }) => {
              if (demo) selectSession(demo.createSession({ prompt: value }));
            }}
          >
            <PromptInputTextarea rows={3} placeholder="Ask for the files, a haiku, the time…" />
            <PromptInputToolbar>
              <span className="pl-1 text-xs text-muted-foreground">Creates a sandbox (and a crate in the hero)</span>
              <PromptInputSubmit sendLabel="Start session" />
            </PromptInputToolbar>
          </AgentSessionsPromptInput>
          <AgentSessionsSuggestions>
            {SUGGESTIONS.map((suggestion) => (
              <AgentSessionsSuggestion key={suggestion.label} prompt={suggestion.prompt} icon={suggestion.icon} description={suggestion.description}>
                {suggestion.label}
              </AgentSessionsSuggestion>
            ))}
          </AgentSessionsSuggestions>
        </AgentSessionsStart>
      </AgentSessionsMain>
    </AgentSessions>
  );
}
