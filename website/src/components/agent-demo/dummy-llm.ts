import type { ExecResult } from "@schemavaults/sandbox-management-sdk";

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; command: string; result: ExecResult };

/** One model turn: something to say, and optionally a command to run in the sandbox. */
export interface LlmTurn {
  text: string;
  toolCall?: { command: string };
}

export const DUMMY_MODEL_NAME = "dummy-1";

const pick = <T,>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;

/** Single-quotes `value` for the toy shell. */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const SMALL_TALK = [
  "Great question. I thought about it for 0.0001 seconds and concluded: it depends.",
  "I'm {model}, a language model that runs entirely in your browser tab. I know about forty words, and \"sandbox\" is three of them.",
  "Interesting! I'd love to help with “{topic}”, but my training data is one README and a postcard.",
  "Have you tried turning the sandbox off and on again? Click its crate to `stop()` it; your next message will `resume()` it.",
  "I've weighed every option and I'm going with option B. There was no option A.",
  "Bold of you to ask a model with zero parameters about “{topic}”. I respect it.",
  "I could answer that, or I could run `ls` for you. Honestly `ls` is my strongest skill.",
];

const AFTER_SUCCESS = [
  "I ran `{command}`. It printed {lines}. I've read every one of them and I'm about 40% sure they're fine.",
  "Done. `{command}` says the above. I'd summarize it, but that's above my pay grade, which is zero.",
  "There you go: the output of `{command}`. Nailed it, if I may say so, and I may, because nobody else will.",
];

const AFTER_SILENCE = [
  "`{command}` finished without saying a word. Relatable.",
  "Ran `{command}`. Exit code 0 and no output, which in shell means “trust me”.",
];

const AFTER_FAILURE = [
  "`{command}` exited with code {code}. I'm choosing to see that as a learning opportunity.",
  "That went poorly (exit code {code}). In my defense, I am a dummy.",
];

const HAIKUS = [
  "Sand in a crate / sleeps until you say its name / and wakes up resumed",
  "Stop keeps the files / resume brings back the process / the duck does not care",
  "A whale of boxes / swims around the lagoon / compare-and-set, splash",
];

/**
 * A "virtually useless" language model. It matches a handful of keywords to
 * shell commands (so the agent has something to run in its sandbox), and
 * otherwise produces confident nonsense. No network, no weights, no clue.
 */
export class DummyLlm {
  readonly name = DUMMY_MODEL_NAME;

  constructor(private readonly random: () => number = Math.random) {}

  respond(history: readonly LlmMessage[]): LlmTurn {
    const last = history.at(-1);
    if (!last) return { text: "Hello? Is anyone there? I'm only a dummy, so I can't tell." };
    if (last.role === "tool") return { text: this.afterTool(last.command, last.result) };
    if (last.role === "assistant") return { text: "" };
    return this.answer(last.content.trim());
  }

  private answer(prompt: string): LlmTurn {
    const fill = (template: string) =>
      template.replaceAll("{model}", this.name).replaceAll("{topic}", topicOf(prompt));
    const lower = prompt.toLowerCase();

    const explicit = /`([^`]+)`/.exec(prompt)?.[1] ?? /^(?:\$|run|exec(?:ute)?)\s+(.+)$/i.exec(prompt)?.[1];
    if (explicit) return { text: "Running that for you, no questions asked. I never ask questions.", toolCall: { command: explicit.trim() } };

    const file = /\b(?:read|cat|show|open|print)\b.*?([\w./-]+\.\w+)/i.exec(prompt)?.[1];
    if (file) return { text: `Let me read \`${file}\`. Reading is one of my two skills.`, toolCall: { command: `cat ${quote(file)}` } };
    if (/\breadme\b/.test(lower)) return { text: "Ah, the README. My favourite novel.", toolCall: { command: "cat README.md" } };

    if (/\b(haiku|poem|poetry)\b/.test(lower)) {
      const haiku = pick(HAIKUS, this.random);
      return { text: "I've composed a haiku and saved it, for posterity (until you close the tab).", toolCall: { command: `echo ${quote(haiku)} > haiku.txt && cat haiku.txt` } };
    }

    const note = /\b(?:remember|note|save|write down|jot down)\b(?:\s+(?:that|to))?\s*[:,]?\s*["“]?(.+?)["”]?\s*$/i.exec(prompt)?.[1];
    if (note) return { text: "Noted. Literally: I'm appending it to `notes.txt`.", toolCall: { command: `echo ${quote(note)} >> notes.txt && cat notes.txt` } };

    if (/\b(ls|list|files?|folders?|director(?:y|ies)|what'?s (?:in|here))\b/.test(lower)) {
      return { text: "Let's see what's in here. `ls` is my strongest skill.", toolCall: { command: "ls -la" } };
    }
    if (/\b(time|date|day|clock|today)\b/.test(lower)) {
      return { text: "I have no concept of time, but the sandbox does.", toolCall: { command: "date" } };
    }
    if (/\b(where am i|system|machine|os|kernel|uname|computer)\b/.test(lower)) {
      return { text: "Let me ask the machine about itself.", toolCall: { command: "uname -a && hostname" } };
    }
    if (/\b(env|environment|variables?)\b/.test(lower)) {
      return { text: "Here's the environment the SDK gave this sandbox (`spec.env` plus a few defaults).", toolCall: { command: "env" } };
    }
    if (/\b(help|what can you do|commands?)\b/.test(lower)) {
      return {
        text: "I can run a few shell commands in my sandbox. Ask me to list the files, read the README, write a haiku, remember something, or tell the time. Or put any command in backticks. The sandbox's shell will show you what it knows:",
        toolCall: { command: "help" },
      };
    }
    if (/\b(who are you|what are you|your name)\b/.test(lower)) {
      return {
        text: `I'm ${this.name}, a virtually useless language model. I run in your browser next to a sandbox that @schemavaults/sandbox-management-sdk manages: its record lives in this tab's sessionStorage and its files in memory.`,
      };
    }
    if (/^(hi|hello|hey|yo|howdy|good (morning|afternoon|evening))\b/.test(lower)) {
      return { text: "Hello! I'm a very small agent in a very small sandbox. Ask me to list the files, or to write a haiku." };
    }
    return { text: fill(pick(SMALL_TALK, this.random)) };
  }

  private afterTool(command: string, result: ExecResult): string {
    const fill = (template: string) => {
      const lines = (result.stdout + result.stderr).split("\n").filter((line) => line.length > 0).length;
      return template
        .replaceAll("{command}", command.length > 24 ? `${command.split(" ")[0]} …` : command)
        .replaceAll("{code}", String(result.exitCode))
        .replaceAll("{lines}", `${lines} line${lines === 1 ? "" : "s"}`);
    };
    if (result.exitCode !== 0) return fill(pick(AFTER_FAILURE, this.random));
    if (!result.stdout.trim()) return fill(pick(AFTER_SILENCE, this.random));
    return fill(pick(AFTER_SUCCESS, this.random));
  }
}

/** A few words from the prompt to parrot back. */
function topicOf(prompt: string): string {
  const words = prompt.replace(/[?!.]+$/, "").split(/\s+/).filter(Boolean);
  const topic = words.slice(0, 6).join(" ");
  return words.length > 6 ? `${topic}…` : topic || "that";
}
