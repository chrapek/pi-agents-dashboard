import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enqueueInbox, readStatus, renameAgent, writeMeta, writeStatus, type AgentStatus } from "../src/store.ts";
import { inboxDir } from "../src/paths.ts";
import { registerWorker, type WorkerDeps } from "../src/worker.ts";

const ID = "fix-bug-a1b2";
const LEFT = "\x1b[D";
const LEFT_CSI_U_RELEASE = "\x1b[1;1:3D";

type Handler = (event: unknown, ctx: unknown) => unknown;
type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

interface Sent {
  text: unknown;
  options: unknown;
}

let home: string;
let stops: (() => Promise<void>)[];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-worker-test-"));
  stops = [];
  await writeMeta(home, {
    id: ID,
    name: "fix bug",
    prompt: "fix the bug",
    createdAt: 1,
    launchCwd: home,
    cwd: home,
    repoRoot: null,
    worktree: null,
    branch: null,
  });
});

afterEach(async () => {
  for (const stop of stops) await stop();
  await fs.rm(home, { recursive: true, force: true });
});

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: Sent[] = [];
  const names: string[] = [];
  const api = {
    setSessionName(name: string) {
      names.push(name);
    },
    getSessionName() {
      return names.at(-1);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
    sendUserMessage(text: unknown, options?: unknown) {
      sent.push({ text, options });
    },
  };
  async function emit(type: string, event: Record<string, unknown>, ctx: unknown): Promise<void> {
    for (const h of handlers.get(type) ?? []) await h({ type, ...event }, ctx);
  }
  return { pi: api as unknown as ExtensionAPI, handlers, commands, sent, names, emit };
}

function fakeCtx(opts: { hasUI?: boolean } = {}) {
  const state = { idle: true, editorText: "", inputHandlers: [] as InputHandler[], notes: [] as [string, unknown][], unsubscribed: 0 };
  const ctx = {
    hasUI: opts.hasUI ?? true,
    model: { id: "claude-test", provider: "anthropic" },
    sessionManager: { getSessionFile: () => "/sessions/a.jsonl" },
    isIdle: () => state.idle,
    ui: {
      getEditorText: () => state.editorText,
      notify: (message: string, type?: unknown) => state.notes.push([message, type]),
      onTerminalInput(handler: InputHandler) {
        state.inputHandlers.push(handler);
        return () => {
          state.inputHandlers = state.inputHandlers.filter((h) => h !== handler);
          state.unsubscribed++;
        };
      },
    },
  };
  return { ctx, state };
}

/** Registers a worker with fast timers; the test teardown shuts its session down so no timers leak. */
function setup(deps: WorkerDeps = {}, ctxOpts: { hasUI?: boolean } = {}) {
  const pi = fakePi();
  const { ctx, state } = fakeCtx(ctxOpts);
  const detaches: number[] = [];
  registerWorker(pi.pi, ID, home, {
    statusDelayMs: 40,
    pollMs: 20,
    env: { TMUX: "/tmp/tmux-501/pi-agents,1,0" },
    detach: () => detaches.push(1),
    ...deps,
  });
  let shut = false;
  const shutdown = async () => {
    if (shut) return;
    shut = true;
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  };
  stops.push(shutdown);
  return { ...pi, ctx, state, detaches, shutdown };
}

async function status(): Promise<AgentStatus | null> {
  return readStatus(home, ID);
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

// --- naming ---

test("a new meta.name from the dashboard becomes the Pi session name, once", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await sleep(60);
  assert.deepEqual(w.names, [], "the slug name it was started with is not pushed again");
  await renameAgent(home, ID, "Fix login redirect");
  await waitFor(() => w.names.length > 0);
  await sleep(60);
  assert.deepEqual(w.names, ["Fix login redirect"]);
});

test("a name given while the agent was stopped is applied after it starts", async () => {
  await renameAgent(home, ID, "Fix login redirect");
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.names.length > 0);
  assert.deepEqual(w.names, ["Fix login redirect"]);
});

test("meta.name is not read before session_start or after session_shutdown", async () => {
  const w = setup();
  await renameAgent(home, ID, "Early");
  await sleep(60);
  assert.deepEqual(w.names, []);
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.names.length > 0);
  await w.shutdown();
  await renameAgent(home, ID, "Late");
  await sleep(60);
  assert.deepEqual(w.names, ["Early"]);
});

// --- status writing ---

test("session_start writes idle status with sessionFile, pid and model immediately", async () => {
  const w = setup({ statusDelayMs: 10_000 });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  const s = await status();
  assert.equal(s?.phase, "idle");
  assert.equal(s?.sessionFile, "/sessions/a.jsonl");
  assert.equal(s?.pid, process.pid);
  assert.equal(s?.model, "claude-test");
});

test("session_start keeps lastText and lastOutcome from an existing status.json (resume)", async () => {
  await writeStatus(home, ID, {
    phase: "exited",
    activity: null,
    lastText: "Shall I continue?",
    lastOutcome: "error",
    uiPrompt: null,
    sessionFile: "/sessions/old.jsonl",
    pid: 1,
    model: "old-model",
    updatedAt: 1,
  });
  const w = setup({ statusDelayMs: 10_000 });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  const s = await status();
  assert.equal(s?.phase, "idle");
  assert.equal(s?.lastText, "Shall I continue?");
  assert.equal(s?.lastOutcome, "error");
  assert.equal(s?.sessionFile, "/sessions/a.jsonl");
  assert.equal(s?.pid, process.pid);
  assert.equal(s?.model, "claude-test");
});

test("non-urgent events are coalesced into one trailing write with the latest status", async () => {
  const w = setup({ statusDelayMs: 60 });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("agent_start", {}, w.ctx);
  await w.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "npm test\nmore" } }, w.ctx);
  assert.equal((await status())?.phase, "idle", "non-urgent write is deferred");
  await waitFor(async () => (await status())?.phase === "working");
  assert.equal((await status())?.activity, "bash: npm test");
});

test("model_select updates the model (coalesced)", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("model_select", { model: { id: "gpt-other", provider: "openai" }, previousModel: undefined, source: "set" }, w.ctx);
  await waitFor(async () => (await status())?.model === "gpt-other");
});

test("agent_settled flushes immediately, including pending coalesced changes", async () => {
  const w = setup({ statusDelayMs: 10_000 });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("agent_start", {}, w.ctx);
  await w.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done?" }], stopReason: "stop" } }, w.ctx);
  await w.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "error" }] }, w.ctx);
  assert.equal((await status())?.lastText, null, "non-urgent changes are still pending");
  await w.emit("agent_settled", {}, w.ctx);
  const s = await status();
  assert.equal(s?.phase, "idle");
  assert.equal(s?.lastText, "Done?");
  assert.equal(s?.lastOutcome, "error");
  assert.equal(s?.activity, null);
});

test("ui_prompt_start and ui_prompt_end flush immediately", async () => {
  const w = setup({ statusDelayMs: 10_000 });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Proceed?" }, w.ctx);
  assert.deepEqual((await status())?.uiPrompt, { kind: "confirm", title: "Proceed?" });
  await w.emit("ui_prompt_end", { reason: "ui_prompt", kind: "confirm", title: "Proceed?" }, w.ctx);
  assert.equal((await status())?.uiPrompt, null);
});

test("session_shutdown writes exited before its handler resolves", async () => {
  const w = setup({ statusDelayMs: 10_000 });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("agent_start", {}, w.ctx);
  await w.shutdown();
  assert.equal((await status())?.phase, "exited");
});

test("no coalesced write lands after session_shutdown", async () => {
  const w = setup({ statusDelayMs: 30 });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("agent_start", {}, w.ctx);
  await w.shutdown();
  await sleep(80);
  assert.equal((await status())?.phase, "exited");
});

// --- inbox delivery ---

async function inboxFiles(): Promise<string[]> {
  return fs.readdir(inboxDir(home, ID));
}

/** Simulates Pi starting the run that a plain message (or a typed prompt) triggered. */
async function startRun(w: ReturnType<typeof setup>): Promise<void> {
  w.state.idle = false;
  await w.emit("before_agent_start", { prompt: "x", systemPrompt: "", systemPromptOptions: {} }, w.ctx);
  await w.emit("agent_start", {}, w.ctx);
}

async function settleRun(w: ReturnType<typeof setup>): Promise<void> {
  w.state.idle = true;
  await w.emit("agent_settled", {}, w.ctx);
}

test("inbox messages are delivered as plain messages when idle, one run at a time, then deleted", async () => {
  const w = setup();
  await enqueueInbox(home, ID, "first");
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.sent.length === 1);
  assert.deepEqual(w.sent[0], { text: "first", options: undefined });
  await startRun(w);
  await settleRun(w);
  await enqueueInbox(home, ID, "second");
  await waitFor(() => w.sent.length === 2);
  assert.deepEqual(w.sent[1], { text: "second", options: undefined });
  await waitFor(async () => (await inboxFiles()).length === 0);
});

test("inbox messages are delivered as followUp while working", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await startRun(w);
  await enqueueInbox(home, ID, "a");
  await enqueueInbox(home, ID, "b");
  await waitFor(() => w.sent.length === 2);
  assert.deepEqual(w.sent, [
    { text: "a", options: { deliverAs: "followUp" } },
    { text: "b", options: { deliverAs: "followUp" } },
  ]);
  await waitFor(async () => (await inboxFiles()).length === 0);
});

test("several messages found while idle: only the first is sent until the run starts, then the rest follow up in order", async () => {
  const w = setup();
  await enqueueInbox(home, ID, "one");
  await enqueueInbox(home, ID, "two");
  await enqueueInbox(home, ID, "three");
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.sent.length === 1);
  await sleep(100); // several polls while the run is pending
  assert.deepEqual(w.sent, [{ text: "one", options: undefined }]);
  assert.equal((await inboxFiles()).length, 2, "held messages stay in the inbox");
  await startRun(w);
  await waitFor(() => w.sent.length === 3);
  assert.deepEqual(w.sent.slice(1), [
    { text: "two", options: { deliverAs: "followUp" } },
    { text: "three", options: { deliverAs: "followUp" } },
  ]);
});

test("messages are held while Pi is busy but no run is active (e.g. compaction)", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  w.state.idle = false; // phase stays idle
  await enqueueInbox(home, ID, "held");
  await sleep(100);
  assert.equal(w.sent.length, 0);
  assert.equal((await inboxFiles()).length, 1);
  w.state.idle = true;
  await waitFor(() => w.sent.length === 1);
  assert.deepEqual(w.sent[0], { text: "held", options: undefined });
});

test("messages are held while Pi reports idle but the run has not settled", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("agent_start", {}, w.ctx); // phase working, ctx.isIdle() still true
  await enqueueInbox(home, ID, "held");
  await sleep(100);
  assert.equal(w.sent.length, 0);
  assert.equal((await inboxFiles()).length, 1);
});

test("a prompt typed into the TUI (before_agent_start) holds inbox delivery until its run starts", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("before_agent_start", { prompt: "typed", systemPrompt: "", systemPromptOptions: {} }, w.ctx);
  await enqueueInbox(home, ID, "reply");
  await sleep(100);
  assert.equal(w.sent.length, 0);
  w.state.idle = false;
  await w.emit("agent_start", {}, w.ctx);
  await waitFor(() => w.sent.length === 1);
  assert.deepEqual(w.sent[0], { text: "reply", options: { deliverAs: "followUp" } });
});

test("idle input typed into the TUI holds inbox delivery before before_agent_start", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("input", { text: "typed", source: "interactive" }, w.ctx);
  await enqueueInbox(home, ID, "reply");
  await sleep(100);
  assert.equal(w.sent.length, 0);
  await startRun(w);
  await waitFor(() => w.sent.length === 1);
  assert.deepEqual(w.sent[0], { text: "reply", options: { deliverAs: "followUp" } });
});

test("input queued during streaming (streamingBehavior set) does not mark a run pending", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("input", { text: "queued", source: "interactive", streamingBehavior: "followUp" }, w.ctx);
  await enqueueInbox(home, ID, "reply");
  await waitFor(() => w.sent.length === 1);
  assert.deepEqual(w.sent[0], { text: "reply", options: undefined });
});

test("the safety-net timeout re-arms while Pi is still busy", async () => {
  const w = setup({ runPendingTimeoutMs: 200 });
  await enqueueInbox(home, ID, "one");
  await enqueueInbox(home, ID, "two");
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.sent.length === 1);
  w.state.idle = false; // busy (no agent_start yet) through the timeouts at ~200 and ~400 ms
  await sleep(450);
  w.state.idle = true;
  await sleep(60);
  assert.equal(w.sent.length, 1, "run still pending: the timeout re-armed instead of clearing");
  await waitFor(() => w.sent.length === 2); // cleared by the timeout at ~600 ms, now idle
  assert.deepEqual(w.sent[1], { text: "two", options: undefined });
});

test("a pending run that never starts is cleared by the safety-net timeout when Pi is idle", async () => {
  const w = setup({ runPendingTimeoutMs: 120 });
  await enqueueInbox(home, ID, "one");
  await enqueueInbox(home, ID, "two");
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.sent.length === 1);
  await sleep(50);
  assert.equal(w.sent.length, 1, "second is held while the run is pending");
  await waitFor(() => w.sent.length === 2);
  assert.deepEqual(w.sent[1], { text: "two", options: undefined });
});

test("inbox is not polled before session_start or after session_shutdown", async () => {
  const w = setup();
  await enqueueInbox(home, ID, "early");
  await sleep(60);
  assert.equal(w.sent.length, 0);
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.sent.length === 1);
  await w.shutdown();
  await enqueueInbox(home, ID, "late");
  await sleep(60);
  assert.equal(w.sent.length, 1);
  assert.equal((await inboxFiles()).length, 1, "undelivered message is kept for the next session");
});

// Known limitation: real Pi reports most send failures asynchronously (pi.sendUserMessage returns void
// and the prompt fails later), so those messages are already deleted. Only a synchronous throw keeps the file.
test("a synchronously failing sendUserMessage keeps the message for the next poll", async () => {
  const w = setup();
  let fail = true;
  const original = w.pi.sendUserMessage.bind(w.pi);
  (w.pi as { sendUserMessage: unknown }).sendUserMessage = (text: string, options?: unknown) => {
    if (fail) {
      fail = false;
      throw new Error("not now");
    }
    original(text, options as undefined);
  };
  await enqueueInbox(home, ID, "retry me");
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await waitFor(() => w.sent.length === 1);
  assert.deepEqual(w.sent[0], { text: "retry me", options: undefined });
});

// --- /agents ---

test("/agents in a worker notifies to detach first", async () => {
  const w = setup();
  const cmd = w.commands.get("agents");
  assert.ok(cmd, "agents command registered");
  await cmd.handler("", w.ctx);
  assert.deepEqual(w.state.notes, [["Detach first (← or Ctrl+\\)", "info"]]);
});

// --- ← detach ---

test("← on an empty editor with no prompt inside tmux detaches and consumes", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  assert.equal(w.state.inputHandlers.length, 1);
  const handler = w.state.inputHandlers[0]!;
  assert.deepEqual(handler(LEFT), { consume: true });
  assert.equal(w.detaches.length, 1);
});

test("← is not consumed when the editor has text", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  w.state.editorText = "draft";
  assert.equal(w.state.inputHandlers[0]!(LEFT), undefined);
  assert.equal(w.detaches.length, 0);
});

test("← is not consumed while a ui prompt is open", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("ui_prompt_start", { reason: "ui_prompt", kind: "select", title: "Pick" }, w.ctx);
  assert.equal(w.state.inputHandlers[0]!(LEFT), undefined);
  await w.emit("ui_prompt_end", { reason: "ui_prompt", kind: "select" }, w.ctx);
  assert.deepEqual(w.state.inputHandlers[0]!(LEFT), { consume: true });
  assert.equal(w.detaches.length, 1);
});

test("← is not consumed outside tmux", async () => {
  const w = setup({ env: {} });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  assert.equal(w.state.inputHandlers[0]!(LEFT), undefined);
  assert.equal(w.detaches.length, 0);
});

test("other keys and ← key releases are not consumed", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  const handler = w.state.inputHandlers[0]!;
  for (const data of ["a", "\x1b[C", "\x1b[1;5D", LEFT_CSI_U_RELEASE]) assert.equal(handler(data), undefined, JSON.stringify(data));
  assert.equal(w.detaches.length, 0);
});

test("no terminal input subscription without UI", async () => {
  const w = setup({}, { hasUI: false });
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  assert.equal(w.state.inputHandlers.length, 0);
});

test("terminal input is unsubscribed on shutdown and re-subscribed on the next session_start", async () => {
  const w = setup();
  await w.emit("session_start", { reason: "startup" }, w.ctx);
  await w.emit("session_shutdown", { reason: "new" }, w.ctx);
  assert.equal(w.state.inputHandlers.length, 0);
  assert.equal(w.state.unsubscribed, 1);
  await w.emit("session_start", { reason: "new" }, w.ctx);
  assert.equal(w.state.inputHandlers.length, 1);
  await waitFor(async () => (await status())?.phase === "idle");
});
