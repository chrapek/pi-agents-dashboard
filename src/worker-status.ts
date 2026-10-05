import type { AgentStatus, Outcome } from "./store.ts";

/** Pi events the worker turns into status (spec §5), reduced to plain data so this module stays Pi-free. */
export type WorkerEvent =
  | { type: "session_start"; sessionFile: string | null; pid: number; model: string | null }
  | { type: "agent_start" }
  | { type: "tool_execution_start"; toolName: string; args: unknown }
  | { type: "message_end"; message: unknown } // only role === "assistant" changes lastText
  | { type: "agent_end"; messages: unknown[] }
  | { type: "agent_settled" }
  | { type: "ui_prompt_start"; kind: string; title?: string }
  | { type: "ui_prompt_end" }
  | { type: "model_select"; model: string | null }
  | { type: "session_shutdown" };

export const MAX_ACTIVITY_LENGTH = 80;

const PATH_ARG_KEYS = ["path", "file_path", "filePath"] as const;

export function initialStatus(now: number): AgentStatus {
  return {
    phase: "idle",
    activity: null,
    lastText: null,
    lastOutcome: null,
    uiPrompt: null,
    sessionFile: null,
    pid: null,
    model: null,
    updatedAt: now,
  };
}

/** Pure: returns a new status with `updatedAt = now`; never mutates `s`. */
export function reduceStatus(s: AgentStatus, e: WorkerEvent, now: number): AgentStatus {
  const next: AgentStatus = { ...s, uiPrompt: s.uiPrompt && { ...s.uiPrompt }, updatedAt: now };
  switch (e.type) {
    case "session_start":
      next.phase = "idle";
      next.sessionFile = e.sessionFile;
      next.pid = e.pid;
      next.model = e.model;
      break;
    case "agent_start":
      next.phase = "working";
      next.activity = null;
      break;
    case "tool_execution_start":
      next.activity = formatActivity(e.toolName, e.args);
      break;
    case "message_end": {
      const text = isAssistant(e.message) ? assistantText(e.message) : null;
      if (text !== null) next.lastText = text;
      break;
    }
    case "agent_end":
      next.lastOutcome = outcomeOf(e.messages);
      break;
    case "agent_settled":
      next.phase = "idle";
      next.activity = null;
      break;
    case "ui_prompt_start":
      next.uiPrompt = { kind: e.kind, title: e.title ?? "" };
      break;
    case "ui_prompt_end":
      next.uiPrompt = null;
      break;
    case "model_select":
      next.model = e.model;
      break;
    case "session_shutdown":
      next.phase = "exited";
      break;
  }
  return next;
}

/** `bash: <first non-empty line>` / `<tool> <path>` / `<tool>`, at most 80 chars (truncated with "…"). */
export function formatActivity(toolName: string, args: unknown): string {
  return truncate(rawActivity(toolName, isRecord(args) ? args : {}), MAX_ACTIVITY_LENGTH);
}

/** Events whose status must reach disk immediately rather than with the coalesced write. */
export function isUrgent(e: WorkerEvent): boolean {
  switch (e.type) {
    case "session_start":
    case "agent_settled":
    case "ui_prompt_start":
    case "ui_prompt_end":
    case "session_shutdown":
      return true;
    default:
      return false;
  }
}

function rawActivity(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") {
    const line = typeof args.command === "string" ? firstNonEmptyLine(args.command) : null;
    return line === null ? toolName : `bash: ${line}`;
  }
  for (const key of PATH_ARG_KEYS) {
    const p = args[key];
    if (typeof p === "string" && p !== "") return `${toolName} ${p}`;
  }
  return toolName;
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAssistant(m: unknown): m is Record<string, unknown> {
  return isRecord(m) && m.role === "assistant";
}

/** Text blocks joined with "\n" (thinking and tool calls ignored); null when there is no non-blank text. */
function assistantText(m: Record<string, unknown>): string | null {
  const blocks = Array.isArray(m.content) ? m.content : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (isRecord(b) && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  const text = parts.join("\n");
  return text.trim() === "" ? null : text;
}

/** From the last assistant message's stopReason: error/aborted map through, anything else (or none) is completed. */
function outcomeOf(messages: unknown[]): Outcome {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isAssistant(m)) continue;
    if (m.stopReason === "error") return "error";
    if (m.stopReason === "aborted") return "aborted";
    return "completed";
  }
  return "completed";
}
