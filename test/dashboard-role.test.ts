import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentService } from "../src/service.ts";
import { Tmux } from "../src/tmux.ts";
import type { DashboardService, DashboardResult } from "../src/ui/service-types.ts";
import type { DashboardOptions } from "../src/ui/dashboard.ts";
import { EMPTY_HINT } from "../src/ui/view.ts";
import {
  DASHBOARD_OVERLAY_OPTIONS,
  NEEDS_TUI_MESSAGE,
  displayPath,
  modelArgs,
  modelLabel,
  registerDashboardRole,
  type DashboardRoleDeps,
} from "../src/dashboard-role.ts";

// Compile-time check: the real service satisfies what the dashboard screen needs.
const _serviceCheck: DashboardService = new AgentService({ home: path.join(os.tmpdir(), "pi-agents-type-check") });
void _serviceCheck;

const LEFT = "\x1b[D";
const LEFT_CSI_U_RELEASE = "\x1b[1;1:3D";
const ROWS = 12;

type Handler = (event: unknown, ctx: unknown) => unknown;
type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function fakePi(flags: Record<string, boolean | string | undefined> = {}, settings: unknown = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: CommandHandler }>();
  const registeredFlags = new Map<string, unknown>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand(name: string, options: { description?: string; handler: CommandHandler }) {
      commands.set(name, options);
    },
    registerFlag(name: string, options: unknown) {
      registeredFlags.set(name, options);
    },
    getFlag(name: string) {
      return flags[name];
    },
    getThinkingLevel: () => "high",
    getSettings: () => settings,
  };
  async function emit(type: string, event: Record<string, unknown>, ctx: unknown): Promise<void> {
    for (const h of handlers.get(type) ?? []) await h({ type, ...event }, ctx);
  }
  return { pi: api as unknown as ExtensionAPI, handlers, commands, registeredFlags, emit };
}

interface CustomCall {
  options: unknown;
  component: unknown;
  done: (result: unknown) => void;
}

/**
 * Fake ctx whose `ui.custom` runs the factory against a fake TUI. Dashboard calls are answered from
 * `results` (in order); with no scripted result left the promise stays pending until `done` is called.
 */
function fakeCtx(
  opts: { mode?: string; hasUI?: boolean; results?: DashboardResult[]; customError?: Error; knownModels?: string[] } = {},
) {
  const log: string[] = [];
  const results = [...(opts.results ?? [])];
  const state = {
    editorText: "",
    inputHandlers: [] as InputHandler[],
    unsubscribed: 0,
    notes: [] as [string, unknown][],
    customCalls: [] as CustomCall[],
  };
  const tui = {
    terminal: {
      rows: ROWS,
      columns: 80,
      drainInput: async () => {
        log.push("drain");
      },
    },
    stop: () => log.push("stop"),
    start: () => log.push("start"),
    requestRender: (force?: boolean) => log.push(force ? "render:force" : "render"),
  };
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
  const ctx = {
    mode: opts.mode ?? "tui",
    hasUI: opts.hasUI ?? true,
    cwd: "/launch/dir",
    modelRegistry: {
      find: (provider: string, id: string) =>
        (opts.knownModels ?? ["openai/gpt-6-luna"]).includes(`${provider}/${id}`) ? { provider, id } : undefined,
      hasConfiguredAuth: () => true,
      streamSimple: () => {
        throw new Error("not used");
      },
    },
    ui: {
      getEditorText: () => state.editorText,
      notify: (message: string, type?: unknown) => state.notes.push([message, type]),
      onTerminalInput(handler: InputHandler) {
        state.inputHandlers.push(handler);
        return () => {
          state.unsubscribed++;
          state.inputHandlers = state.inputHandlers.filter((h) => h !== handler);
        };
      },
      custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown, options?: unknown) {
        if (opts.customError) return Promise.reject(opts.customError);
        return new Promise((resolve) => {
          let finished = false;
          const done = (r: unknown) => {
            if (finished) return;
            finished = true;
            resolve(r);
          };
          const isDashboard = options !== undefined;
          log.push(isDashboard ? "custom:dashboard" : "custom:plain");
          const component = factory(tui, theme, {}, done);
          state.customCalls.push({ options, component, done });
          if (isDashboard && results.length > 0) {
            const next = results.shift()!;
            setImmediate(() => done(next));
          }
        });
      },
    },
  };
  function press(data: string) {
    const handler = state.inputHandlers.at(-1);
    return handler ? handler(data) : undefined;
  }
  return { ctx, log, state, press, tui, theme };
}

function fakeDeps(log: string[], attach: (id: string) => { status: number | null; error?: Error } = () => ({ status: 0 })) {
  const created: DashboardOptions[] = [];
  const service = {} as DashboardService;
  const deps: DashboardRoleDeps = {
    service,
    gitInfo: async () => ({ branch: null, inRepo: false }),
    tmux: {
      attachSync(id: string) {
        log.push(`attach:${id}`);
        return attach(id);
      },
    } as unknown as Tmux,
    createDashboard(o) {
      created.push(o);
      return {
        focused: false,
        render: () => ["line one", "line two"],
        handleInput: () => {},
        invalidate: () => {},
        dispose: () => {},
      };
    },
  };
  return { deps, created, service };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test("registers the /agents command and the --agents boolean flag", () => {
  const { pi, commands, registeredFlags } = fakePi();
  const { deps } = fakeDeps([]);
  registerDashboardRole(pi, deps);
  assert.ok(commands.has("agents"));
  const flag = registeredFlags.get("agents") as { type: string; description?: string };
  assert.equal(flag.type, "boolean");
  assert.ok(flag.description);
});

test("/agents opens the dashboard as a full-screen overlay via ctx.ui.custom", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state, theme } = fakeCtx({ results: [{ type: "close" }] });
  const { deps, created, service } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(log, ["custom:dashboard"]);
  assert.deepEqual(state.customCalls[0]!.options, { overlay: true, overlayOptions: DASHBOARD_OVERLAY_OPTIONS });
  assert.deepEqual(DASHBOARD_OVERLAY_OPTIONS, { width: "100%", maxHeight: "100%", anchor: "top-left" });
  assert.equal(created.length, 1);
  const o = created[0]!;
  assert.equal(o.service, service);
  assert.equal(o.launchCwd, "/launch/dir");
  assert.equal(o.initialSelectedId, undefined);
  assert.equal(o.height(), ROWS);
  assert.equal(o.theme, theme);
  o.requestRender();
  assert.deepEqual(log.slice(1), ["render"]);
});

test("the dashboard header shows the launch dir, its branch and the model new agents inherit", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log } = fakeCtx({ results: [{ type: "close" }] });
  const { deps, created } = fakeDeps(log);
  deps.gitInfo = async (cwd) => (cwd === os.homedir() + "/www/app" ? { branch: "main", inRepo: true } : { branch: null, inRepo: false });
  registerDashboardRole(pi, deps);
  const c = ctx as unknown as { cwd: string; model?: { provider: string; id: string } };
  c.cwd = os.homedir() + "/www/app";
  c.model = { provider: "anthropic", id: "claude-opus-5-5" };
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(created[0]!.context, { cwd: "~/www/app", branch: "main", inRepo: true, modelLabel: "claude-opus-5-5 (high)" });
});

test("a usable naming model opens the dashboard without notices", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx({ results: [{ type: "close" }] });
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, { ...deps, env: {} });
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(state.notes, []);
});

test("naming config problems are reported once per problem, and the dashboard still opens", async () => {
  const { pi, commands } = fakePi({}, { agentDashboard: { namingModel: "nope" } });
  const { ctx, log, state } = fakeCtx({ results: [{ type: "close" }, { type: "close" }] });
  const { deps, created } = fakeDeps(log);
  registerDashboardRole(pi, { ...deps, env: {} });
  await commands.get("agents")!.handler("", ctx);
  await commands.get("agents")!.handler("", ctx);
  assert.equal(created.length, 2);
  assert.equal(state.notes.length, 1);
  assert.match(state.notes[0]![0], /naming off.*agentDashboard\.namingModel/i);
  assert.equal(state.notes[0]![1], "warning");
});

test("an unusable naming model (not in the catalog) is reported", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx({ results: [{ type: "close" }], knownModels: [] });
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, { ...deps, env: { PI_AGENTS_NAMING_MODEL: "openai/missing" } });
  await commands.get("agents")!.handler("", ctx);
  assert.equal(state.notes.length, 1);
  assert.match(state.notes[0]![0], /openai\/missing is not in the model catalog/);
});

test('naming "off" is silent', async () => {
  const { pi, commands } = fakePi({}, { agentDashboard: { namingModel: "off" } });
  const { ctx, log, state } = fakeCtx({ results: [{ type: "close" }], knownModels: [] });
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, { ...deps, env: {} });
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(state.notes, []);
});

test("displayPath, modelLabel and modelArgs", () => {
  assert.equal(displayPath("/home/me", "/home/me"), "~");
  assert.equal(displayPath("/home/me/www/x", "/home/me"), "~/www/x");
  assert.equal(displayPath("/home/meow/x", "/home/me"), "/home/meow/x");
  assert.equal(modelLabel(null), null);
  assert.equal(modelLabel({ provider: "p", id: "m", thinking: "off" }), "m");
  assert.equal(modelLabel({ provider: "p", id: "m", thinking: "high" }), "m (high)");
  assert.deepEqual(modelArgs(null), []);
  assert.deepEqual(modelArgs({ provider: "anthropic", id: "claude-opus-5-5", thinking: "high" }), [
    "--model",
    "anthropic/claude-opus-5-5",
    "--thinking",
    "high",
  ]);
});

test("the overlay component pads the dashboard to the full terminal height and forwards input/focus/dispose", async () => {
  const { pi, commands } = fakePi();
  const { ctx, state, log } = fakeCtx();
  const inner = { focused: false, inputs: [] as string[], disposed: 0, invalidated: 0 };
  const deps: DashboardRoleDeps = {
    service: {} as DashboardService,
    gitInfo: async () => ({ branch: null, inRepo: false }),
    tmux: { attachSync: () => ({ status: 0 }) } as unknown as Tmux,
    createDashboard: () => ({
      get focused() {
        return inner.focused;
      },
      set focused(v: boolean) {
        inner.focused = v;
      },
      render: (width: number) => ["x".repeat(width), "short"],
      handleInput: (data: string) => void inner.inputs.push(data),
      invalidate: () => void inner.invalidated++,
      dispose: () => void inner.disposed++,
    }),
  };
  registerDashboardRole(pi, deps);
  const opened = commands.get("agents")!.handler("", ctx);
  await settle();
  const call = state.customCalls[0]!;
  const component = call.component as {
    render(w: number): string[];
    handleInput(d: string): void;
    invalidate(): void;
    dispose(): void;
    focused: boolean;
  };
  const lines = component.render(40);
  assert.equal(lines.length, ROWS);
  assert.equal(lines[0], "x".repeat(40));
  assert.equal(lines[1], "short");
  for (const line of lines) assert.ok(visibleWidth(line) <= 40);
  component.handleInput("a");
  assert.deepEqual(inner.inputs, ["a"]);
  component.focused = true;
  assert.equal(inner.focused, true);
  assert.equal(component.focused, true);
  component.invalidate();
  assert.equal(inner.invalidated, 1);
  component.dispose();
  assert.equal(inner.disposed, 1);
  call.done({ type: "close" });
  await opened;
  assert.deepEqual(log, ["custom:dashboard"]);
});

// Draining first disables the kitty protocol and swallows the → key-release (`ESC[1;1:3C`), which
// tmux would otherwise forward into the agent's input as `1;1:3C`.
test("attach loop: drain input, stop TUI, tmux attach, start TUI, reopen with the row selected", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx({ results: [{ type: "attach", id: "fix-bug-a1b2" }, { type: "close" }] });
  const { deps, created } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(log, [
    "custom:dashboard",
    "custom:plain",
    "drain",
    "stop",
    "attach:fix-bug-a1b2",
    "start",
    "render:force",
    "custom:dashboard",
  ]);
  assert.equal(created.length, 2);
  assert.equal(created[0]!.initialSelectedId, undefined);
  assert.equal(created[1]!.initialSelectedId, "fix-bug-a1b2");
  assert.deepEqual(state.notes, []);
  // The attach step's placeholder component renders nothing.
  const plain = state.customCalls[1]!.component as { render(w: number): string[] };
  assert.deepEqual(plain.render(80), []);
});

test("a failed attach is notified and the dashboard reopens", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx({ results: [{ type: "attach", id: "a-1234" }, { type: "close" }] });
  const { deps, created } = fakeDeps(log, () => ({ status: null, error: new Error("tmux not found — install tmux ≥ 3.5") }));
  registerDashboardRole(pi, deps);
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(state.notes, [["tmux not found — install tmux ≥ 3.5", "error"]]);
  assert.equal(created.length, 2);
  assert.ok(log.includes("start"));
});

test("a non-zero tmux attach exit is notified", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx({ results: [{ type: "attach", id: "a-1234" }, { type: "close" }] });
  const { deps } = fakeDeps(log, () => ({ status: 1 }));
  registerDashboardRole(pi, deps);
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(state.notes, [["tmux attach failed: exit 1", "error"]]);
});

test("/agents outside the interactive TUI notifies instead of opening", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx({ mode: "rpc" });
  const { deps, created } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(log, []);
  assert.equal(created.length, 0);
  assert.deepEqual(state.notes, [[NEEDS_TUI_MESSAGE, "warning"]]);
});

test("a second /agents while the dashboard is open does nothing", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx();
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  const first = commands.get("agents")!.handler("", ctx);
  await settle();
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(log, ["custom:dashboard"]);
  state.customCalls[0]!.done({ type: "close" });
  await first;
});

test("a custom() failure is notified and the dashboard can be opened again", async () => {
  const { pi, commands } = fakePi();
  const { ctx, log, state } = fakeCtx({ customError: new Error("boom") });
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await commands.get("agents")!.handler("", ctx);
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(state.notes, [
    ["Agent dashboard failed: boom", "error"],
    ["Agent dashboard failed: boom", "error"],
  ]);
});

test("--agents opens the dashboard on startup without blocking session_start", async () => {
  const { pi, emit } = fakePi({ agents: true });
  const { ctx, log, state } = fakeCtx(); // custom stays pending: the dashboard is open
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await emit("session_start", { reason: "startup" }, ctx); // must resolve while the dashboard is still open
  await settle();
  assert.deepEqual(log, ["custom:dashboard"]);
  state.customCalls[0]!.done({ type: "close" });
  await settle();
});

test("--agents does not open outside the TUI, without the flag, or on later session starts", async () => {
  for (const [flags, mode, reason] of [
    [{ agents: true }, "print", "startup"],
    [{ agents: true }, "rpc", "startup"],
    [{}, "tui", "startup"],
    [{ agents: false }, "tui", "startup"],
    [{ agents: true }, "tui", "new"],
    [{ agents: true }, "tui", "reload"],
  ] as const) {
    const { pi, emit } = fakePi(flags);
    const { ctx, log } = fakeCtx({ mode, hasUI: mode !== "print" });
    const { deps } = fakeDeps(log);
    registerDashboardRole(pi, deps);
    await emit("session_start", { reason }, ctx);
    await settle();
    assert.deepEqual(log, [], `flags=${JSON.stringify(flags)} mode=${mode} reason=${reason}`);
  }
});

test("--agents startup failure is notified as an error", async () => {
  const { pi, emit } = fakePi({ agents: true });
  const { ctx, log, state } = fakeCtx({ customError: new Error("no terminal") });
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await emit("session_start", { reason: "startup" }, ctx);
  await settle();
  assert.deepEqual(state.notes, [["Agent dashboard failed: no terminal", "error"]]);
});

test("← on an empty editor opens the dashboard and consumes the key", async () => {
  const { pi, emit } = fakePi();
  const { ctx, log, state, press } = fakeCtx();
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await emit("session_start", { reason: "startup" }, ctx);
  assert.equal(state.inputHandlers.length, 1);
  assert.deepEqual(press(LEFT), { consume: true });
  await settle();
  assert.deepEqual(log, ["custom:dashboard"]);
  // Already open: the key goes to the dashboard instead.
  assert.equal(press(LEFT), undefined);
  await settle();
  assert.deepEqual(log, ["custom:dashboard"]);
  state.customCalls[0]!.done({ type: "close" });
  await settle();
  assert.deepEqual(press(LEFT), { consume: true });
  await settle();
  assert.deepEqual(log, ["custom:dashboard", "custom:dashboard"]);
  state.customCalls[1]!.done({ type: "close" });
  await settle();
});

test("← does not open with editor text, on key release, for other keys, or while a ui prompt is open", async () => {
  const { pi, emit } = fakePi();
  const { ctx, log, state, press } = fakeCtx();
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await emit("session_start", { reason: "startup" }, ctx);

  state.editorText = "draft";
  assert.equal(press(LEFT), undefined);
  state.editorText = "";
  assert.equal(press(LEFT_CSI_U_RELEASE), undefined);
  assert.equal(press("\x1b[C"), undefined);
  assert.equal(press("a"), undefined);

  await emit("ui_prompt_start", { reason: "ui_prompt", kind: "select", title: "Pick" }, ctx);
  assert.equal(press(LEFT), undefined);
  await emit("ui_prompt_end", { reason: "ui_prompt", kind: "select", title: "Pick" }, ctx);
  await settle();
  assert.deepEqual(log, []);

  assert.deepEqual(press(LEFT), { consume: true });
  await settle();
  assert.deepEqual(log, ["custom:dashboard"]);
  state.customCalls[0]!.done({ type: "close" });
  await settle();
});

test("← is re-subscribed on each session_start and unsubscribed on session_shutdown", async () => {
  const { pi, emit } = fakePi();
  const { ctx, log, state } = fakeCtx();
  const { deps } = fakeDeps(log);
  registerDashboardRole(pi, deps);
  await emit("session_start", { reason: "startup" }, ctx);
  await emit("session_start", { reason: "new" }, ctx);
  assert.equal(state.inputHandlers.length, 1);
  assert.equal(state.unsubscribed, 1);
  await emit("session_shutdown", { reason: "quit" }, ctx);
  assert.equal(state.inputHandlers.length, 0);
  assert.equal(state.unsubscribed, 2);
  await emit("session_shutdown", { reason: "quit" }, ctx); // idempotent
  assert.equal(state.unsubscribed, 2);
});

test("← is not subscribed outside the interactive TUI", async () => {
  for (const [mode, hasUI] of [
    ["print", false],
    ["rpc", true],
  ] as const) {
    const { pi, emit } = fakePi();
    const { ctx, log, state } = fakeCtx({ mode, hasUI });
    const { deps } = fakeDeps(log);
    registerDashboardRole(pi, deps);
    await emit("session_start", { reason: "startup" }, ctx);
    assert.equal(state.inputHandlers.length, 0, mode);
  }
});

// --- integration smoke: real Dashboard + real AgentService on a throwaway tmux socket ---

const sockets: string[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // no server was started
    }
  }
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

test("smoke: /agents opens an empty full-screen dashboard backed by the real service", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-role-test-"));
  homes.push(home);
  const socket = `pi-agents-test-role-${process.pid}-${Date.now()}`;
  sockets.push(socket);
  const { pi, commands } = fakePi();
  const { ctx, state, log } = fakeCtx();
  registerDashboardRole(pi, {
    home,
    tmux: new Tmux({ configPath: path.join(home, "tmux.conf"), socket }),
    gitInfo: async () => ({ branch: null, inRepo: false }),
  });
  const opened = commands.get("agents")!.handler("", ctx);
  await settle();
  const call = state.customCalls[0]!;
  const component = call.component as { render(w: number): string[]; handleInput(d: string): void };
  let lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    lines = component.render(80);
    if (lines.some((l) => l.includes(EMPTY_HINT))) break;
    await sleep(20);
  }
  assert.equal(lines.length, ROWS);
  assert.ok(lines.some((l) => l.includes(EMPTY_HINT)), lines.join("\n"));
  assert.deepEqual(state.notes, []);
  component.handleInput("\x1b"); // Esc closes
  await opened;
  assert.deepEqual(log, ["custom:dashboard"]);
});
