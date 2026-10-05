import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import type { Row } from "../../src/state.ts";
import type { AgentMeta, AgentStatus } from "../../src/store.ts";
import { TmuxNotFoundError } from "../../src/tmux.ts";
import { Dashboard } from "../../src/ui/dashboard.ts";
import type { DashboardOptions } from "../../src/ui/dashboard.ts";
import type { DashboardResult, DashboardService } from "../../src/ui/service-types.ts";
import { SPINNER_FRAMES, EMPTY_HINT, LIST_HINTS_EMPTY, PEEK_HINTS, hintsText } from "../../src/ui/view.ts";
import type { HeaderContext } from "../../src/ui/view.ts";

const LIST_FOOTER = hintsText(LIST_HINTS_EMPTY);
const PEEK_FOOTER = hintsText(PEEK_HINTS);
const CONTEXT: HeaderContext = { cwd: "~/repo", branch: "main", inRepo: true, modelLabel: "model-x (high)" };
/** Content of a `│ … │` box line. */
const boxText = (l: string): string => l.slice(2, -2).trimEnd();
/** Index of the peek box top border (`╭─ <header> ─…╮`), -1 when peek is closed. */
const peekTop = (lines: string[]): number => lines.findIndex((l) => l.startsWith("╭─ "));

// Real key sequences as delivered by the terminal.
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  shiftEnter: "\x1b[13;2u", // CSI-u (kitty keyboard protocol)
  shiftEnterModifyOtherKeys: "\x1b[27;2;13~", // xterm / tmux modifyOtherKeys
  shiftEnterKittyLf: "\n", // LF reported for shift+enter while the kitty protocol is active
  right: "\x1b[C",
  space: " ",
  esc: "\x1b",
  ctrlX: "\x18",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.split(CURSOR_MARKER).join("").replace(ANSI_RE, "");

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    name: `agent ${id}`,
    repo: "my-app",
    branch: `pi-agents/${id}`,
    state: "done",
    summary: `summary ${id}`,
    age: "1m",
    createdAt: 0,
    model: "model-x",
    alive: true,
    ...overrides,
  };
}

function metaFor(r: Row): AgentMeta {
  return {
    id: r.id,
    name: r.name,
    prompt: r.name,
    createdAt: r.createdAt,
    launchCwd: "/repo",
    cwd: `/wt/${r.id}`,
    repoRoot: "/repo",
    worktree: `/wt/${r.id}`,
    branch: r.branch,
  };
}

function statusFor(text: string): AgentStatus {
  return {
    phase: "idle",
    activity: null,
    lastText: text,
    lastOutcome: "completed",
    uiPrompt: null,
    sessionFile: null,
    pid: null,
    model: "model-x",
    updatedAt: 0,
  };
}

type Call = [string, ...unknown[]];

/** Records every call; behaviour is scripted through the public fields. */
class FakeService implements DashboardService {
  rows: Row[];
  calls: Call[] = [];
  snapshotError: Error | null = null;
  peekError: Error | null = null;
  lastText: Record<string, string> = {};
  dispatchResult: (prompt: string) => Promise<AgentMeta> = async (prompt) => {
    const r = row("new-agent-1234", { name: "new agent", state: "working" });
    this.rows = [r, ...this.rows];
    return { ...metaFor(r), prompt };
  };
  replyResult: () => Promise<"queued" | "restarted"> = async () => "queued";
  ensureResult: () => Promise<void> = async () => {};
  removeResult: (id: string, force: boolean) => Promise<{ removed: boolean; dirty?: string; branchKept?: string }> =
    async (id) => {
      this.rows = this.rows.filter((r) => r.id !== id);
      return { removed: true };
    };

  constructor(rows: Row[]) {
    this.rows = rows;
  }
  count(name: string): number {
    return this.calls.filter((c) => c[0] === name).length;
  }
  only(name: string): Call[] {
    return this.calls.filter((c) => c[0] === name);
  }
  async snapshot(): Promise<Row[]> {
    this.calls.push(["snapshot"]);
    if (this.snapshotError) throw this.snapshotError;
    return this.rows.slice();
  }
  async peek(id: string) {
    this.calls.push(["peek", id]);
    if (this.peekError) throw this.peekError;
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    return { meta: metaFor(r), status: statusFor(this.lastText[id] ?? `output of ${id}`), row: r };
  }
  dispatch(prompt: string, launchCwd: string): Promise<AgentMeta> {
    this.calls.push(["dispatch", prompt, launchCwd]);
    return this.dispatchResult(prompt);
  }
  reply(id: string, text: string): Promise<"queued" | "restarted"> {
    this.calls.push(["reply", id, text]);
    return this.replyResult();
  }
  ensureRunning(id: string): Promise<void> {
    this.calls.push(["ensureRunning", id]);
    return this.ensureResult();
  }
  remove(id: string, force: boolean) {
    this.calls.push(["remove", id, force]);
    return this.removeResult(id, force);
  }
}

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

/** Lets every already-resolved promise chain run to completion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Harness {
  d: Dashboard;
  svc: FakeService;
  results: DashboardResult[];
  clock: { t: number };
  dirty: Set<string>;
  renders: () => number;
  press: (key: string) => Promise<void>;
  screen: (width?: number) => string[];
  selected: () => string | undefined;
  message: () => string | undefined;
}

async function setup(rows: Row[], opts: Partial<DashboardOptions> = {}, svc = new FakeService(rows)): Promise<Harness> {
  const results: DashboardResult[] = [];
  const clock = { t: 1_000_000 };
  const dirty = new Set<string>();
  let renders = 0;
  const d = new Dashboard({
    service: svc,
    launchCwd: "/repo/sub",
    context: CONTEXT,
    theme,
    done: (r) => results.push(r),
    requestRender: () => renders++,
    height: () => 40,
    refreshMs: 60_000,
    doubleKeyMs: 2000,
    now: () => clock.t,
    isDirty: async (p) => dirty.has(p),
    ...opts,
  });
  await d.refresh();
  await settle();
  // Drop the renderer's 1-column left margin so assertions read like the layout.
  const screen = (width = 100) => d.render(width).map(strip).map((l) => (l.startsWith(" ") ? l.slice(1) : l));
  const lines = () => screen();
  const h: Harness = {
    d,
    svc,
    results,
    clock,
    dirty,
    renders: () => renders,
    press: async (key) => {
      d.handleInput(key);
      await settle();
    },
    screen,
    // Title line of the selected row: `▌<icon> <Display name>  worktree …   <age>`.
    selected: () =>
      lines()
        .find((l) => l.startsWith("▌"))
        ?.replace(/^▌. /, "")
        .split("  ")[0],
    // The message line sits right above the box(es) at the bottom.
    message: () => {
      const ls = lines();
      const firstBox = ls.findIndex((l) => l.startsWith("╭"));
      const above = ls[firstBox - 1];
      const isOther =
        above === undefined || above === "" || above === EMPTY_HINT || /^[ ▌▾]/.test(above);
      return isOther ? undefined : above;
    },
  };
  return h;
}

const three = () => [row("a"), row("b"), row("c")];

async function typeText(h: Harness, text: string) {
  await h.press(text);
}

function inputValue(h: Harness): string {
  return boxText(h.screen().find((l) => l.startsWith("│ ❯ "))!).slice(2);
}

// --- refresh & selection ---

test("initial refresh shows the rows and selects the first row", async () => {
  const h = await setup(three());
  assert.ok(h.svc.count("snapshot") >= 1);
  assert.equal(h.selected(), "Agent a");
  assert.ok(h.renders() > 0);
  h.d.dispose();
});

test("initialSelectedId selects that row", async () => {
  const h = await setup(three(), { initialSelectedId: "c" });
  assert.equal(h.selected(), "Agent c");
  h.d.dispose();
});

test("refresh keeps the selection by id when rows reorder", async () => {
  const h = await setup(three());
  await h.press(KEY.down);
  assert.equal(h.selected(), "Agent b");
  h.svc.rows = [row("x"), row("c"), row("b"), row("a")];
  await h.d.refresh();
  assert.equal(h.selected(), "Agent b");
  h.d.dispose();
});

test("refresh falls back to the nearest index when the selected row disappears", async () => {
  const h = await setup(three());
  await h.press(KEY.down);
  await h.press(KEY.down);
  assert.equal(h.selected(), "Agent c");
  h.svc.rows = [row("a"), row("b")];
  await h.d.refresh();
  assert.equal(h.selected(), "Agent b");
  h.svc.rows = [];
  await h.d.refresh();
  assert.equal(h.selected(), undefined);
  h.svc.rows = [row("z")];
  await h.d.refresh();
  assert.equal(h.selected(), "Agent z");
  h.d.dispose();
});

test("spinner advances one frame per refresh", async () => {
  const h = await setup([row("w", { state: "working" })]);
  const icon = () => h.screen().find((l) => l.includes("Agent w"))!.slice(1, 2);
  const first = SPINNER_FRAMES.indexOf(icon());
  assert.ok(first >= 0);
  for (let i = 1; i <= 5; i++) {
    await h.d.refresh();
    assert.equal(icon(), SPINNER_FRAMES[(first + i) % SPINNER_FRAMES.length]);
  }
  h.d.dispose();
});

test("timer refreshes every refreshMs and is cleared on dispose", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const h = await setup(three(), { refreshMs: 1000 });
    const before = h.svc.count("snapshot");
    mock.timers.tick(1000);
    await settle();
    mock.timers.tick(1000);
    await settle();
    assert.equal(h.svc.count("snapshot"), before + 2);
    h.d.dispose();
    mock.timers.tick(5000);
    await settle();
    assert.equal(h.svc.count("snapshot"), before + 2);
  } finally {
    mock.timers.reset();
  }
});

test("the constructor starts the first refresh and an unref'd timer; dispose and done clear it", async () => {
  for (const finish of ["dispose", "esc"] as const) {
    const handles: unknown[] = [];
    const cleared: unknown[] = [];
    const realSetInterval = globalThis.setInterval;
    const setSpy = mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      handles.push(handle);
      return handle;
    });
    const clearSpy = mock.method(globalThis, "clearInterval", (handle: NodeJS.Timeout) => {
      cleared.push(handle);
    });
    try {
      const svc = new FakeService(three());
      const d = new Dashboard({
        service: svc,
        launchCwd: "/repo",
        context: CONTEXT,
        theme,
        done: () => {},
        requestRender: () => {},
        height: () => 40,
        refreshMs: 60_000,
      });
      assert.equal(svc.count("snapshot"), 1);
      assert.equal(handles.length, 1);
      assert.equal((handles[0] as NodeJS.Timeout).hasRef(), false);
      await d.refresh();
      if (finish === "dispose") d.dispose();
      else d.handleInput(KEY.esc);
      assert.deepEqual(cleared, handles);
    } finally {
      setSpy.mock.restore();
      clearSpy.mock.restore();
      for (const h of handles) clearInterval(h as NodeJS.Timeout);
    }
  }
});

test("timer is cleared when the dashboard closes", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const h = await setup(three(), { refreshMs: 1000 });
    await h.press(KEY.esc);
    assert.deepEqual(h.results, [{ type: "close" }]);
    const before = h.svc.count("snapshot");
    mock.timers.tick(5000);
    await settle();
    assert.equal(h.svc.count("snapshot"), before);
  } finally {
    mock.timers.reset();
  }
});

test("snapshot errors surface on the message line without crashing", async () => {
  const svc = new FakeService(three());
  svc.snapshotError = new Error("tmux list-sessions failed: boom");
  const h = await setup([], {}, svc);
  assert.equal(h.message(), "tmux list-sessions failed: boom");
  svc.snapshotError = null;
  await h.d.refresh();
  assert.equal(h.selected(), "Agent a");
  h.d.dispose();
});

test("render fits width and height", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(`r${i}`));
  const h = await setup(rows, { height: () => 15 });
  for (const width of [10, 40, 100]) {
    const lines = h.d.render(width);
    assert.ok(lines.length <= 15);
    for (const l of lines) assert.ok(visibleWidth(l) <= width);
  }
  h.d.dispose();
});

// --- list mode keys ---

test("↓ and ↑ move the selection and stop at the ends", async () => {
  const h = await setup(three());
  await h.press(KEY.down);
  assert.equal(h.selected(), "Agent b");
  await h.press(KEY.down);
  await h.press(KEY.down);
  assert.equal(h.selected(), "Agent c");
  await h.press(KEY.up);
  assert.equal(h.selected(), "Agent b");
  await h.press(KEY.up);
  await h.press(KEY.up);
  assert.equal(h.selected(), "Agent a");
  h.d.dispose();
});

test("Enter with empty input ensures the session runs, then resolves attach", async () => {
  const h = await setup(three());
  await h.press(KEY.down);
  await h.press(KEY.enter);
  assert.deepEqual(h.svc.only("ensureRunning"), [["ensureRunning", "b"]]);
  assert.deepEqual(h.results, [{ type: "attach", id: "b" }]);
  h.d.dispose();
});

test("attach error shows the message and stays open", async () => {
  const h = await setup(three());
  h.svc.ensureResult = async () => {
    throw new Error("tmux new-session failed: no space");
  };
  await h.press(KEY.enter);
  assert.deepEqual(h.results, []);
  assert.equal(h.message(), "tmux new-session failed: no space");
  h.d.dispose();
});

test("Enter with text dispatches, clears the input, selects the new row", async () => {
  const h = await setup(three());
  await typeText(h, "  add a rate limiter  ");
  await h.press(KEY.enter);
  assert.deepEqual(h.svc.only("dispatch"), [["dispatch", "add a rate limiter", "/repo/sub"]]);
  assert.equal(h.selected(), "New agent");
  assert.equal(h.message(), "Dispatched new agent");
  assert.ok(inputValue(h).startsWith("Dispatch a new agent"));
  assert.deepEqual(h.results, []);
  h.d.dispose();
});

test("dispatch error keeps the input and shows the message", async () => {
  const h = await setup(three());
  h.svc.dispatchResult = async () => {
    throw new Error("git worktree add failed: fatal: bad");
  };
  await typeText(h, "do it");
  await h.press(KEY.enter);
  assert.equal(h.message(), "git worktree add failed: fatal: bad");
  assert.equal(inputValue(h).trimEnd(), "do it");
  h.d.dispose();
});

test("a second Enter while a dispatch is in flight does not dispatch twice", async () => {
  const h = await setup(three());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = h.svc.dispatchResult;
  h.svc.dispatchResult = async (p) => {
    await gate;
    return original(p);
  };
  await typeText(h, "task");
  await h.press(KEY.enter);
  await h.press(KEY.enter);
  release();
  await settle();
  await settle();
  assert.equal(h.svc.count("dispatch"), 1);
  h.d.dispose();
});

test("Shift+Enter with text dispatches and then attaches to the new agent", async () => {
  const h = await setup(three());
  await typeText(h, "write docs");
  await h.press(KEY.shiftEnter);
  assert.deepEqual(h.svc.only("dispatch"), [["dispatch", "write docs", "/repo/sub"]]);
  assert.deepEqual(h.svc.only("ensureRunning"), [["ensureRunning", "new-agent-1234"]]);
  assert.deepEqual(h.results, [{ type: "attach", id: "new-agent-1234" }]);
  h.d.dispose();
});

test("Shift+Enter in the xterm/tmux modifyOtherKeys form dispatches and attaches", async () => {
  const h = await setup(three());
  await typeText(h, "write docs");
  await h.press(KEY.shiftEnterModifyOtherKeys);
  assert.deepEqual(h.svc.only("dispatch"), [["dispatch", "write docs", "/repo/sub"]]);
  assert.deepEqual(h.results, [{ type: "attach", id: "new-agent-1234" }]);
  h.d.dispose();
});

test("Shift+Enter as LF with the kitty protocol active dispatches and attaches", async () => {
  setKittyProtocolActive(true);
  try {
    const h = await setup(three());
    await typeText(h, "write docs");
    await h.press(KEY.shiftEnterKittyLf);
    assert.deepEqual(h.svc.only("dispatch"), [["dispatch", "write docs", "/repo/sub"]]);
    assert.deepEqual(h.results, [{ type: "attach", id: "new-agent-1234" }]);
    h.d.dispose();
  } finally {
    setKittyProtocolActive(false);
  }
});

test("text typed while a dispatch is in flight is kept", async () => {
  const h = await setup(three());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = h.svc.dispatchResult;
  h.svc.dispatchResult = async (p) => {
    await gate;
    return original(p);
  };
  await typeText(h, "task");
  await h.press(KEY.enter);
  await typeText(h, " next");
  release();
  await settle();
  await settle();
  assert.equal(h.svc.count("dispatch"), 1);
  assert.equal(h.message(), "Dispatched new agent");
  assert.equal(inputValue(h).trimEnd(), "task next");
  h.d.dispose();
});

test("Shift+Enter with empty input attaches like Enter", async () => {
  const h = await setup(three());
  await h.press(KEY.shiftEnter);
  assert.equal(h.svc.count("dispatch"), 0);
  assert.deepEqual(h.results, [{ type: "attach", id: "a" }]);
  h.d.dispose();
});

test("→ with empty input attaches", async () => {
  const h = await setup(three());
  await h.press(KEY.right);
  assert.deepEqual(h.svc.only("ensureRunning"), [["ensureRunning", "a"]]);
  assert.deepEqual(h.results, [{ type: "attach", id: "a" }]);
  h.d.dispose();
});

test("→ with text edits the input instead of attaching", async () => {
  const h = await setup(three());
  await typeText(h, "abc");
  await h.press(KEY.right);
  assert.equal(h.svc.count("ensureRunning"), 0);
  assert.deepEqual(h.results, []);
  assert.equal(inputValue(h).trimEnd(), "abc");
  h.d.dispose();
});

test("Enter/→ with no rows do nothing", async () => {
  const h = await setup([]);
  await h.press(KEY.enter);
  await h.press(KEY.right);
  await h.press(KEY.space);
  await h.press(KEY.ctrlX);
  assert.deepEqual(h.results, []);
  assert.equal(h.svc.count("ensureRunning") + h.svc.count("peek") + h.svc.count("remove"), 0);
  h.d.dispose();
});

test("Space with empty input opens peek for the selected row", async () => {
  const h = await setup(three());
  await h.press(KEY.down);
  await h.press(KEY.space);
  assert.deepEqual(h.svc.only("peek"), [["peek", "b"]]);
  const lines = h.screen();
  const top = peekTop(lines);
  assert.ok(top > 0);
  assert.ok(lines[top]!.startsWith("╭─ Agent b · my-app · pi-agents/b · done · model-x ─"), lines[top]);
  assert.equal(boxText(lines[top + 1]!), "output of b");
  assert.ok(lines.some((l) => l.startsWith("│ reply ❯ ")));
  assert.equal(lines.at(-1), PEEK_FOOTER);
  h.d.dispose();
});

test("Space with text types a space", async () => {
  const h = await setup(three());
  await typeText(h, "a");
  await h.press(KEY.space);
  await typeText(h, "b");
  assert.equal(h.svc.count("peek"), 0);
  assert.equal(inputValue(h).trimEnd(), "a b");
  h.d.dispose();
});

test("Esc with text clears the input", async () => {
  const h = await setup(three());
  await typeText(h, "draft");
  await h.press(KEY.esc);
  assert.deepEqual(h.results, []);
  assert.ok(inputValue(h).startsWith("Dispatch a new agent"));
  h.d.dispose();
});

test("Esc with empty input closes the dashboard", async () => {
  const h = await setup(three());
  await h.press(KEY.esc);
  assert.deepEqual(h.results, [{ type: "close" }]);
  h.d.dispose();
});

// --- Ctrl+X ---

test("Ctrl+X on a clean worktree: first press asks, second deletes", async () => {
  const h = await setup(three());
  await h.press(KEY.ctrlX);
  assert.equal(h.message(), "Press ctrl+x again to delete agent a");
  assert.equal(h.svc.count("remove"), 0);
  h.clock.t += 1500;
  await h.press(KEY.ctrlX);
  assert.deepEqual(h.svc.only("remove"), [["remove", "a", false]]);
  assert.equal(h.message(), "Deleted agent a");
  assert.ok(!h.screen().some((l) => l.includes("agent a ")));
  h.d.dispose();
});

test("Ctrl+X on a dirty worktree warns, second press forces removal", async () => {
  const h = await setup(three());
  h.dirty.add("/wt/a");
  await h.press(KEY.ctrlX);
  assert.equal(h.message(), "Uncommitted changes in /wt/a — press ctrl+x again to discard");
  await h.press(KEY.ctrlX);
  assert.deepEqual(h.svc.only("remove"), [["remove", "a", true]]);
  h.d.dispose();
});

test("Ctrl+X reports a kept branch", async () => {
  const h = await setup(three());
  h.svc.removeResult = async () => ({ removed: true, branchKept: "pi-agents/a" });
  await h.press(KEY.ctrlX);
  await h.press(KEY.ctrlX);
  assert.equal(h.message(), "Deleted agent a · Branch kept: pi-agents/a");
  h.d.dispose();
});

test("Ctrl+X window expiry disarms: a late second press only re-arms", async () => {
  const h = await setup(three());
  await h.press(KEY.ctrlX);
  h.clock.t += 2001;
  await h.press(KEY.ctrlX);
  assert.equal(h.svc.count("remove"), 0);
  assert.equal(h.message(), "Press ctrl+x again to delete agent a");
  await h.press(KEY.ctrlX);
  assert.deepEqual(h.svc.only("remove"), [["remove", "a", false]]);
  h.d.dispose();
});

test("Ctrl+X window starts when the prompt is shown, even after a slow dirty check", async () => {
  let release!: (dirty: boolean) => void;
  let checks = 0;
  const isDirty = () => {
    checks++;
    return new Promise<boolean>((r) => (release = r));
  };
  const h = await setup(three(), { isDirty });
  await h.press(KEY.ctrlX);
  assert.equal(h.message(), undefined);
  h.clock.t += 3000; // longer than doubleKeyMs
  await h.d.refresh(); // the 1 s refresh must not expire an arm whose check is still running
  await typeText(h, "x");
  await h.press(KEY.ctrlX); // pressed again before the prompt: ignored, no second check
  assert.equal(checks, 1);
  assert.equal(h.svc.count("remove"), 0);
  release(true);
  await settle();
  assert.equal(h.message(), "Uncommitted changes in /wt/a — press ctrl+x again to discard");
  h.clock.t += 1500;
  await h.press(KEY.ctrlX);
  assert.deepEqual(h.svc.only("remove"), [["remove", "a", true]]);
  h.d.dispose();
});

test("Ctrl+X expiry clears the prompt on the next refresh", async () => {
  const h = await setup(three());
  await h.press(KEY.ctrlX);
  h.clock.t += 2001;
  await h.d.refresh();
  assert.equal(h.message(), undefined);
  h.d.dispose();
});

test("Ctrl+X re-arms with the dirty message when remove reports the worktree became dirty", async () => {
  const h = await setup(three());
  h.svc.removeResult = async (_id, force) => (force ? { removed: true } : { removed: false, dirty: "/wt/a" });
  await h.press(KEY.ctrlX);
  await h.press(KEY.ctrlX);
  assert.equal(h.message(), "Uncommitted changes in /wt/a — press ctrl+x again to discard");
  await h.press(KEY.ctrlX);
  assert.deepEqual(h.svc.only("remove"), [
    ["remove", "a", false],
    ["remove", "a", true],
  ]);
  assert.equal(h.message(), "Deleted agent a");
  h.d.dispose();
});

test("Ctrl+X is disarmed by a selection change", async () => {
  const h = await setup(three());
  await h.press(KEY.ctrlX);
  await h.press(KEY.down);
  assert.equal(h.message(), undefined);
  await h.press(KEY.up);
  await h.press(KEY.ctrlX);
  assert.equal(h.svc.count("remove"), 0);
  assert.equal(h.message(), "Press ctrl+x again to delete agent a");
  h.d.dispose();
});

test("Ctrl+X prompt survives other keypresses while armed", async () => {
  const h = await setup(three());
  await h.press(KEY.ctrlX);
  await typeText(h, "x");
  assert.equal(h.message(), "Press ctrl+x again to delete agent a");
  h.d.dispose();
});

test("Ctrl+X remove errors surface and disarm", async () => {
  const h = await setup(three());
  h.svc.removeResult = async () => {
    throw new Error("git worktree remove failed: locked");
  };
  await h.press(KEY.ctrlX);
  await h.press(KEY.ctrlX);
  assert.equal(h.message(), "git worktree remove failed: locked");
  await h.press(KEY.ctrlX);
  assert.equal(h.svc.count("remove"), 1);
  h.d.dispose();
});

test("Ctrl+X peek error surfaces and does not arm", async () => {
  const h = await setup(three());
  h.svc.peekError = new Error("read failed: EACCES");
  await h.press(KEY.ctrlX);
  assert.equal(h.message(), "read failed: EACCES");
  h.svc.peekError = null;
  await h.press(KEY.ctrlX);
  assert.equal(h.svc.count("remove"), 0);
  h.d.dispose();
});

// --- messages ---

test("the message line clears on the next keypress", async () => {
  const h = await setup(three());
  await typeText(h, "x");
  await h.press(KEY.enter);
  assert.equal(h.message(), "Dispatched new agent");
  await h.press(KEY.down);
  assert.equal(h.message(), undefined);
  h.d.dispose();
});

// --- tmux missing ---

test("tmux not found shows the message and disables dispatch", async () => {
  const svc = new FakeService(three());
  svc.snapshotError = new TmuxNotFoundError();
  const h = await setup([], {}, svc);
  assert.equal(h.message(), "tmux not found — install tmux ≥ 3.5");
  await typeText(h, "a task");
  await h.press(KEY.enter);
  await h.press(KEY.shiftEnter);
  assert.equal(svc.count("dispatch"), 0);
  assert.equal(h.message(), "tmux not found — install tmux ≥ 3.5");
  assert.equal(inputValue(h).trimEnd(), "a task");
  // tmux installed again → dispatch works
  svc.snapshotError = null;
  await h.d.refresh();
  await h.press(KEY.enter);
  assert.equal(svc.count("dispatch"), 1);
  h.d.dispose();
});

// --- peek mode keys ---

async function openPeek(h: Harness) {
  await h.press(KEY.space);
}

function peekHeader(h: Harness): string | undefined {
  const lines = h.screen();
  const top = peekTop(lines);
  return top < 0 ? undefined : lines[top]!.replace(/^╭─ /, "").replace(/ ─+╮$/, "");
}

test("peek: ↓/↑ move the selection and the peek follows", async () => {
  const h = await setup(three());
  await openPeek(h);
  await h.press(KEY.down);
  assert.equal(h.selected(), "Agent b");
  assert.ok(peekHeader(h)!.startsWith("Agent b · "));
  await h.press(KEY.down);
  await h.press(KEY.up);
  assert.ok(peekHeader(h)!.startsWith("Agent b · "));
  assert.deepEqual(h.svc.only("peek").map((c) => c[1]), ["a", "b", "c", "b"]);
  h.d.dispose();
});

test("peek: refresh re-reads the peeked agent", async () => {
  const h = await setup(three());
  await openPeek(h);
  h.svc.lastText.a = "fresh output";
  await h.d.refresh();
  assert.ok(h.screen().some((l) => l.startsWith("│ ") && boxText(l) === "fresh output"));
  h.d.dispose();
});

test("peek: Enter sends a non-empty reply and clears the reply input", async () => {
  const h = await setup(three());
  await openPeek(h);
  await typeText(h, "yes, update it");
  await h.press(KEY.enter);
  assert.deepEqual(h.svc.only("reply"), [["reply", "a", "yes, update it"]]);
  assert.equal(h.message(), "Reply sent");
  assert.ok(h.screen().some((l) => l.startsWith("│ ") && boxText(l) === "reply ❯"));
  assert.equal(h.svc.count("dispatch"), 0);
  h.d.dispose();
});

test("peek: text typed while a reply is in flight is kept", async () => {
  const h = await setup(three());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.svc.replyResult = async () => {
    await gate;
    return "queued";
  };
  await openPeek(h);
  await typeText(h, "yes");
  await h.press(KEY.enter);
  await typeText(h, " and more");
  release();
  await settle();
  assert.deepEqual(h.svc.only("reply"), [["reply", "a", "yes"]]);
  assert.equal(h.message(), "Reply sent");
  assert.ok(h.screen().some((l) => l.startsWith("│ ") && boxText(l) === "reply ❯ yes and more"));
  h.d.dispose();
});

test("peek: moving the selection clears the reply draft", async () => {
  const h = await setup(three());
  await openPeek(h);
  await typeText(h, "meant for a");
  await h.press(KEY.down);
  assert.ok(h.screen().some((l) => l.startsWith("│ ") && boxText(l) === "reply ❯"));
  await h.press(KEY.enter);
  assert.equal(h.svc.count("reply"), 0);
  h.d.dispose();
});

test("peek: shows Loading… until the first peek for the selected row resolves", async () => {
  const h = await setup(three());
  const gates: Array<() => void> = [];
  const realPeek = h.svc.peek.bind(h.svc);
  h.svc.peek = async (id: string) => {
    await new Promise<void>((r) => gates.push(r));
    return realPeek(id);
  };
  const body = () => {
    const lines = h.screen();
    return boxText(lines[peekTop(lines) + 1]!);
  };
  await openPeek(h);
  assert.equal(body(), "Loading…");
  gates.shift()!();
  await settle();
  assert.equal(body(), "output of a");
  await h.press(KEY.down);
  assert.equal(body(), "Loading…");
  gates.shift()!();
  await settle();
  assert.equal(body(), "output of b");
  h.d.dispose();
});

test("peek: an agent without output shows No output yet once loaded", async () => {
  const h = await setup(three());
  h.svc.lastText.a = "";
  await openPeek(h);
  const lines = h.screen();
  assert.equal(boxText(lines[peekTop(lines) + 1]!), "No output yet");
  h.d.dispose();
});

test("peek: Enter reports a restarted agent", async () => {
  const h = await setup(three());
  h.svc.replyResult = async () => "restarted";
  await openPeek(h);
  await typeText(h, "go on");
  await h.press(KEY.enter);
  assert.equal(h.message(), "Restarted agent a");
  h.d.dispose();
});

test("peek: Enter with an empty reply does nothing", async () => {
  const h = await setup(three());
  await openPeek(h);
  await h.press(KEY.enter);
  assert.equal(h.svc.count("reply"), 0);
  assert.deepEqual(h.results, []);
  h.d.dispose();
});

test("peek: reply errors surface and keep the reply text", async () => {
  const h = await setup(three());
  h.svc.replyResult = async () => {
    throw new Error("reply failed: agent gone");
  };
  await openPeek(h);
  await typeText(h, "hello");
  await h.press(KEY.enter);
  assert.equal(h.message(), "reply failed: agent gone");
  assert.ok(h.screen().some((l) => l.startsWith("│ ") && boxText(l) === "reply ❯ hello"));
  h.d.dispose();
});

test("peek: → with empty reply attaches", async () => {
  const h = await setup(three());
  await openPeek(h);
  await h.press(KEY.right);
  assert.deepEqual(h.results, [{ type: "attach", id: "a" }]);
  h.d.dispose();
});

test("peek: → with reply text edits the reply", async () => {
  const h = await setup(three());
  await openPeek(h);
  await typeText(h, "ok");
  await h.press(KEY.right);
  assert.deepEqual(h.results, []);
  h.d.dispose();
});

test("peek: Esc closes the peek, not the dashboard", async () => {
  const h = await setup(three());
  await openPeek(h);
  await h.press(KEY.esc);
  assert.deepEqual(h.results, []);
  const lines = h.screen();
  assert.equal(peekTop(lines), -1);
  assert.equal(lines.at(-1), LIST_FOOTER);
  h.d.dispose();
});

test("peek: errors surface on the message line", async () => {
  const h = await setup(three());
  h.svc.peekError = new Error("peek failed: EIO");
  await openPeek(h);
  assert.equal(h.message(), "peek failed: EIO");
  h.d.dispose();
});

// --- focus ---

test("focused is propagated to the input that has focus", async () => {
  const h = await setup(three());
  h.d.focused = true;
  const markerLine = () => h.d.render(100).find((l) => l.includes(CURSOR_MARKER));
  assert.ok(strip(markerLine()!).includes("│ ❯ "));
  await openPeek(h);
  assert.ok(strip(markerLine()!).includes("│ reply ❯ "));
  h.d.focused = false;
  assert.equal(markerLine(), undefined);
  h.d.dispose();
});
