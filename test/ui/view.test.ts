import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Row, RowState } from "../../src/state.ts";
import {
  renderDashboard,
  headerCounts,
  hintsText,
  displayName,
  plainPaint,
  SPINNER_FRAMES,
  DISPATCH_PLACEHOLDER,
  EMPTY_HINT,
  LIST_HINTS_EMPTY,
  LIST_HINTS_TYPING,
  PEEK_HINTS,
  PEEK_TEXT_LINES,
  ROOMY_MIN_HEIGHT,
  NEW_AGENT_WORKTREE,
  NEW_AGENT_PLAIN,
} from "../../src/ui/view.ts";
import type { DashboardView, HeaderContext, Paint } from "../../src/ui/view.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
/** Drops the 1-column left margin the renderer adds at widths ≥ 20. */
const unmargin = (s: string): string => (s.startsWith(" ") ? s.slice(1) : s);
const plainLines = (lines: string[]): string[] => lines.map(strip).map(unmargin);
const isSelected = (l: string): boolean => l.startsWith("▌");
/** Content of a `│ … │` box line. */
const boxText = (l: string): string => l.slice(2, -2).trimEnd();
/** First line of each selected row (the title line). */
const selectedTitle = (lines: string[]): string | undefined => lines.find(isSelected);

const CONTEXT: HeaderContext = { cwd: "~/www/my-app", branch: "main", inRepo: true, modelLabel: "claude-opus-5-5 (high)" };

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "fix-login-test-3f9a",
    name: "fix login test",
    repo: "my-app",
    branch: "pi-agents/fix-login-test-3f9a",
    state: "done",
    summary: "All tests pass",
    age: "12m",
    createdAt: 1_000,
    model: "claude-opus-5-5",
    alive: true,
    ...overrides,
  };
}

function view(overrides: Partial<DashboardView> = {}): DashboardView {
  return {
    rows: [],
    selectedId: null,
    spinnerFrame: 0,
    peek: null,
    message: null,
    input: { value: "", placeholder: DISPATCH_PLACEHOLDER },
    context: CONTEXT,
    ...overrides,
  };
}

/** n rows in one group, ids r0..r(n-1). */
function manyRows(n: number, state: RowState = "done"): Row[] {
  return Array.from({ length: n }, (_, i) => row({ id: `r${i}`, name: `agent ${i}`, state, createdAt: n - i }));
}

const mixedRows: Row[] = [
  row({ id: "a", name: "fix login test", state: "needs_input", summary: "Should I also update the snapshot?" }),
  row({ id: "b", name: "add rate limiter", state: "working", summary: "bash: npm test", age: "3m" }),
  row({ id: "c", name: "bump deps", state: "working", summary: "Working…", age: "4m" }),
  row({ id: "d", name: "write docs", state: "done", summary: "Docs written" }),
  row({ id: "e", name: "refactor", state: "failed", summary: "Error: boom" }),
  row({ id: "f", name: "old one", state: "stopped", summary: "Exited before starting", branch: null, repo: "no worktree" }),
  row({ id: "g", name: "older one", state: "stopped", summary: "bye" }),
];

const render = (v: Partial<DashboardView>, width = 100, height = 40) =>
  plainLines(renderDashboard(view(v), width, height, plainPaint));

// --- title bar and action line ---

test("headerCounts lists only non-zero groups in group order", () => {
  assert.equal(headerCounts(mixedRows), "1 needs input · 2 working · 1 done · 1 failed · 2 stopped");
  assert.equal(headerCounts([]), "");
});

test("title bar: branch and cwd on the left, icon counts flush right", () => {
  const lines = render({ rows: mixedRows, selectedId: "a" }, 120);
  assert.ok(lines[0]!.startsWith("main ~/www/my-app "), lines[0]);
  assert.ok(lines[0]!.endsWith("◆ 1 needs input │ ✽ 2 working │ ◇ 1 done │ ✗ 1 failed │ ∙ 2 stopped"), lines[0]);
  assert.equal(visibleWidth(lines[0]!), 119);
});

test("title bar without a branch shows only the cwd; no rows means no counts", () => {
  const lines = render({ context: { ...CONTEXT, branch: null } });
  assert.equal(lines[0], "~/www/my-app");
});

test("action line offers a worktree agent in a repo, a plain agent outside", () => {
  assert.equal(render({})[1], NEW_AGENT_WORKTREE);
  assert.equal(render({ context: { ...CONTEXT, inRepo: false } })[1], NEW_AGENT_PLAIN);
  assert.equal(NEW_AGENT_WORKTREE, "+ New Agent in Worktree");
});

test("action line lists row actions on the right once there are rows", () => {
  const lines = render({ rows: mixedRows, selectedId: "a" });
  assert.ok(lines[1]!.endsWith("Peek Space │ Attach → │ Delete ^X"), lines[1]);
});

// --- groups and rows ---

test("group headers: ▾ label, count and a rule to the edge, in group order", () => {
  const lines = render({ rows: mixedRows, selectedId: "a" });
  const headers = lines.filter((l) => l.startsWith("▾ "));
  assert.deepEqual(
    headers.map((l) => l.replace(/ ─+$/, "")),
    ["▾ Needs input 1", "▾ Working 2", "▾ Done 1", "▾ Failed 1", "▾ Stopped 2"],
  );
  for (const h of headers) assert.equal(visibleWidth(h), 99);
});

test("each row is two lines: icon, display name, worktree badge, detail, age; then the summary", () => {
  const lines = render({ rows: mixedRows, selectedId: "a" });
  const i = lines.findIndex((l) => l.includes("Write docs"));
  assert.ok(lines[i]!.startsWith(" ◇ Write docs  worktree my-app · fix-login-test-3f9a"), lines[i]);
  assert.ok(lines[i]!.endsWith("12m"));
  assert.equal(lines[i + 1], "   Docs written");
});

test("a row without a worktree shows `no worktree` and no badge", () => {
  const lines = render({ rows: mixedRows, selectedId: "a" });
  const l = lines.find((x) => x.includes("Old one"))!;
  assert.ok(l.includes("Old one  no worktree"), l);
  assert.ok(!l.includes("worktree my-app"));
});

test("selected row: accent bar on both lines, selectedBg across the full width", () => {
  const tag: Paint = (role, text) => `<${role}>${text}</${role}>`;
  const raw = renderDashboard(view({ rows: mixedRows, selectedId: "d" }), 100, 40, tag);
  const sel = raw.filter((l) => l.includes("<accent>▌</accent>"));
  assert.equal(sel.length, 2);
  for (const l of sel) assert.ok(l.trimStart().startsWith("<selected>"), l);
  // Width with a real ANSI painter: the background must span the whole line.
  const ansi: Paint = (role, text) => (role === "selected" ? `\x1b[48;5;236m${text}\x1b[49m` : `\x1b[33m${text}\x1b[39m`);
  const ansiSel = renderDashboard(view({ rows: mixedRows, selectedId: "d" }), 100, 40, ansi).filter((l) => l.includes("\x1b[48;5;236m"));
  assert.equal(ansiSel.length, 2);
  for (const l of ansiSel) assert.equal(visibleWidth(l), 100);
  const plain = render({ rows: mixedRows, selectedId: "d" });
  assert.equal(plain.filter(isSelected).length, 2);
  assert.ok(selectedTitle(plain)!.startsWith("▌◇ Write docs"));
});

test("icons per state and spinner frames", () => {
  for (let frame = 0; frame < 5; frame++) {
    const lines = render({ rows: mixedRows, selectedId: "a", spinnerFrame: frame });
    const iconOf = (name: string) => lines.find((l) => l.includes(name))!.slice(1, 2);
    assert.equal(iconOf("Fix login test"), "◆");
    assert.equal(iconOf("Add rate limiter"), SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    assert.equal(iconOf("Write docs"), "◇");
    assert.equal(iconOf("Refactor"), "✗");
    assert.equal(iconOf("Old one"), "∙");
  }
});

test("summary roles: needs input warning, failed error, others dim", () => {
  const tag: Paint = (role, text) => `<${role}>${text}</${role}>`;
  const joined = renderDashboard(view({ rows: mixedRows, selectedId: "b" }), 140, 40, tag).join("\n");
  assert.ok(joined.includes("<warning>Should I also update the snapshot?</warning>"));
  assert.ok(joined.includes("<error>Error: boom</error>"));
  assert.ok(joined.includes("<dim>Docs written</dim>"));
});

test("long name and summary are truncated; age stays flush right", () => {
  const long = row({ id: "x", name: "n".repeat(80), summary: "s".repeat(200) });
  const lines = render({ rows: [long], selectedId: "x" }, 60);
  const i = lines.findIndex((l) => l.includes("Nnn"));
  assert.ok(lines[i]!.includes("…") && lines[i]!.trimEnd().endsWith("12m"), lines[i]);
  assert.ok(lines[i + 1]!.includes("…"));
  for (const l of lines) assert.ok(visibleWidth(l) <= 59);
});

test("displayName upper-cases the first letter only", () => {
  assert.equal(displayName("fix login test"), "Fix login test");
  assert.equal(displayName(""), "");
});

test("empty list shows the hint", () => {
  assert.ok(render({}).includes(EMPTY_HINT));
});

// --- spacing and pinning ---

test("roomy layout: blank after the action line, between groups and between rows", () => {
  const lines = render({ rows: mixedRows, selectedId: "a" });
  assert.equal(lines[2], "");
  for (const g of ["▾ Working", "▾ Done", "▾ Failed", "▾ Stopped"]) {
    assert.equal(lines[lines.findIndex((l) => l.startsWith(g)) - 1], "", g);
  }
  const older = lines.findIndex((l) => l.includes("Older one"));
  assert.equal(lines[older - 1], "");
});

test("below ROOMY_MIN_HEIGHT there are no blank lines", () => {
  const lines = render({ rows: manyRows(10), selectedId: "r0" }, 80, ROOMY_MIN_HEIGHT - 1);
  assert.ok(!lines.includes(""), JSON.stringify(lines));
});

test("input box is pinned to the bottom with the model label in its border; hints last", () => {
  const lines = render({ rows: [row({ id: "a" })], selectedId: "a" }, 80, 30);
  assert.equal(lines.length, 30);
  assert.equal(lines.at(-4), "╭" + "─".repeat(77) + "╮");
  assert.ok(lines.at(-3)!.startsWith("│ ❯ " + DISPATCH_PLACEHOLDER), lines.at(-3));
  assert.ok(lines.at(-3)!.endsWith(" │"));
  assert.ok(lines.at(-2)!.endsWith(" claude-opus-5-5 (high) ─╯"), lines.at(-2));
  assert.equal(lines.at(-1), hintsText(LIST_HINTS_EMPTY));
});

test("box border without a model label is plain", () => {
  const lines = render({ context: { ...CONTEXT, modelLabel: null } }, 80, 30);
  assert.equal(lines.at(-2), "╰" + "─".repeat(77) + "╯");
});

test("left margin on every non-blank line at width ≥ 20, none below", () => {
  for (const l of renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 80, 40, plainPaint)) {
    assert.ok(l === "" || l.startsWith(" "), JSON.stringify(l));
  }
  const narrow = renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 19, 40, plainPaint);
  assert.ok(!narrow[0]!.startsWith(" "));
});

// --- width ---

test("every line fits the width at many widths, incl. narrow and wide chars", () => {
  const wide = [
    ...mixedRows,
    row({ id: "w1", name: "修复登录测试 🚀🚀", repo: "レポジトリ", summary: "你好世界 ✨ emoji summary 👍", state: "done" }),
    row({ id: "w2", name: "🙂".repeat(30), summary: "x", state: "needs_input" }),
  ];
  const peekText = "最后的输出 🚀 ".repeat(40) + "\nsecond line\n" + "x".repeat(300);
  for (const width of [1, 2, 3, 4, 5, 8, 10, 15, 20, 30, 40, 60, 80, 120, 200]) {
    for (const withPeek of [false, true]) {
      const v = view({
        rows: wide,
        selectedId: "w1",
        spinnerFrame: 2,
        message: { text: "Uncommitted changes in /tmp/some/very/long/path — press ctrl+x again to discard", tone: "warning" },
        input: { value: "a task with 中文 and emoji 🚀 ".repeat(5), placeholder: DISPATCH_PLACEHOLDER },
        context: { cwd: "~/" + "深".repeat(50), branch: "feature/" + "x".repeat(60), inRepo: true, modelLabel: "m".repeat(90) },
        peek: withPeek ? { row: wide.at(-1)!, lastText: peekText, reply: { value: "ok 👍".repeat(20), placeholder: "" } } : null,
      });
      for (const line of renderDashboard(v, width, 40, plainPaint)) {
        assert.ok(visibleWidth(line) <= width, `width ${width} peek ${withPeek}: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("lines fit width with a styling painter too", () => {
  const ansi: Paint = (_role, text) => `\x1b[33m${text}\x1b[39m`;
  for (const width of [4, 12, 33, 80]) {
    const v = view({ rows: mixedRows, selectedId: "c", message: { text: "Dispatched x", tone: "info" } });
    for (const line of renderDashboard(v, width, 30, ansi)) assert.ok(visibleWidth(line) <= width);
  }
});

// --- height and scrolling ---

test("output is exactly the height (or less for tiny heights), never more", () => {
  for (const height of [0, 1, 2, 3, 4, 5, 6, 8, 10, 15, 25, 60]) {
    for (const withPeek of [false, true]) {
      const rows = manyRows(40);
      const v = view({
        rows,
        selectedId: "r20",
        message: { text: "msg", tone: "info" },
        peek: withPeek ? { row: rows[20]!, lastText: "line\n".repeat(30), reply: { value: "", placeholder: "" } } : null,
      });
      const lines = renderDashboard(v, 80, height, plainPaint);
      assert.equal(lines.length, height, `height ${height} peek ${withPeek}`);
    }
  }
});

test("dispatch input stays visible when the height is tiny", () => {
  const lines = render({ rows: manyRows(10), selectedId: "r0" }, 80, 1);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("❯ " + DISPATCH_PLACEHOLDER), lines[0]);
});

function visibleIds(lines: string[]): string[] {
  return lines
    .map((l) => /Agent (\d+) /.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
    .map((n) => `r${n}`);
}

test("scrolling keeps both lines of the selected row visible at top, middle and bottom", () => {
  const rows = manyRows(50);
  for (const height of [12, 30]) {
    for (const sel of [0, 1, 7, 25, 48, 49]) {
      const lines = render({ rows, selectedId: `r${sel}` }, 80, height);
      assert.equal(lines.length, height);
      assert.ok(visibleIds(lines).includes(`r${sel}`), `h${height} r${sel}`);
      const i = lines.findIndex(isSelected);
      assert.ok(lines[i]!.includes(`Agent ${sel} `));
      assert.ok(isSelected(lines[i + 1]!), `summary line of r${sel} visible at height ${height}`);
    }
  }
  const top = render({ rows, selectedId: "r0" }, 80, 12);
  assert.ok(top.some((l) => l.startsWith("▾ Done 50")));
  assert.equal(visibleIds(render({ rows, selectedId: "r49" }, 80, 12)).at(-1), "r49");
});

test("scrolling works across group headers", () => {
  const rows = [...manyRows(20, "working"), ...manyRows(20, "done").map((r, i) => ({ ...r, id: `d${i}`, name: `done ${i}` }))];
  const lines = render({ rows, selectedId: "d10" }, 80, 14);
  assert.ok(selectedTitle(lines)!.includes("Done 10 "));
  assert.equal(lines.length, 14);
});

// --- peek ---

test("peek box: header in the top border, last 12 wrapped lines, reply, then the input box", () => {
  const r = row({ id: "a", state: "done" });
  const lastText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const lines = render({ rows: [r], selectedId: "a", peek: { row: r, lastText, reply: { value: "yes please", placeholder: "" } } }, 100, 60);
  const top = lines.findIndex((l) => l.startsWith("╭─ "));
  assert.ok(lines[top]!.startsWith("╭─ Fix login test · my-app · pi-agents/fix-login-test-3f9a · done · claude-opus-5-5 ─"), lines[top]);
  assert.ok(lines[top]!.endsWith("╮"));
  const body = lines.slice(top + 1, top + 1 + PEEK_TEXT_LINES).map(boxText);
  assert.deepEqual(body, Array.from({ length: 12 }, (_, i) => `line ${i + 8}`));
  assert.ok(lines[top + 1 + PEEK_TEXT_LINES]!.startsWith("│ reply ❯ yes please"));
  assert.ok(lines[top + 2 + PEEK_TEXT_LINES]!.startsWith("╰"));
  assert.ok(lines[top + 4 + PEEK_TEXT_LINES]!.startsWith("│ ❯ "));
  assert.equal(lines.at(-1), hintsText(PEEK_HINTS));
});

test("peek on a question highlights it with ▸ above the reply and does not repeat it in the text", () => {
  const q = "Should I also update the snapshot?";
  const r = row({ id: "a", state: "needs_input", summary: q });
  const lines = render({ rows: [r], selectedId: "a", peek: { row: r, lastText: `Parser fixed.\n\n${q}`, reply: { value: "", placeholder: "" } } }, 100, 60);
  const top = lines.findIndex((l) => l.startsWith("╭─ "));
  const box = lines.slice(top + 1, lines.findIndex((l, i) => i > top && l.startsWith("│ reply ❯")) + 1).map(boxText);
  assert.deepEqual(box, ["Parser fixed.", `▸ ${q}`, "reply ❯"]);
});

test("peek whose whole text is the question shows just the question line", () => {
  const q = "Which one?";
  const r = row({ id: "a", state: "needs_input", summary: q });
  const lines = render({ rows: [r], selectedId: "a", peek: { row: r, lastText: q, reply: { value: "", placeholder: "" } } }, 100, 60);
  const top = lines.findIndex((l) => l.startsWith("╭─ "));
  assert.equal(boxText(lines[top + 1]!), `▸ ${q}`);
});

test("peek wraps long text to the box width", () => {
  const r = row({ id: "a" });
  const lines = render({ rows: [r], selectedId: "a", peek: { row: r, lastText: "word ".repeat(40).trim(), reply: { value: "", placeholder: "" } } }, 30, 60);
  const top = lines.findIndex((l) => l.startsWith("╭─"));
  const body = lines.slice(top + 1, lines.findIndex((l) => l.startsWith("│ reply ❯"))).map((l) => l.slice(2, -2));
  assert.ok(body.length > 1);
  assert.equal(body.join(" ").replace(/\s+/g, " ").trim(), "word ".repeat(40).trim());
});

test("peek shows Loading… and No output yet", () => {
  const r = row({ id: "a" });
  const loading = render({ rows: [r], selectedId: "a", peek: { row: r, lastText: null, loading: true, reply: { value: "", placeholder: "" } } }, 80, 60);
  assert.ok(loading.some((l) => l.startsWith("│ Loading…")));
  const empty = render({ rows: [r], selectedId: "a", peek: { row: r, lastText: null, reply: { value: "", placeholder: "" } } }, 80, 60);
  assert.ok(empty.some((l) => l.startsWith("│ No output yet")));
});

test("peek shrinks its text before the list disappears when height is limited", () => {
  const rows = manyRows(10);
  const lines = render({ rows, selectedId: "r5", peek: { row: rows[5]!, lastText: "t\n".repeat(30), reply: { value: "", placeholder: "" } } }, 80, 18);
  assert.equal(lines.length, 18);
  assert.ok(selectedTitle(lines)?.includes("Agent 5 "));
  assert.ok(lines.some((l) => l.startsWith("│ reply ❯")));
});

// --- message, input, hints ---

test("message line sits right above the input box", () => {
  const lines = render({ rows: [row({ id: "a" })], selectedId: "a", message: { text: "Dispatched fix login test", tone: "info" } }, 80, 30);
  assert.equal(lines.at(-5), "Dispatched fix login test");
});

test("message tones map to paint roles", () => {
  const tag: Paint = (role, text) => `<${role}>${text}</${role}>`;
  const out = (tone: "info" | "warning" | "error") => renderDashboard(view({ message: { text: "m", tone } }), 80, 40, tag).join("\n");
  assert.ok(out("error").includes("<error>m</error>"));
  assert.ok(out("warning").includes("<warning>m</warning>"));
  assert.ok(out("info").includes("<accent>m</accent>"));
});

test("dispatch input shows the placeholder when empty and the value otherwise", () => {
  assert.equal(DISPATCH_PLACEHOLDER, "Dispatch a new agent");
  const typed = render({ input: { value: "add a feature", placeholder: DISPATCH_PLACEHOLDER } }, 80, 30);
  assert.ok(typed.at(-3)!.startsWith("│ ❯ add a feature "));
});

test("a focused input's render callback gets the width inside the box", () => {
  const lines = render({ input: { value: "x", placeholder: "", render: (w) => `[${w}]` } }, 40, 30);
  assert.ok(lines.at(-3)!.startsWith("│ ❯ [33]"), lines.at(-3)); // 39 - 4 (box) - 2 (prompt)
});

test("hints follow the mode: empty input, typing, peek", () => {
  assert.equal(render({}).at(-1), "↑↓:select │ Enter:attach │ Esc:close");
  assert.equal(render({ input: { value: "x", placeholder: "" } }).at(-1), hintsText(LIST_HINTS_TYPING));
  assert.equal(hintsText(LIST_HINTS_TYPING), "Enter:create │ ⇧Enter:create + attach │ Esc:clear");
  assert.equal(hintsText(PEEK_HINTS), "↑↓:select │ Enter:send │ →:attach │ Esc:close peek");
});
