// Pure dashboard renderer (spec §6). No Pi runtime state: everything comes from the view model,
// styling goes through `paint`, width math through pi-tui's pure helpers.
//
// Layout (top to bottom): title bar · action line · grouped two-line rows · filler · message ·
// peek box · input box · key hints. The input box is pinned to the bottom of the screen.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GROUP_LABELS, GROUP_ORDER } from "../state.ts";
import type { Row, RowState } from "../state.ts";

/** Semantic style roles: Pi theme foreground tokens, plus `bold` and `selected` (the `selectedBg` background). */
export type PaintRole = "accent" | "warning" | "success" | "error" | "dim" | "muted" | "border" | "bold" | "selected";
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

/** Where new agents go and what they run; shown in the title bar and the input box border. */
export interface HeaderContext {
  cwd: string; // display form, e.g. `~/www/pnaf`
  branch: string | null;
  inRepo: boolean; // new agents get a worktree
  modelLabel: string | null; // e.g. `claude-opus-5-5 (high)`
}

export type MessageTone = "info" | "warning" | "error";

export interface DashboardView {
  rows: Row[]; // already sorted (sortRows)
  selectedId: string | null;
  spinnerFrame: number;
  peek: PeekView | null; // non-null = peek mode
  message: { text: string; tone: MessageTone } | null;
  input: InputLineModel;
  /** The open `/` menu (Pi's command autocomplete), drawn under the input box; null or absent when closed. */
  suggestions?: { render(width: number): string[] } | null;
  context: HeaderContext;
}

export const SPINNER_FRAMES: readonly string[] = ["✽", "✻", "✶", "✢"];
export const PEEK_TEXT_LINES = 12;
export const DISPATCH_PROMPT = "❯ ";
export const REPLY_PROMPT = "reply ❯ ";
export const DISPATCH_PLACEHOLDER = "Dispatch a new agent";
export const EMPTY_HINT = "No agents yet — describe a task below";
export const NEW_AGENT_WORKTREE = "+ New Agent in Worktree";
export const NEW_AGENT_PLAIN = "+ New Agent";
export const WORKTREE_BADGE = "worktree";

export type Hint = readonly [key: string, action: string];
export const ROW_ACTIONS: readonly Hint[] = [
  ["Space", "Peek"],
  ["→", "Attach"],
  ["^X", "Delete"],
];
export const LIST_HINTS_EMPTY: readonly Hint[] = [
  ["↑↓", "select"],
  ["Enter", "attach"],
  ["Esc", "close"],
];
export const LIST_HINTS_TYPING: readonly Hint[] = [
  ["Enter", "create"],
  ["⇧Enter", "create + attach"],
  ["Esc", "clear"],
];
export const SUGGESTION_HINTS: readonly Hint[] = [
  ["↑↓", "choose"],
  ["Tab", "complete"],
  ["Enter", "run"],
  ["Esc", "dismiss"],
];
export const PEEK_HINTS: readonly Hint[] = [
  ["↑↓", "select"],
  ["Enter", "send"],
  ["→", "attach"],
  ["Esc", "close peek"],
];

/** Plain `key:action │ key:action` text, as the footer reads without styling. */
export function hintsText(hints: readonly Hint[]): string {
  return hints.map(([key, action]) => `${key}:${action}`).join(" │ ");
}

const MARGIN = " ";
const MARGIN_MIN_WIDTH = 20;
/** At or above this height the layout adds blank lines between sections; below it stays compact. */
export const ROOMY_MIN_HEIGHT = 20;
// Lines kept for the list before the peek text takes the rest of the height.
const MIN_LIST_WITH_PEEK = 4;
const BRANCH_PREFIX = "pi-agents/";

export const STATE_ICONS: Record<Exclude<RowState, "working">, { icon: string; role: PaintRole }> = {
  needs_input: { icon: "◆", role: "warning" },
  done: { icon: "◇", role: "success" },
  failed: { icon: "✗", role: "error" },
  stopped: { icon: "∙", role: "dim" },
};

const MESSAGE_ROLES: Record<MessageTone, PaintRole> = { info: "accent", warning: "warning", error: "error" };

function stateLabel(state: RowState): string {
  return GROUP_LABELS[state].toLowerCase();
}

function spinner(frame: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((frame % n) + n) % n]!;
}

function stateIcon(state: RowState, frame: number, paint: Paint): string {
  if (state === "working") return paint("accent", spinner(frame));
  return paint(STATE_ICONS[state].role, STATE_ICONS[state].icon);
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

function ellipsize(text: string, width: number): string {
  return width <= 0 ? "" : truncateToWidth(text, width, "…");
}

function padTo(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

/** `left` and `right` on one line, `right` flush right; `left` is truncated first, `right` dropped if it can't fit. */
function spread(left: string, right: string, width: number): string {
  const rw = visibleWidth(right);
  if (right === "" || rw + 2 > width) return ellipsize(left, width);
  const l = ellipsize(left, width - rw - 2);
  return l + " ".repeat(width - visibleWidth(l) - rw) + right;
}

function joinStyled(parts: string[], paint: Paint): string {
  return parts.join(paint("border", " │ "));
}

function titleLine(view: DashboardView, width: number, paint: Paint): string {
  const { branch, cwd } = view.context;
  const left = (branch ? paint("dim", branch) + " " : "") + cwd;
  const counts = GROUP_ORDER.map((state) => [state, view.rows.filter((r) => r.state === state).length] as const)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => stateIcon(state, view.spinnerFrame, paint) + " " + paint("muted", `${n} ${stateLabel(state)}`));
  return spread(left, joinStyled(counts, paint), width);
}

function actionLine(view: DashboardView, width: number, paint: Paint): string {
  const left = paint("success", view.context.inRepo ? NEW_AGENT_WORKTREE : NEW_AGENT_PLAIN);
  const right = joinStyled(
    ROW_ACTIONS.map(([key, action]) => paint("muted", action) + " " + paint("dim", key)),
    paint,
  );
  return spread(left, view.rows.length > 0 ? right : "", width);
}

function footerLine(hints: readonly Hint[], width: number, paint: Paint): string {
  const text = joinStyled(
    hints.map(([key, action]) => paint("bold", key) + paint("dim", ":" + action)),
    paint,
  );
  return clip(text, width);
}

// --- list ---

interface ListLine {
  text: string;
  selected: boolean;
}

function groupHeader(state: RowState, count: number, width: number, paint: Paint): string {
  const label = `▾ ${GROUP_LABELS[state]} `;
  const n = `${count} `;
  const rule = "─".repeat(Math.max(0, width - visibleWidth(label) - visibleWidth(n)));
  return clip(paint("muted", label) + paint("dim", n) + paint("border", rule), width);
}

/** Display form of an agent name: first letter upper-cased (`fix login test` → `Fix login test`). */
export function displayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function worktreeName(r: Row): string | null {
  if (r.branch === null) return null;
  return r.branch.startsWith(BRANCH_PREFIX) ? r.branch.slice(BRANCH_PREFIX.length) : r.branch;
}

/** Name in bold, then the `worktree` badge and `repo · worktree name` dimmed — whatever fits. */
function rowTitle(r: Row, width: number, paint: Paint): string {
  const name = displayName(r.name);
  const nameW = visibleWidth(name);
  const wt = worktreeName(r);
  const detail = wt !== null ? `${r.repo} · ${wt}` : r.repo;
  const badge = wt !== null ? WORKTREE_BADGE + " " : "";
  const room = width - nameW - 2 - visibleWidth(badge);
  if (room < 6) return paint("bold", ellipsize(name, width));
  return paint("bold", name) + "  " + (badge ? paint("warning", WORKTREE_BADGE) + " " : "") + paint("dim", ellipsize(detail, room));
}

function rowLines(r: Row, selected: boolean, frame: number, width: number, paint: Paint): string[] {
  const bar = selected ? paint("accent", "▌") : " ";
  const inner = width - 1;
  const age = paint("dim", r.age);
  const head = stateIcon(r.state, frame, paint) + " ";
  const titleW = inner - 2 - visibleWidth(r.age) - 2;
  const line1 = titleW >= 4 ? spread(head + rowTitle(r, titleW, paint), age, inner) : ellipsize(head + displayName(r.name), inner);
  const summaryRole: PaintRole = r.state === "needs_input" ? "warning" : r.state === "failed" ? "error" : "dim";
  const line2 = "  " + paint(summaryRole, ellipsize(r.summary, inner - 2));
  return [line1, line2].map((l) => {
    const text = bar + clip(l, inner);
    return selected ? paint("selected", padTo(text, width)) : text;
  });
}

function listLines(view: DashboardView, width: number, paint: Paint, roomy: boolean): ListLine[] {
  if (view.rows.length === 0) return [{ text: paint("dim", ellipsize(EMPTY_HINT, width)), selected: false }];
  const lines: ListLine[] = [];
  const blank = () => lines.push({ text: "", selected: false });
  for (const state of GROUP_ORDER) {
    const group = view.rows.filter((r) => r.state === state);
    if (group.length === 0) continue;
    if (roomy && lines.length > 0) blank();
    lines.push({ text: groupHeader(state, group.length, width, paint), selected: false });
    group.forEach((r, i) => {
      if (roomy && i > 0) blank();
      const selected = r.id === view.selectedId;
      for (const text of rowLines(r, selected, view.spinnerFrame, width, paint)) lines.push({ text, selected });
    });
  }
  return lines;
}

/** `height` lines of `lines`, centred on the selected row when they don't all fit. */
function scrollWindow(lines: ListLine[], height: number): string[] {
  if (height <= 0) return [];
  const sel = lines.findIndex((l) => l.selected);
  const maxStart = Math.max(0, lines.length - height);
  const start = sel < 0 ? 0 : Math.min(Math.max(0, sel - Math.floor((height - 2) / 2)), maxStart);
  return lines.slice(start, start + height).map((l) => l.text);
}

// --- boxes ---

function boxTop(title: string, width: number, paint: Paint): string {
  if (width < 4) return paint("border", "─".repeat(Math.max(0, width)));
  if (title === "") return paint("border", "╭" + "─".repeat(width - 2) + "╮");
  const t = ellipsize(title, width - 6);
  return paint("border", "╭─ ") + paint("bold", t) + paint("border", " " + "─".repeat(Math.max(0, width - 5 - visibleWidth(t))) + "╮");
}

function boxBottom(label: string, width: number, paint: Paint): string {
  if (width < 4) return paint("border", "─".repeat(Math.max(0, width)));
  if (label === "" || visibleWidth(label) > width - 6) return paint("border", "╰" + "─".repeat(width - 2) + "╯");
  return paint("border", "╰" + "─".repeat(width - 5 - visibleWidth(label)) + " ") + paint("dim", label) + paint("border", " ─╯");
}

function boxLine(content: string, width: number, paint: Paint): string {
  if (width < 4) return clip(content, Math.max(0, width));
  const inner = width - 4;
  return paint("border", "│ ") + padTo(clip(content, inner), inner) + paint("border", " │");
}

function inputContent(prompt: string, input: InputLineModel, width: number, paint: Paint): string {
  const avail = Math.max(0, width - visibleWidth(prompt));
  let content: string;
  if (input.render) content = input.render(avail);
  else if (input.value !== "") content = ellipsize(input.value, avail);
  else content = paint("dim", ellipsize(input.placeholder, avail));
  return clip(paint("accent", prompt) + content, width);
}

/** Inner width of a box drawn at `width` (the content area between `│ ` and ` │`). */
function boxInner(width: number): number {
  return width < 4 ? Math.max(0, width) : width - 4;
}

function peekHeader(r: Row): string {
  const parts = [displayName(r.name), r.repo, r.branch ?? "no worktree", stateLabel(r.state), r.model].filter(
    (p): p is string => p !== null && p !== "",
  );
  return parts.filter((p, i) => p !== parts[i - 1]).join(" · ");
}

function peekText(lastText: string | null, loading: boolean, width: number, paint: Paint): string[] {
  if (loading) return [paint("dim", ellipsize("Loading…", width))];
  const text = (lastText ?? "").replace(/\t/g, "  ").trimEnd();
  if (text.trim() === "") return [paint("dim", ellipsize("No output yet", width))];
  return wrapTextWithAnsi(text, width).map((l) => clip(l, width));
}

// --- assembly ---

interface Item {
  text: string;
  priority: number; // lowest is dropped first when the height is too small
}

export function renderDashboard(view: DashboardView, outerWidth: number, height: number, paint: Paint): string[] {
  if (outerWidth < 1 || height < 1) return [];
  const margin = outerWidth >= MARGIN_MIN_WIDTH ? MARGIN : "";
  const width = outerWidth - margin.length;
  const roomy = height >= ROOMY_MIN_HEIGHT;
  const peek = view.peek;
  const spacer = (): Item => ({ text: "", priority: -1 });

  const top: Item[] = [
    { text: titleLine(view, width, paint), priority: 3 },
    { text: actionLine(view, width, paint), priority: 2 },
  ];
  if (roomy) top.push(spacer());

  const bottom: Item[] = [];
  if (view.message) {
    const role = MESSAGE_ROLES[view.message.tone];
    bottom.push({ text: paint(role, ellipsize(view.message.text, width)), priority: 5 });
  }
  let peekBody: string[] = [];
  const peekTail: Item[] = [];
  if (peek) {
    const inner = boxInner(width);
    const question = peek.row.state === "needs_input" ? peek.row.summary : "";
    // The question gets its own highlighted line, so it is not repeated at the end of the text.
    let lastText = peek.lastText;
    if (question !== "" && lastText !== null && lastText.trimEnd().endsWith(question)) {
      lastText = lastText.trimEnd().slice(0, -question.length);
    }
    const onlyQuestion = question !== "" && peek.loading !== true && (lastText ?? "").trim() === "" && peek.lastText !== null;
    peekBody = onlyQuestion ? [] : peekText(lastText, peek.loading === true, inner, paint);
    if (question !== "") {
      peekTail.push({ text: boxLine(paint("warning", ellipsize("▸ " + peek.row.summary, inner)), width, paint), priority: 4 });
    }
    peekTail.push({ text: boxLine(inputContent(REPLY_PROMPT, peek.reply, inner, paint), width, paint), priority: 7 });
    peekTail.push({ text: boxBottom("", width, paint), priority: 2 });
  }
  const inputBox: Item[] = [
    { text: boxTop("", width, paint), priority: 2 },
    { text: boxLine(inputContent(DISPATCH_PROMPT, view.input, boxInner(width), paint), width, paint), priority: peek ? 6 : 7 },
    { text: boxBottom(view.context.modelLabel ?? "", width, paint), priority: 2 },
  ];
  // Pi's editor draws its autocomplete under the input, too; it outranks the list but not the input line.
  const menu: Item[] = (peek ? [] : (view.suggestions?.render(width) ?? [])).map((text) => ({ text, priority: 6 }));
  const hints = peek
    ? PEEK_HINTS
    : menu.length > 0
      ? SUGGESTION_HINTS
      : view.input.value === ""
        ? LIST_HINTS_EMPTY
        : LIST_HINTS_TYPING;
  const footer: Item = { text: footerLine(hints, width, paint), priority: 1 };

  const list = listLines(view, width, paint, roomy);
  const fixed = top.length + bottom.length + inputBox.length + menu.length + 1 + (peek ? 1 + peekTail.length : 0);
  const avail = Math.max(0, height - fixed);
  if (peek) {
    const budget = avail - Math.min(list.length, MIN_LIST_WITH_PEEK);
    const count = Math.max(0, Math.min(budget, PEEK_TEXT_LINES, peekBody.length));
    peekBody = count > 0 ? peekBody.slice(-count) : [];
  }
  const listHeight = Math.max(0, avail - peekBody.length);

  const items: Item[] = [...top];
  const window = scrollWindow(list, listHeight);
  for (const line of window) items.push({ text: line, priority: line === "" ? -1 : 0 });
  for (let i = window.length; i < listHeight; i++) items.push(spacer()); // pins the input box to the bottom
  items.push(...bottom);
  if (peek) {
    items.push({ text: boxTop(peekHeader(peek.row), width, paint), priority: 4 });
    for (const line of peekBody) items.push({ text: boxLine(line, width, paint), priority: 0 });
    items.push(...peekTail);
  }
  items.push(...inputBox, ...menu, footer);

  while (items.length > height) {
    let drop = 0;
    for (let i = 1; i < items.length; i++) if (items[i]!.priority < items[drop]!.priority) drop = i;
    items.splice(drop, 1);
  }
  return items.map((item) => (item.text === "" ? "" : margin + clip(item.text, width)));
}
