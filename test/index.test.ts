import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { NEEDS_TUI_MESSAGE } from "../src/dashboard-role.ts";
import { readStatus, writeMeta } from "../src/store.ts";
import { DETACH_FIRST_MESSAGE } from "../src/worker.ts";

const ID = "fix-bug-a1b2";
const WORKER_KEY = Symbol.for("pi-agent-dashboard.worker");
const ENV_VARS = ["PI_AGENTS_ID", "PI_AGENTS_HOME", "PI_CODING_AGENT_DIR"] as const;

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: CommandHandler }>();
  const flags: string[] = [];
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand(name: string, options: { description?: string; handler: CommandHandler }) {
      commands.set(name, options);
    },
    registerFlag(name: string) {
      flags.push(name);
    },
    getFlag: () => undefined,
    sendUserMessage: () => {},
  };
  async function emit(type: string, event: Record<string, unknown>, ctx: unknown): Promise<void> {
    for (const h of handlers.get(type) ?? []) await h({ type, ...event }, ctx);
  }
  return { pi: api as unknown as ExtensionAPI, handlers, commands, flags, emit };
}

function fakeCtx(mode: string) {
  const notes: [string, unknown][] = [];
  const ctx = {
    mode,
    hasUI: false,
    cwd: "/launch",
    model: undefined,
    isIdle: () => true,
    sessionManager: { getSessionFile: () => "/sessions/a.jsonl" },
    ui: { notify: (message: string, type?: unknown) => notes.push([message, type]) },
  };
  return { ctx, notes };
}

/** Runs one worker session (start + shutdown) and returns the status it wrote under `home`, if any. */
async function runWorkerSession(emit: ReturnType<typeof fakePi>["emit"], home: string) {
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
  const { ctx } = fakeCtx("tui");
  await emit("session_start", { reason: "startup" }, ctx);
  await emit("session_shutdown", { reason: "quit" }, ctx);
  return readStatus(home, ID);
}

let tmp: string;
const saved: Record<string, string | undefined> = {};

function resetWorkerIdentity(): void {
  delete (globalThis as Record<symbol, unknown>)[WORKER_KEY];
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-index-test-"));
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  resetWorkerIdentity();
});

afterEach(async () => {
  resetWorkerIdentity();
  for (const name of ENV_VARS) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

test("the first load with PI_AGENTS_ID picks the worker role and removes both vars from the env", async () => {
  process.env.PI_AGENTS_ID = ID;
  process.env.PI_AGENTS_HOME = tmp;
  const { pi, commands, flags, handlers, emit } = fakePi();
  extension(pi);
  assert.equal(process.env.PI_AGENTS_ID, undefined);
  assert.equal(process.env.PI_AGENTS_HOME, undefined);
  assert.deepEqual(flags, []);
  assert.ok(handlers.has("agent_start"), "worker mirrors agent events");
  const { ctx, notes } = fakeCtx("tui");
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(notes, [[DETACH_FIRST_MESSAGE, "info"]]);
  const status = await runWorkerSession(emit, tmp);
  assert.equal(status?.phase, "exited");
});

test("a later load in the same process (/new, /resume, /reload) keeps the worker role, id and home", async () => {
  process.env.PI_AGENTS_ID = ID;
  process.env.PI_AGENTS_HOME = tmp;
  extension(fakePi().pi);
  assert.equal(process.env.PI_AGENTS_ID, undefined);

  const second = fakePi();
  extension(second.pi);
  assert.deepEqual(second.flags, []);
  assert.ok(second.handlers.has("agent_start"));
  const { ctx, notes } = fakeCtx("tui");
  await second.commands.get("agents")!.handler("", ctx);
  assert.deepEqual(notes, [[DETACH_FIRST_MESSAGE, "info"]]);
  const status = await runWorkerSession(second.emit, tmp);
  assert.equal(status?.phase, "exited", "status goes to the saved home with the saved id");
});

test("without PI_AGENTS_HOME the worker home falls back to resolveHome() of the original env", async () => {
  process.env.PI_AGENTS_ID = ID;
  process.env.PI_CODING_AGENT_DIR = tmp;
  const { pi, emit } = fakePi();
  extension(pi);
  assert.equal(process.env.PI_AGENTS_ID, undefined);
  assert.equal(process.env.PI_CODING_AGENT_DIR, tmp, "only the dashboard's own vars are removed");
  delete process.env.PI_CODING_AGENT_DIR; // the saved home must not depend on the env any more
  const status = await runWorkerSession(emit, path.join(tmp, "agents-dashboard"));
  assert.equal(status?.phase, "exited");
});

test("a load in a fresh process without PI_AGENTS_ID picks the dashboard role and keeps PI_AGENTS_HOME", async () => {
  process.env.PI_AGENTS_HOME = tmp;
  const { pi, commands, flags, handlers } = fakePi();
  extension(pi);
  assert.deepEqual(flags, ["agents"]);
  assert.ok(!handlers.has("agent_start"), "dashboard role does not mirror agent events");
  assert.equal(process.env.PI_AGENTS_HOME, tmp, "the dashboard resolves its home from the env when it opens");
  const { ctx, notes } = fakeCtx("print");
  await commands.get("agents")!.handler("", ctx);
  assert.deepEqual(notes, [[NEEDS_TUI_MESSAGE, "warning"]]);
});

test("an empty PI_AGENTS_ID counts as unset", async () => {
  process.env.PI_AGENTS_ID = "";
  const { pi, flags } = fakePi();
  extension(pi);
  assert.deepEqual(flags, ["agents"]);
});
