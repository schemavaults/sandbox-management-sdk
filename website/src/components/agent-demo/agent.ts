import type { ExecResult } from "@schemavaults/sandbox-management-sdk";
import type { DummyLlm, LlmMessage } from "./dummy-llm";

export type AgentEvent =
  | { type: "text-start" }
  | { type: "text-delta"; delta: string }
  | { type: "text-end" }
  | { type: "tool-start"; command: string }
  | { type: "tool-end"; command: string; result: ExecResult };

export interface AgentTurnOptions {
  llm: DummyLlm;
  /** Runs a command in the agent's sandbox (`SandboxManager.exec`, which resumes it if it is stopped). */
  exec: (command: string) => Promise<ExecResult>;
  /** The conversation so far, ending with the user's message. Tool calls and replies are appended to it. */
  history: LlmMessage[];
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Delay between streamed words, in ms. */
  wordDelayMs?: number;
}

const MAX_STEPS = 3;

/**
 * A really simple agent loop: ask the model, stream its words, run the
 * command it asks for in the sandbox, feed the output back, repeat (at most
 * three times). Stops early when `signal` aborts.
 */
export async function runAgentTurn({ llm, exec, history, onEvent, signal, wordDelayMs = 28 }: AgentTurnOptions): Promise<void> {
  for (let step = 0; step < MAX_STEPS && !signal?.aborted; step += 1) {
    await sleep(step === 0 ? 450 : 250, signal); // "thinking"
    const turn = llm.respond(history);
    if (turn.text) {
      onEvent({ type: "text-start" });
      for (const word of turn.text.split(/(?<=\s)/)) {
        if (signal?.aborted) break;
        onEvent({ type: "text-delta", delta: word });
        await sleep(wordDelayMs, signal);
      }
      onEvent({ type: "text-end" });
      history.push({ role: "assistant", content: turn.text });
    }
    if (!turn.toolCall || signal?.aborted) return;

    const { command } = turn.toolCall;
    onEvent({ type: "tool-start", command });
    let result: ExecResult;
    try {
      result = await exec(command);
    } catch (error) {
      result = { exitCode: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` };
    }
    onEvent({ type: "tool-end", command, result });
    history.push({ role: "tool", command, result });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
