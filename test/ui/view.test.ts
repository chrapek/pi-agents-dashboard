import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Row, RowState } from "../../src/state.ts";
import {
  renderDashboard,
  headerCounts,
  plainPaint,
  SPINNER_FRAMES,
  DISPATCH_PLACEHOLDER,
  EMPTY_HINT,
  LIST_FOOTER,
  PEEK_FOOTER,
  PEEK_TEXT_LINES,
  ROOMY_MIN_HEIGHT,
} from "../../src/ui/view.ts";
import type { DashboardView, Paint } from "../../src/ui/view.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
/** Drops the 1-column left margin the renderer adds at widths ≥ 20. */
const unmargin = (s: string): string => (s.startsWith(" ") ? s.slice(1) : s);
const plainLines = (lines: string[]): string[] => lines.map(strip).map(unmargin);
const isSelected = (l: string): boolean => l.trimStart().startsWith("▸ ");

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
  row({ id: "f", name: "old one", state: "stopped", summary: "Exited before starting" }),
  row({ id: "g", name: "older one", state: "stopped", summary: "bye" }),
];

// --- header, groups ---

test("headerCounts lists only non-zero groups in group order", () => {
  assert.equal(headerCounts(mixedRows), "1 needs input · 2 working · 1 done · 1 failed · 2 stopped");
  assert.equal(headerCounts([row({ state: "working" }), row({ state: "done" })]), "1 working · 1 done");
  assert.equal(headerCounts([]), "");
});

test("first line is the Agents header with counts", () => {
  const lines = plainLines(renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 120, 40, plainPaint));
  assert.equal(lines[0], "Agents   1 needs input · 2 working · 1 done · 1 failed · 2 stopped");
});

test("group headers render in group order with counts, rows under their group", () => {
  const lines = plainLines(renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 120, 40, plainPaint));
  const groupLines = lines.filter((l) => /^(Needs input|Working|Done|Failed|Stopped) \(\d+\)$/.test(l));
  assert.deepEqual(groupLines, ["Needs input (1)", "Working (2)", "Done (1)", "Failed (1)", "Stopped (2)"]);
  const idx = (s: string) => lines.findIndex((l) => l.includes(s));
  assert.ok(idx("Working (2)") < idx("add rate limiter"));
  assert.ok(idx("add rate limiter") < idx("bump deps"));
  assert.ok(idx("bump deps") < idx("Done (1)"));
});

test("empty list shows the hint line and the header without counts", () => {
  const lines = plainLines(renderDashboard(view(), 80, 20, plainPaint));
  assert.equal(lines[0], "Agents");
  assert.ok(lines.includes(EMPTY_HINT));
});

// --- rows ---

test("row line: selected marker, icon, name, repo, summary, age right-aligned", () => {
  const lines = plainLines(renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 100, 40, plainPaint));
  const raw = renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 100, 40, plainPaint);
  assert.equal(visibleWidth(raw.find((l) => l.includes("fix login test"))!), 100);
  const sel = lines.find((l) => l.includes("fix login test"))!;
  assert.ok(sel.startsWith("  ▸ ● fix login test"), sel);
  assert.ok(sel.includes("my-app"));
  assert.ok(sel.includes("Should I also update the snapshot?"));
  assert.ok(sel.endsWith("12m"), sel);
  const other = lines.find((l) => l.includes("write docs"))!;
  assert.ok(other.startsWith("    ✓ write docs"), other);
});

test("icons per state", () => {
  const lines = plainLines(renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 100, 40, plainPaint));
  const iconOf = (name: string) => lines.find((l) => l.includes(name))!.slice(4, 5);
  assert.equal(iconOf("fix login test"), "●");
  assert.equal(iconOf("add rate limiter"), SPINNER_FRAMES[0]);
  assert.equal(iconOf("write docs"), "✓");
  assert.equal(iconOf("refactor"), "✗");
  assert.equal(iconOf("old one"), "∙");
});

test("working icon follows the spinner frame", () => {
  for (let frame = 0; frame < 6; frame++) {
    const lines = plainLines(
      renderDashboard(view({ rows: mixedRows, selectedId: "a", spinnerFrame: frame }), 100, 40, plainPaint),
    );
    const line = lines.find((l) => l.includes("add rate limiter"))!;
    assert.equal(line.slice(4, 5), SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
  }
  assert.deepEqual(SPINNER_FRAMES, ["✽", "✻", "✶", "✢"]);
});

test("paint roles: icons and selection use semantic roles", () => {
  const tag: Paint = (role, text) => `<${role}>${text}</${role}>`;
  const lines = renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 140, 40, tag);
  const joined = lines.join("\n");
  assert.ok(joined.includes("<warning>●</warning>"));
  assert.ok(joined.includes(`<accent>${SPINNER_FRAMES[0]}</accent>`));
  assert.ok(joined.includes("<success>✓</success>"));
  assert.ok(joined.includes("<error>✗</error>"));
  assert.ok(joined.includes("<dim>∙</dim>"));
  assert.ok(joined.includes("<accent>▸ </accent>"));
});

test("long name and summary are truncated to fit", () => {
  const long = row({ id: "x", name: "n".repeat(80), summary: "s".repeat(200) });
  const lines = renderDashboard(view({ rows: [long], selectedId: "x" }), 60, 20, plainPaint);
  const line = lines.find((l) => strip(l).includes("nnn"))!;
  assert.equal(visibleWidth(line), 60);
  assert.ok(strip(line).includes("…"));
  assert.ok(strip(line).endsWith("12m"));
});

// --- width ---

test("every line fits the width at many widths, incl. narrow and wide chars", () => {
  const wide = [
    ...mixedRows,
    row({ id: "w1", name: "修复登录测试 🚀🚀", repo: "レポジトリ", summary: "你好世界 ✨ emoji summary 👍", state: "done" }),
    row({ id: "w2", name: "🙂".repeat(30), summary: "x", state: "needs_input" }),
  ];
  const peekText = "最后的输出 🚀 ".repeat(40) + "\nsecond line\n" + "x".repeat(300);
  for (const width of [1, 2, 3, 5, 8, 10, 15, 20, 30, 40, 60, 80, 120, 200]) {
    for (const withPeek of [false, true]) {
      const v = view({
        rows: wide,
        selectedId: "w1",
        spinnerFrame: 2,
        message: { text: "Uncommitted changes in /tmp/some/very/long/path — press ctrl+x again to discard", tone: "warning" },
        input: { value: "a task with 中文 and emoji 🚀 ".repeat(5), placeholder: DISPATCH_PLACEHOLDER },
        peek: withPeek
          ? { row: wide.at(-2)!, lastText: peekText, reply: { value: "ok 👍".repeat(20), placeholder: "" } }
          : null,
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

test("total lines never exceed the height", () => {
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
      assert.ok(lines.length <= height, `height ${height} peek ${withPeek}: ${lines.length}`);
    }
  }
});

test("dispatch input stays visible when the height is tiny", () => {
  const lines = plainLines(renderDashboard(view({ rows: manyRows(10), selectedId: "r0" }), 80, 1, plainPaint));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith("› "));
});

test("short list is not padded; roomy layout spaces header, list, input and footer", () => {
  const lines = plainLines(renderDashboard(view({ rows: [row({ id: "a" })], selectedId: "a" }), 80, 40, plainPaint));
  assert.equal(lines.length, 9);
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Done (1)");
  assert.ok(lines[3]!.includes("fix login test"));
  assert.equal(lines[4], "");
  assert.equal(lines[5], "─".repeat(79));
  assert.ok(lines[6]!.startsWith("› "));
  assert.equal(lines[7], "");
  assert.equal(lines[8], LIST_FOOTER);
});

test("below ROOMY_MIN_HEIGHT the layout is compact: no blank lines", () => {
  const lines = plainLines(
    renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 80, ROOMY_MIN_HEIGHT - 1, plainPaint),
  );
  assert.ok(!lines.includes(""), JSON.stringify(lines));
  assert.equal(lines[1], "Needs input (1)");
});

test("roomy layout separates groups with one blank line", () => {
  const lines = plainLines(renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 100, 40, plainPaint));
  for (const g of ["Working (2)", "Done (1)", "Failed (1)", "Stopped (2)"]) {
    assert.equal(lines[lines.indexOf(g) - 1], "", g);
  }
  assert.equal(lines[lines.indexOf("Needs input (1)") - 1], "", "blank line after the header");
});

test("left margin on every non-blank line at width ≥ 20, none below", () => {
  const wide = renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 80, 40, plainPaint);
  for (const l of wide) assert.ok(l === "" || l.startsWith(" "), JSON.stringify(l));
  const narrow = renderDashboard(view({ rows: mixedRows, selectedId: "a" }), 19, 40, plainPaint);
  assert.equal(narrow[0]!.startsWith("Agents"), true);
});

function visibleIds(lines: string[]): string[] {
  return plainLines(lines)
    .map((l) => /agent (\d+)/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
    .map((n) => `r${n}`);
}

test("scrolling keeps the selection visible at top, middle and bottom", () => {
  const rows = manyRows(50);
  const height = 12; // header + 8 list lines + separator + input + footer
  for (const sel of [0, 1, 7, 8, 25, 41, 48, 49]) {
    const lines = renderDashboard(view({ rows, selectedId: `r${sel}` }), 80, height, plainPaint);
    assert.equal(lines.length, height);
    const ids = visibleIds(lines);
    assert.ok(ids.includes(`r${sel}`), `selected r${sel} not visible: ${ids.join(",")}`);
    const selected = plainLines(lines).find(isSelected)!;
    assert.ok(selected.includes(`agent ${sel} `), selected);
  }
  // top: group header visible; bottom: last row visible
  const top = plainLines(renderDashboard(view({ rows, selectedId: "r0" }), 80, height, plainPaint));
  assert.equal(top[1], "Done (50)");
  const bottom = visibleIds(renderDashboard(view({ rows, selectedId: "r49" }), 80, height, plainPaint));
  assert.equal(bottom.at(-1), "r49");
});

test("scrolling works across group headers", () => {
  const rows = [...manyRows(20, "working"), ...manyRows(20, "done").map((r, i) => ({ ...r, id: `d${i}`, name: `done ${i}` }))];
  const lines = plainLines(renderDashboard(view({ rows, selectedId: "d10" }), 80, 10, plainPaint));
  assert.ok(lines.some((l) => isSelected(l) && l.includes("done 10 ")));
  assert.equal(lines.length, 10);
});

// --- peek ---

test("peek panel: separator, header, last 12 wrapped lines, reply input, peek footer", () => {
  const r = row({ id: "a", state: "needs_input" });
  const lastText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const v = view({
    rows: [r],
    selectedId: "a",
    peek: { row: r, lastText, reply: { value: "yes please", placeholder: "" } },
  });
  const lines = plainLines(renderDashboard(v, 100, 60, plainPaint));
  const sepIdx = lines.findIndex((l) => l.startsWith("── peek "));
  assert.ok(sepIdx > 0);
  assert.equal(visibleWidth(lines[sepIdx]!), 99);
  assert.equal(lines[sepIdx - 1], "");
  assert.equal(
    lines[sepIdx + 1],
    "fix login test · my-app · pi-agents/fix-login-test-3f9a · needs input · claude-opus-5-5",
  );
  assert.equal(lines[sepIdx + 2], "");
  const body = lines.slice(sepIdx + 3, sepIdx + 3 + PEEK_TEXT_LINES);
  assert.deepEqual(body, Array.from({ length: 12 }, (_, i) => `line ${i + 8}`));
  assert.equal(lines[sepIdx + 3 + PEEK_TEXT_LINES], "");
  assert.equal(lines[sepIdx + 4 + PEEK_TEXT_LINES], "reply › yes please");
  assert.equal(lines.at(-1), PEEK_FOOTER);
  assert.equal(PEEK_FOOTER, "↑↓ select · enter send · → attach · esc close peek");
});

test("peek wraps long lastText to the width", () => {
  const r = row({ id: "a" });
  const v = view({ rows: [r], selectedId: "a", peek: { row: r, lastText: "word ".repeat(40).trim(), reply: { value: "", placeholder: "" } } });
  const lines = plainLines(renderDashboard(v, 30, 60, plainPaint));
  const sepIdx = lines.findIndex((l) => l.startsWith("── peek "));
  const body = lines.slice(sepIdx + 2, lines.findIndex((l) => l.startsWith("reply › ")));
  assert.ok(body.length > 1);
  for (const l of body) assert.ok(visibleWidth(l) <= 30);
  assert.equal(body.join(" ").replace(/\s+/g, " ").trim(), "word ".repeat(40).trim());
});

test("peek header omits null parts and shows `no worktree` for a null branch", () => {
  const r = row({ id: "a", repo: "no worktree", branch: null, model: null, state: "working" });
  const v = view({ rows: [r], selectedId: "a", peek: { row: r, lastText: null, reply: { value: "", placeholder: "" } } });
  const lines = plainLines(renderDashboard(v, 80, 60, plainPaint));
  const sepIdx = lines.findIndex((l) => l.startsWith("── peek "));
  assert.equal(lines[sepIdx + 1], "fix login test · no worktree · working");
  assert.equal(lines[sepIdx + 3], "No output yet");
});

test("peek shows Loading… while its text is loading", () => {
  const r = row({ id: "a" });
  const v = view({ rows: [r], selectedId: "a", peek: { row: r, lastText: null, loading: true, reply: { value: "", placeholder: "" } } });
  const lines = plainLines(renderDashboard(v, 80, 60, plainPaint));
  const sepIdx = lines.findIndex((l) => l.startsWith("── peek "));
  assert.equal(lines[sepIdx + 3], "Loading…");
});

test("peek shrinks its text before the list disappears when height is limited", () => {
  const rows = manyRows(10);
  const v = view({ rows, selectedId: "r5", peek: { row: rows[5]!, lastText: "t\n".repeat(30), reply: { value: "", placeholder: "" } } });
  const lines = plainLines(renderDashboard(v, 80, 14, plainPaint));
  assert.equal(lines.length, 14);
  assert.ok(lines.some((l) => isSelected(l) && l.includes("agent 5 ")));
  assert.ok(lines.some((l) => l.startsWith("reply › ")));
});

// --- message, input, footer ---

test("message line sits between the list/peek and the input separator", () => {
  const v = view({ rows: [row({ id: "a" })], selectedId: "a", message: { text: "Dispatched fix login test", tone: "info" } });
  const lines = plainLines(renderDashboard(v, 80, 40, plainPaint));
  const sepIdx = lines.indexOf("─".repeat(79));
  assert.equal(lines[sepIdx - 1], "Dispatched fix login test");
});

test("message tones map to paint roles", () => {
  const tag: Paint = (role, text) => `<${role}>${text}</${role}>`;
  const render = (tone: "info" | "warning" | "error") =>
    renderDashboard(view({ message: { text: "m", tone } }), 80, 40, tag).join("\n");
  assert.ok(render("error").includes("<error>m</error>"));
  assert.ok(render("warning").includes("<warning>m</warning>"));
  assert.ok(render("info").includes("<accent>m</accent>"));
});

test("dispatch input shows the placeholder when empty and the value otherwise", () => {
  const empty = plainLines(renderDashboard(view(), 80, 40, plainPaint));
  assert.ok(empty.includes(`› ${DISPATCH_PLACEHOLDER}`));
  assert.equal(DISPATCH_PLACEHOLDER, "Describe a task for a new agent…");
  const typed = plainLines(renderDashboard(view({ input: { value: "add a feature", placeholder: DISPATCH_PLACEHOLDER } }), 80, 40, plainPaint));
  assert.ok(typed.includes("› add a feature"));
});

test("a focused input's render callback is used for its line", () => {
  const v = view({ input: { value: "x", placeholder: "", render: (w) => `[${w}]` } });
  const lines = plainLines(renderDashboard(v, 40, 40, plainPaint));
  assert.ok(lines.includes("› [37]"));
});

test("footer variants: list mode and peek mode", () => {
  assert.equal(LIST_FOOTER, "↑↓ select · enter attach · space peek · ctrl+x delete · esc close");
  const list = plainLines(renderDashboard(view(), 100, 40, plainPaint));
  assert.equal(list.at(-1), LIST_FOOTER);
  const r = row({ id: "a" });
  const peek = plainLines(renderDashboard(view({ rows: [r], selectedId: "a", peek: { row: r, lastText: "x", reply: { value: "", placeholder: "" } } }), 100, 40, plainPaint));
  assert.equal(peek.at(-1), PEEK_FOOTER);
});
