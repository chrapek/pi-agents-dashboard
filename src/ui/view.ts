// Pure dashboard renderer (spec §6). No Pi runtime state: everything comes from the view model,
// styling goes through `paint`, width math through pi-tui's pure helpers.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GROUP_LABELS, GROUP_ORDER } from "../state.ts";
import type { Row, RowState } from "../state.ts";

/** Semantic style roles; each is a Pi theme foreground token except `bold`. */
export type PaintRole = "accent" | "warning" | "success" | "error" | "dim" | "muted" | "border" | "bold";
export type Paint = (role: PaintRole, text: string) => string;
export const plainPaint: Paint = (_role, text) => text;

export interface InputLineModel {
  value: string;
  placeholder: string;
  /** Renders the focused input (cursor, scrolling) into the width left after the prompt. */
  render?: (width: number) => string;
}

export interface PeekView {
  row: Row;
  lastText: string | null;
  /** True until the first peek for this row has resolved; shows `Loading…` instead of the text. */
  loading?: boolean;
  reply: InputLineModel;
}

export type MessageTone = "info" | "warning" | "error";

export interface DashboardView {
  rows: Row[]; // already sorted (sortRows)
  selectedId: string | null;
  spinnerFrame: number;
  peek: PeekView | null; // non-null = peek mode
  message: { text: string; tone: MessageTone } | null;
  input: InputLineModel;
}

export const SPINNER_FRAMES: readonly string[] = ["✽", "✻", "✶", "✢"];
export const PEEK_TEXT_LINES = 12;
export const DISPATCH_PROMPT = "› ";
export const REPLY_PROMPT = "reply › ";
export const DISPATCH_PLACEHOLDER = "Describe a task for a new agent…";
export const EMPTY_HINT = "No agents yet — describe a task below";
export const LIST_FOOTER = "↑↓ select · enter attach · space peek · ctrl+x delete · esc close";
export const PEEK_FOOTER = "↑↓ select · enter send · → attach · esc close peek";

const NAME_MAX = 24;
const REPO_MAX = 16;
const MIN_SUMMARY = 10;
const ROW_PREFIX_WIDTH = 4; // "▸ " + icon + " "
const GAP = "  ";
// Lines kept for the list before the peek text takes the rest of the height.
const MIN_LIST_WITH_PEEK = 3;

const STATIC_ICONS: Record<Exclude<RowState, "working">, { icon: string; role: PaintRole }> = {
  needs_input: { icon: "●", role: "warning" },
  done: { icon: "✓", role: "success" },
  failed: { icon: "✗", role: "error" },
  stopped: { icon: "∙", role: "dim" },
};

const MESSAGE_ROLES: Record<MessageTone, PaintRole> = { info: "accent", warning: "warning", error: "error" };

function stateLabel(state: RowState): string {
  return GROUP_LABELS[state].toLowerCase();
}

/** `1 needs input · 2 working …` for non-zero groups in group order; "" for no rows. */
export function headerCounts(rows: Row[]): string {
  return GROUP_ORDER.map((state) => [state, rows.filter((r) => r.state === state).length] as const)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${n} ${stateLabel(state)}`)
    .join(" · ");
}

/** Hard guarantee that a line fits. */
function clip(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "");
}

/** Truncate with an ellipsis and pad to exactly `width` columns. */
function fit(text: string, width: number): string {
  return truncateToWidth(text, width, "…", true);
}

interface Columns {
  nameW: number;
  repoW: number; // 0 = hidden
  summaryW: number; // 0 = hidden
  ageW: number; // 0 = hidden
}

function columns(rows: Row[], width: number): Columns {
  const maxOf = (f: (r: Row) => string) => rows.reduce((m, r) => Math.max(m, visibleWidth(f(r))), 0);
  const ageW = maxOf((r) => r.age);
  const avail = width - ROW_PREFIX_WIDTH - (ageW + 1);
  if (avail < 1) return { nameW: Math.max(0, width - ROW_PREFIX_WIDTH), repoW: 0, summaryW: 0, ageW: 0 };
  const nameW = Math.min(maxOf((r) => r.name), NAME_MAX, avail);
  let rest = avail - nameW;
  const wantRepo = Math.min(maxOf((r) => r.repo), REPO_MAX);
  const repoW = rest >= GAP.length + wantRepo + GAP.length + MIN_SUMMARY ? wantRepo : 0;
  if (repoW > 0) rest -= GAP.length + repoW;
  const summaryW = Math.max(0, rest - GAP.length);
  return { nameW, repoW, summaryW, ageW };
}

function rowLine(r: Row, selected: boolean, frame: number, cols: Columns, width: number, paint: Paint): string {
  const icon =
    r.state === "working"
      ? paint("accent", SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length]!)
      : paint(STATIC_ICONS[r.state].role, STATIC_ICONS[r.state].icon);
  let line = (selected ? paint("accent", "▸ ") : "  ") + icon + " ";
  let used = ROW_PREFIX_WIDTH + cols.nameW;
  const name = fit(r.name, cols.nameW);
  line += selected ? paint("bold", name) : name;
  if (cols.repoW > 0) {
    line += GAP + paint("muted", fit(r.repo, cols.repoW));
    used += GAP.length + cols.repoW;
  }
  if (cols.summaryW > 0) {
    line += GAP + fit(r.summary, cols.summaryW);
    used += GAP.length + cols.summaryW;
  }
  if (cols.ageW > 0) {
    line += " ".repeat(Math.max(1, width - used - cols.ageW)) + paint("dim", r.age.padStart(cols.ageW));
  }
  return clip(line, width);
}

interface ListLine {
  text: string;
  selected: boolean;
}

function listLines(view: DashboardView, width: number, paint: Paint): ListLine[] {
  if (view.rows.length === 0) return [{ text: paint("dim", fit(EMPTY_HINT, width).trimEnd()), selected: false }];
  const cols = columns(view.rows, width);
  const lines: ListLine[] = [];
  for (const state of GROUP_ORDER) {
    const group = view.rows.filter((r) => r.state === state);
    if (group.length === 0) continue;
    lines.push({ text: paint("bold", clip(`${GROUP_LABELS[state]} (${group.length})`, width)), selected: false });
    for (const r of group) {
      const selected = r.id === view.selectedId;
      lines.push({ text: rowLine(r, selected, view.spinnerFrame, cols, width, paint), selected });
    }
  }
  return lines;
}

/** `height` lines of `lines`, centred on the selected line when they don't all fit. */
function scrollWindow(lines: ListLine[], height: number): string[] {
  if (height <= 0) return [];
  const sel = lines.findIndex((l) => l.selected);
  const maxStart = Math.max(0, lines.length - height);
  const start = sel < 0 ? 0 : Math.min(Math.max(0, sel - Math.floor(height / 2)), maxStart);
  return lines.slice(start, start + height).map((l) => l.text);
}

function inputLine(prompt: string, input: InputLineModel, width: number, paint: Paint): string {
  const avail = Math.max(0, width - visibleWidth(prompt));
  let content: string;
  if (input.render) content = input.render(avail);
  else if (input.value !== "") content = truncateToWidth(input.value, avail, "…");
  else content = paint("dim", truncateToWidth(input.placeholder, avail, "…"));
  return clip(paint("accent", prompt) + content, width);
}

function peekHeader(r: Row): string {
  const parts = [r.name, r.repo, r.branch ?? "no worktree", stateLabel(r.state), r.model].filter(
    (p): p is string => p !== null && p !== "",
  );
  return parts.filter((p, i) => p !== parts[i - 1]).join(" · ");
}

function peekText(lastText: string | null, loading: boolean, width: number, paint: Paint): string[] {
  if (loading) return [paint("dim", clip("Loading…", width))];
  const text = (lastText ?? "").replace(/\t/g, "  ").trimEnd();
  if (text.trim() === "") return [paint("dim", clip("No output yet", width))];
  return wrapTextWithAnsi(text, width).map((l) => clip(l, width));
}

interface Item {
  text: string;
  priority: number; // lowest is dropped first when the height is too small
}

export function renderDashboard(view: DashboardView, width: number, height: number, paint: Paint): string[] {
  if (width < 1 || height < 1) return [];
  const peek = view.peek;
  const counts = headerCounts(view.rows);
  const header = clip(paint("bold", "Agents") + (counts ? "  " + paint("muted", counts) : ""), width);
  const list = listLines(view, width, paint);

  const fixed = 1 /* header */ + 3 /* separator, input, footer */ + (view.message ? 1 : 0);
  const avail = height - fixed;
  let text: string[] = [];
  let listHeight = Math.max(0, avail);
  if (peek) {
    const allText = peekText(peek.lastText, peek.loading === true, width, paint);
    const peekFixed = 3; // separator, header, reply
    const textBudget = avail - peekFixed - Math.min(list.length, MIN_LIST_WITH_PEEK);
    const textCount = Math.max(0, Math.min(textBudget, PEEK_TEXT_LINES, allText.length));
    text = textCount > 0 ? allText.slice(-textCount) : [];
    listHeight = Math.max(0, avail - peekFixed - text.length);
  }

  const items: Item[] = [{ text: header, priority: 3 }];
  for (const line of scrollWindow(list, listHeight)) items.push({ text: line, priority: 0 });
  if (peek) {
    items.push({ text: paint("border", clip("── peek " + "─".repeat(Math.max(0, width - 8)), width)), priority: 2 });
    items.push({ text: paint("bold", truncateToWidth(peekHeader(peek.row), width, "…")), priority: 4 });
    for (const line of text) items.push({ text: line, priority: 0 });
    items.push({ text: inputLine(REPLY_PROMPT, peek.reply, width, paint), priority: 7 });
  }
  if (view.message) {
    const role = MESSAGE_ROLES[view.message.tone];
    items.push({ text: paint(role, truncateToWidth(view.message.text, width, "…")), priority: 5 });
  }
  items.push({ text: paint("border", "─".repeat(width)), priority: 2 });
  items.push({ text: inputLine(DISPATCH_PROMPT, view.input, width, paint), priority: peek ? 6 : 7 });
  items.push({ text: paint("dim", truncateToWidth(peek ? PEEK_FOOTER : LIST_FOOTER, width, "…")), priority: 1 });

  while (items.length > height) {
    let drop = 0;
    for (let i = 1; i < items.length; i++) if (items[i]!.priority < items[drop]!.priority) drop = i;
    items.splice(drop, 1);
  }
  return items.map((item) => clip(item.text, width));
}
