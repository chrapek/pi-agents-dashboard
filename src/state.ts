import path from "node:path";
import type { AgentMeta, AgentStatus } from "./store.ts";

export type RowState = "needs_input" | "working" | "done" | "failed" | "stopped";

export interface Row {
  id: string;
  name: string; // meta.name
  repo: string; // basename(meta.repoRoot), or "no worktree" when meta.worktree is null
  branch: string | null; // meta.branch
  state: RowState;
  summary: string; // single line, no newlines
  age: string; // formatAge(now - meta.createdAt)
  createdAt: number;
  model: string | null; // status?.model ?? null
  alive: boolean; // tmux session alive
}

export const GROUP_ORDER: readonly RowState[] = ["needs_input", "working", "done", "failed", "stopped"];

export const GROUP_LABELS: Record<RowState, string> = {
  needs_input: "Needs input",
  working: "Working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

// Spec §5: "ends with ?" ignores trailing whitespace and the characters * _ ` ) " '
const TRAILING_IGNORED_RE = /[\s*_`)"']+$/;
// Sentence boundary inside a paragraph: whitespace after . ! or ? (optionally followed by ignored chars).
const SENTENCE_BREAK_RE = /(?<=[.!?][*_`)"']*)\s+/;
// A line starting a list item or heading begins a new paragraph; other single newlines are hard wraps.
const BLOCK_START_RE = /^\s*([-*+]|\d+[.)]|#+)\s/;
// A heading is always a single-line paragraph.
const HEADING_RE = /^\s*#+\s/;

function endsWithQuestion(text: string): boolean {
  return text.replace(TRAILING_IGNORED_RE, "").endsWith("?");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** First non-empty line, trimmed; "" when there is none. */
function firstLine(text: string | null): string {
  if (text === null) return "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = oneLine(line);
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** Lines joined with spaces; blank lines and list-item/heading lines start a new paragraph, headings end one. */
function paragraphs(text: string): string[] {
  const result: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || BLOCK_START_RE.test(line)) {
      if (current.length > 0) result.push(current.join(" "));
      current = [];
    }
    if (line.trim() !== "") current.push(line);
    if (HEADING_RE.test(line)) {
      result.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) result.push(current.join(" "));
  return result;
}

/** Last sentence whose end (after the ignore rule) is "?", as one line; "" when there is none. */
function lastQuestion(text: string | null): string {
  if (text === null) return "";
  const sentences = paragraphs(text).flatMap((paragraph) => paragraph.split(SENTENCE_BREAK_RE));
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = oneLine(sentences[i]!);
    if (sentence !== "" && endsWithQuestion(sentence)) return sentence;
  }
  return "";
}

function rowStateAndSummary(status: AgentStatus | null, alive: boolean): { state: RowState; summary: string } {
  if (!alive) return { state: "stopped", summary: firstLine(status?.lastText ?? null) || "Exited before starting" };
  if (status === null) return { state: "working", summary: "Starting…" };
  if (status.uiPrompt !== null) {
    const summary = oneLine(status.uiPrompt.title) || lastQuestion(status.lastText) || "Waiting for input";
    return { state: "needs_input", summary };
  }
  const idle = status.phase === "idle";
  if (idle && status.lastOutcome === "completed" && status.lastText !== null && endsWithQuestion(status.lastText)) {
    return { state: "needs_input", summary: lastQuestion(status.lastText) || "Waiting for input" };
  }
  if (status.phase === "working") return { state: "working", summary: oneLine(status.activity ?? "") || "Working…" };
  if (idle && status.lastOutcome === "error") return { state: "failed", summary: firstLine(status.lastText) || "Failed" };
  return { state: "done", summary: firstLine(status.lastText) || "Done" };
}

export function deriveRow(meta: AgentMeta, status: AgentStatus | null, alive: boolean, now: number): Row {
  const { state, summary } = rowStateAndSummary(status, alive);
  return {
    id: meta.id,
    name: meta.name,
    repo: meta.worktree === null || meta.repoRoot === null ? "no worktree" : path.basename(meta.repoRoot),
    branch: meta.branch,
    state,
    summary,
    age: formatAge(now - meta.createdAt),
    createdAt: meta.createdAt,
    model: status?.model ?? null,
    alive,
  };
}

/** Group order (GROUP_ORDER), newest first inside a group. Does not mutate the input. */
export function sortRows(rows: Row[]): Row[] {
  return rows
    .slice()
    .sort((a, b) => GROUP_ORDER.indexOf(a.state) - GROUP_ORDER.indexOf(b.state) || b.createdAt - a.createdAt);
}

/** Floor to the largest unit: "45s", "12m", "3h", "2d". Negative or non-finite → "0s". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
