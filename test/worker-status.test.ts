import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentStatus } from "../src/store.ts";
import { formatActivity, initialStatus, isUrgent, reduceStatus, type WorkerEvent } from "../src/worker-status.ts";

const T0 = 1_700_000_000_000;
const T1 = T0 + 1_000;

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return { ...initialStatus(T0), ...overrides };
}

function assistant(content: unknown[], stopReason = "stop"): Record<string, unknown> {
  return { role: "assistant", content, stopReason };
}

// --- initialStatus ---

test("initialStatus is idle with every other field null", () => {
  assert.deepEqual(initialStatus(T0), {
    phase: "idle",
    activity: null,
    lastText: null,
    lastOutcome: null,
    uiPrompt: null,
    sessionFile: null,
    pid: null,
    model: null,
    updatedAt: T0,
  });
});

// --- event table rows ---

test("session_start: phase idle, sessionFile, pid, model", () => {
  const s = reduceStatus(
    status({ phase: "exited", lastText: "kept" }),
    { type: "session_start", sessionFile: "/s/a.jsonl", pid: 42, model: "claude-x" },
    T1,
  );
  assert.deepEqual(s, status({ phase: "idle", lastText: "kept", sessionFile: "/s/a.jsonl", pid: 42, model: "claude-x", updatedAt: T1 }));
});

test("session_start with no session file or model stores nulls", () => {
  const s = reduceStatus(status(), { type: "session_start", sessionFile: null, pid: 7, model: null }, T1);
  assert.equal(s.sessionFile, null);
  assert.equal(s.model, null);
  assert.equal(s.pid, 7);
});

test("agent_start: phase working, activity null", () => {
  const s = reduceStatus(status({ activity: "bash: ls" }), { type: "agent_start" }, T1);
  assert.equal(s.phase, "working");
  assert.equal(s.activity, null);
  assert.equal(s.updatedAt, T1);
});

test("tool_execution_start: activity from tool and args", () => {
  const s = reduceStatus(
    status({ phase: "working" }),
    { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } },
    T1,
  );
  assert.equal(s.activity, "bash: npm test");
  assert.equal(s.phase, "working");
});

test("message_end (assistant): lastText is its text blocks joined with newline", () => {
  const message = assistant([
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "first" },
    { type: "toolCall", id: "1", name: "bash", arguments: {} },
    { type: "text", text: "second" },
  ]);
  const s = reduceStatus(status(), { type: "message_end", message }, T1);
  assert.equal(s.lastText, "first\nsecond");
});

test("message_end (assistant) without text keeps previous lastText", () => {
  const message = assistant([{ type: "toolCall", id: "1", name: "bash", arguments: {} }], "toolUse");
  const s = reduceStatus(status({ lastText: "before" }), { type: "message_end", message }, T1);
  assert.equal(s.lastText, "before");
});

test("message_end (assistant) with only whitespace text keeps previous lastText", () => {
  const s = reduceStatus(status({ lastText: "before" }), { type: "message_end", message: assistant([{ type: "text", text: "  " }]) }, T1);
  assert.equal(s.lastText, "before");
});

test("message_end for a non-assistant message does not change lastText", () => {
  const user = { role: "user", content: [{ type: "text", text: "hello" }] };
  const userString = { role: "user", content: "hello" };
  const toolResult = { role: "toolResult", content: [{ type: "text", text: "out" }] };
  for (const message of [user, userString, toolResult, null, "x"]) {
    const s = reduceStatus(status({ lastText: "before" }), { type: "message_end", message }, T1);
    assert.equal(s.lastText, "before");
  }
});

test("agent_end: lastOutcome from last assistant stopReason", () => {
  const cases: [string, AgentStatus["lastOutcome"]][] = [
    ["error", "error"],
    ["aborted", "aborted"],
    ["stop", "completed"],
    ["length", "completed"],
    ["toolUse", "completed"],
  ];
  for (const [stopReason, outcome] of cases) {
    const messages = [
      { role: "user", content: "go" },
      assistant([{ type: "text", text: "a" }], "stop"),
      assistant([{ type: "text", text: "b" }], stopReason),
      { role: "toolResult", content: [] },
    ];
    const s = reduceStatus(status({ phase: "working" }), { type: "agent_end", messages }, T1);
    assert.equal(s.lastOutcome, outcome, stopReason);
    assert.equal(s.phase, "working");
  }
});

test("agent_end uses the last assistant message, not an earlier error", () => {
  const messages = [assistant([], "error"), assistant([{ type: "text", text: "ok" }], "stop")];
  assert.equal(reduceStatus(status(), { type: "agent_end", messages }, T1).lastOutcome, "completed");
});

test("agent_end with no assistant message is completed", () => {
  const s = reduceStatus(status({ lastOutcome: "error" }), { type: "agent_end", messages: [{ role: "user", content: "x" }] }, T1);
  assert.equal(s.lastOutcome, "completed");
  assert.equal(reduceStatus(status(), { type: "agent_end", messages: [] }, T1).lastOutcome, "completed");
});

test("agent_settled: phase idle, activity null", () => {
  const s = reduceStatus(status({ phase: "working", activity: "read a.ts" }), { type: "agent_settled" }, T1);
  assert.equal(s.phase, "idle");
  assert.equal(s.activity, null);
  assert.equal(s.updatedAt, T1);
});

test("ui_prompt_start sets uiPrompt {kind, title}", () => {
  const s = reduceStatus(status(), { type: "ui_prompt_start", kind: "confirm", title: "Delete it?" }, T1);
  assert.deepEqual(s.uiPrompt, { kind: "confirm", title: "Delete it?" });
});

test("ui_prompt_start without a title uses an empty title", () => {
  const s = reduceStatus(status(), { type: "ui_prompt_start", kind: "custom" }, T1);
  assert.deepEqual(s.uiPrompt, { kind: "custom", title: "" });
});

test("ui_prompt_end clears uiPrompt", () => {
  const s = reduceStatus(status({ uiPrompt: { kind: "select", title: "Pick" } }), { type: "ui_prompt_end" }, T1);
  assert.equal(s.uiPrompt, null);
});

test("model_select: model is the new model id", () => {
  const s = reduceStatus(status({ model: "old-model", phase: "working" }), { type: "model_select", model: "new-model" }, T1);
  assert.equal(s.model, "new-model");
  assert.equal(s.phase, "working");
  assert.equal(s.updatedAt, T1);
  assert.equal(reduceStatus(status({ model: "m" }), { type: "model_select", model: null }, T1).model, null);
});

test("session_shutdown: phase exited", () => {
  const s = reduceStatus(status({ phase: "working" }), { type: "session_shutdown" }, T1);
  assert.equal(s.phase, "exited");
  assert.equal(s.updatedAt, T1);
});

// --- purity ---

test("reduceStatus returns a new object and never mutates its input", () => {
  const before = status({ uiPrompt: { kind: "input", title: "Name" }, lastText: "x" });
  const snapshot = structuredClone(before);
  const events: WorkerEvent[] = [
    { type: "session_start", sessionFile: "/f", pid: 1, model: "m" },
    { type: "agent_start" },
    { type: "tool_execution_start", toolName: "read", args: { path: "a" } },
    { type: "message_end", message: assistant([{ type: "text", text: "y" }]) },
    { type: "agent_end", messages: [] },
    { type: "agent_settled" },
    { type: "ui_prompt_start", kind: "select", title: "t" },
    { type: "ui_prompt_end" },
    { type: "model_select", model: "m2" },
    { type: "session_shutdown" },
  ];
  for (const e of events) {
    const after = reduceStatus(before, e, T1);
    assert.notEqual(after, before, e.type);
    assert.equal(after.updatedAt, T1, e.type);
    assert.deepEqual(before, snapshot, e.type);
  }
});

// --- formatActivity ---

test("formatActivity: bash uses the first non-empty line of the command", () => {
  assert.equal(formatActivity("bash", { command: "\n  \n  cd src && ls\nnpm test" }), "bash: cd src && ls");
});

test("formatActivity: bash without a usable command is just the tool name", () => {
  assert.equal(formatActivity("bash", {}), "bash");
  assert.equal(formatActivity("bash", { command: "  \n" }), "bash");
  assert.equal(formatActivity("bash", null), "bash");
});

test("formatActivity: tools with path, file_path or filePath show the path", () => {
  assert.equal(formatActivity("read", { path: "src/a.ts" }), "read src/a.ts");
  assert.equal(formatActivity("edit", { file_path: "src/b.ts" }), "edit src/b.ts");
  assert.equal(formatActivity("write", { filePath: "src/c.ts" }), "write src/c.ts");
});

test("formatActivity: other tools show the tool name", () => {
  assert.equal(formatActivity("grep", { pattern: "x" }), "grep");
  assert.equal(formatActivity("todo", undefined), "todo");
  assert.equal(formatActivity("read", { path: 3 }), "read");
});

test("formatActivity caps at 80 chars with an ellipsis", () => {
  const long = formatActivity("bash", { command: "echo " + "x".repeat(200) });
  assert.equal(long.length, 80);
  assert.ok(long.startsWith("bash: echo xxx"));
  assert.ok(long.endsWith("…"));
  const exact = "read " + "p".repeat(75);
  assert.equal(formatActivity("read", { path: "p".repeat(75) }), exact);
});

// --- isUrgent ---

test("isUrgent is true only for session start, settle, ui prompts and shutdown", () => {
  const urgent: WorkerEvent[] = [
    { type: "session_start", sessionFile: null, pid: 1, model: null },
    { type: "agent_settled" },
    { type: "ui_prompt_start", kind: "confirm" },
    { type: "ui_prompt_end" },
    { type: "session_shutdown" },
  ];
  const lazy: WorkerEvent[] = [
    { type: "agent_start" },
    { type: "tool_execution_start", toolName: "bash", args: {} },
    { type: "message_end", message: {} },
    { type: "agent_end", messages: [] },
    { type: "model_select", model: "m" },
  ];
  for (const e of urgent) assert.equal(isUrgent(e), true, e.type);
  for (const e of lazy) assert.equal(isUrgent(e), false, e.type);
});
