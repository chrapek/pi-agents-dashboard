import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMeta, AgentStatus } from "../src/store.ts";
import { deriveRow, sortRows, formatAge, GROUP_ORDER, GROUP_LABELS } from "../src/state.ts";
import type { Row } from "../src/state.ts";

const NOW = 1_700_000_000_000;

function meta(overrides: Partial<AgentMeta> = {}): AgentMeta {
  return {
    id: "fix-login-test-a1b2",
    name: "fix login test",
    prompt: "Fix login test",
    createdAt: NOW - 12 * 60_000,
    launchCwd: "/repos/my-app",
    cwd: "/home/.pi/agent/agents-dashboard/worktrees/my-app/fix-login-test-a1b2",
    repoRoot: "/repos/my-app",
    worktree: "/home/.pi/agent/agents-dashboard/worktrees/my-app/fix-login-test-a1b2",
    branch: "pi-agents/fix-login-test-a1b2",
    ...overrides,
  };
}

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    phase: "idle",
    activity: null,
    lastText: null,
    lastOutcome: null,
    uiPrompt: null,
    sessionFile: null,
    pid: null,
    model: null,
    updatedAt: NOW,
    ...overrides,
  };
}

// --- Row fields ---

test("deriveRow copies meta fields, basename repo, age and model", () => {
  const row = deriveRow(meta(), status({ model: "claude-x", lastOutcome: "completed", lastText: "All good." }), true, NOW);
  assert.deepEqual(row, {
    id: "fix-login-test-a1b2",
    name: "fix login test",
    repo: "my-app",
    branch: "pi-agents/fix-login-test-a1b2",
    state: "done",
    summary: "All good.",
    age: "12m",
    createdAt: NOW - 12 * 60_000,
    model: "claude-x",
    alive: true,
  } satisfies Row);
});

test("deriveRow shows 'no worktree' when meta.worktree is null", () => {
  const row = deriveRow(meta({ repoRoot: null, worktree: null, branch: null }), null, true, NOW);
  assert.equal(row.repo, "no worktree");
  assert.equal(row.branch, null);
  assert.equal(row.model, null);
});

// --- stopped ---

test("stopped: tmux session not alive, summary is lastText first non-empty line", () => {
  const row = deriveRow(meta(), status({ phase: "working", lastText: "\n\n  Fixed the test.  \nMore detail." }), false, NOW);
  assert.equal(row.state, "stopped");
  assert.equal(row.summary, "Fixed the test.");
  assert.equal(row.alive, false);
});

test("stopped wins over uiPrompt and a trailing question", () => {
  const row = deriveRow(
    meta(),
    status({ uiPrompt: { kind: "confirm", title: "Proceed?" }, lastOutcome: "completed", lastText: "Shall I?" }),
    false,
    NOW,
  );
  assert.equal(row.state, "stopped");
  assert.equal(row.summary, "Shall I?");
});

test("stopped with no status says 'Exited before starting'", () => {
  const row = deriveRow(meta(), null, false, NOW);
  assert.equal(row.state, "stopped");
  assert.equal(row.summary, "Exited before starting");
});

test("stopped with empty or whitespace lastText says 'Exited before starting'", () => {
  assert.equal(deriveRow(meta(), status({ lastText: null }), false, NOW).summary, "Exited before starting");
  assert.equal(deriveRow(meta(), status({ lastText: "  \n \n" }), false, NOW).summary, "Exited before starting");
});

// --- needs_input ---

test("needs_input: uiPrompt set, summary is uiPrompt.title", () => {
  const row = deriveRow(meta(), status({ uiPrompt: { kind: "select", title: "Pick a provider" } }), true, NOW);
  assert.equal(row.state, "needs_input");
  assert.equal(row.summary, "Pick a provider");
});

test("needs_input: uiPrompt wins regardless of phase", () => {
  const working = deriveRow(meta(), status({ phase: "working", activity: "bash: ls", uiPrompt: { kind: "confirm", title: "Run rm?" } }), true, NOW);
  assert.equal(working.state, "needs_input");
  assert.equal(working.summary, "Run rm?");
  const failed = deriveRow(meta(), status({ lastOutcome: "error", lastText: "Boom", uiPrompt: { kind: "input", title: "Token" } }), true, NOW);
  assert.equal(failed.state, "needs_input");
});

test("needs_input: uiPrompt title is collapsed to one line", () => {
  const row = deriveRow(meta(), status({ uiPrompt: { kind: "confirm", title: "  Delete\n  these files?  " } }), true, NOW);
  assert.equal(row.summary, "Delete these files?");
});

test("needs_input: empty uiPrompt.title falls back to last question sentence, else 'Waiting for input'", () => {
  const withQuestion = deriveRow(
    meta(),
    status({ uiPrompt: { kind: "confirm", title: "  " }, lastText: "I fixed it. Should I commit? Done." }),
    true,
    NOW,
  );
  assert.equal(withQuestion.state, "needs_input");
  assert.equal(withQuestion.summary, "Should I commit?");
  const without = deriveRow(meta(), status({ uiPrompt: { kind: "confirm", title: "" }, lastText: "No questions." }), true, NOW);
  assert.equal(without.summary, "Waiting for input");
});

test("needs_input: idle + completed + lastText ends with '?', summary is last question sentence", () => {
  const row = deriveRow(
    meta(),
    status({ lastOutcome: "completed", lastText: "I fixed the login test. Should I also update the snapshot?" }),
    true,
    NOW,
  );
  assert.equal(row.state, "needs_input");
  assert.equal(row.summary, "Should I also update the snapshot?");
});

test("needs_input: picks the last question when there are several", () => {
  const row = deriveRow(
    meta(),
    status({ lastOutcome: "completed", lastText: "Is A ok? I think so.\n\nOr should I try B instead?" }),
    true,
    NOW,
  );
  assert.equal(row.summary, "Or should I try B instead?");
});

test("needs_input: question sentence keeps markdown wrapping, collapsed to one line", () => {
  const row = deriveRow(
    meta(),
    status({ lastOutcome: "completed", lastText: "Done with step one.\n\n**Want me   to continue?**\n" }),
    true,
    NOW,
  );
  assert.equal(row.state, "needs_input");
  assert.equal(row.summary, "**Want me to continue?**");
});

/** Summary of an idle, completed agent with this lastText. */
function questionSummary(lastText: string): string {
  const row = deriveRow(meta(), status({ lastOutcome: "completed", lastText }), true, NOW);
  assert.equal(row.state, "needs_input");
  return row.summary;
}

test("needs_input: a hard-wrapped question is joined into one sentence", () => {
  assert.equal(questionSummary("I fixed the test.\nShould I also\nupdate the snapshot?"), "Should I also update the snapshot?");
  assert.equal(questionSummary("Done.\r\nShould I also\r\nupdate the snapshot?"), "Should I also update the snapshot?");
});

test("needs_input: a blank line is a sentence boundary", () => {
  assert.equal(questionSummary("Summary of the change\n\nShould I continue?"), "Should I continue?");
  assert.equal(questionSummary("Summary of the change\n  \t\nShould I continue?"), "Should I continue?");
});

test("needs_input: list items stay separate sentences, continuation lines join their item", () => {
  assert.equal(questionSummary("Plan:\n- update tests\n- should I bump the version?"), "- should I bump the version?");
  assert.equal(questionSummary("Plan:\n* update tests\n+ should I bump?"), "+ should I bump?");
  assert.equal(questionSummary("Plan:\n1. update tests\n2) should I bump?"), "2) should I bump?");
  assert.equal(questionSummary("Plan:\n- update tests\n- should I bump\n  the version?"), "- should I bump the version?");
});

test("needs_input: a heading line is a sentence boundary", () => {
  assert.equal(questionSummary("# Next step\nShould I continue?"), "Should I continue?");
  assert.equal(questionSummary("Intro text\n## Should I continue?"), "## Should I continue?");
});

test("question rule needs idle + completed", () => {
  const text = "Should I continue?";
  assert.equal(deriveRow(meta(), status({ phase: "working", lastOutcome: "completed", lastText: text }), true, NOW).state, "working");
  assert.equal(deriveRow(meta(), status({ lastOutcome: "error", lastText: text }), true, NOW).state, "failed");
  assert.equal(deriveRow(meta(), status({ lastOutcome: "aborted", lastText: text }), true, NOW).state, "done");
  assert.equal(deriveRow(meta(), status({ lastOutcome: null, lastText: text }), true, NOW).state, "done");
  assert.equal(deriveRow(meta(), status({ phase: "exited", lastOutcome: "completed", lastText: text }), true, NOW).state, "done");
});

// --- "ends with ?" rule ---

/** True when an idle, completed agent with this lastText is classified as needs_input. */
function endsWithQuestion(lastText: string): boolean {
  return deriveRow(meta(), status({ lastOutcome: "completed", lastText }), true, NOW).state === "needs_input";
}

test("endsWithQuestion ignores trailing whitespace and * _ ` ) \" '", () => {
  assert.equal(endsWithQuestion("Ok?"), true);
  assert.equal(endsWithQuestion("Ok?  \n\t"), true);
  assert.equal(endsWithQuestion("**Ok?**"), true);
  assert.equal(endsWithQuestion("_Ok?_"), true);
  assert.equal(endsWithQuestion("`ok?`"), true);
  assert.equal(endsWithQuestion("(ok?)"), true);
  assert.equal(endsWithQuestion("He asked \"ok?\""), true);
  assert.equal(endsWithQuestion("'ok?'"), true);
  assert.equal(endsWithQuestion("(**\"ok?\"**) \n"), true);
});

test("endsWithQuestion is false for other endings", () => {
  assert.equal(endsWithQuestion("Ok."), false);
  assert.equal(endsWithQuestion("Ok?!"), false);
  assert.equal(endsWithQuestion("Is it? Yes"), false);
  assert.equal(endsWithQuestion("Ok?]"), false);
  assert.equal(endsWithQuestion("Ok?>"), false);
  assert.equal(endsWithQuestion(""), false);
  assert.equal(endsWithQuestion("  **  "), false);
});

test("lastText ending with ignored chars after '?' is needs_input", () => {
  const row = deriveRow(meta(), status({ lastOutcome: "completed", lastText: "Shall I merge (y/n?)`* \n" }), true, NOW);
  assert.equal(row.state, "needs_input");
  assert.equal(row.summary, "Shall I merge (y/n?)`*");
});

test("lastText with a question in the middle but not at the end is done", () => {
  const row = deriveRow(meta(), status({ lastOutcome: "completed", lastText: "Why did it fail? A typo. Fixed." }), true, NOW);
  assert.equal(row.state, "done");
  assert.equal(row.summary, "Why did it fail? A typo. Fixed.");
});

// --- working ---

test("working: no status yet is 'Starting…'", () => {
  const row = deriveRow(meta(), null, true, NOW);
  assert.equal(row.state, "working");
  assert.equal(row.summary, "Starting…");
});

test("working: phase=working shows activity", () => {
  const row = deriveRow(meta(), status({ phase: "working", activity: "bash: npm test" }), true, NOW);
  assert.equal(row.state, "working");
  assert.equal(row.summary, "bash: npm test");
});

test("working: phase=working without activity shows 'Working…'", () => {
  assert.equal(deriveRow(meta(), status({ phase: "working", activity: null }), true, NOW).summary, "Working…");
  assert.equal(deriveRow(meta(), status({ phase: "working", activity: "  " }), true, NOW).summary, "Working…");
});

test("working: phase=working wins over a previous error outcome", () => {
  const row = deriveRow(meta(), status({ phase: "working", lastOutcome: "error", lastText: "Boom" }), true, NOW);
  assert.equal(row.state, "working");
});

// --- failed ---

test("failed: idle + lastOutcome error, summary is lastText first line", () => {
  const row = deriveRow(meta(), status({ lastOutcome: "error", lastText: "Rate limited.\nRetry later." }), true, NOW);
  assert.equal(row.state, "failed");
  assert.equal(row.summary, "Rate limited.");
});

test("failed: empty lastText falls back to 'Failed'", () => {
  const row = deriveRow(meta(), status({ lastOutcome: "error", lastText: null }), true, NOW);
  assert.equal(row.state, "failed");
  assert.equal(row.summary, "Failed");
});

// --- done ---

test("done: idle + completed, summary is lastText first line", () => {
  const row = deriveRow(meta(), status({ lastOutcome: "completed", lastText: "\n  Fixed the login test.\n\nDetails..." }), true, NOW);
  assert.equal(row.state, "done");
  assert.equal(row.summary, "Fixed the login test.");
});

test("done: aborted outcome is done", () => {
  const row = deriveRow(meta(), status({ lastOutcome: "aborted", lastText: "Partial work" }), true, NOW);
  assert.equal(row.state, "done");
  assert.equal(row.summary, "Partial work");
});

test("done: idle with nothing yet (fresh session) falls back to 'Done'", () => {
  const row = deriveRow(meta(), status({ phase: "idle" }), true, NOW);
  assert.equal(row.state, "done");
  assert.equal(row.summary, "Done");
});

// --- sortRows ---

function row(id: string, state: Row["state"], createdAt: number): Row {
  return { id, name: id, repo: "r", branch: null, state, summary: "", age: "0s", createdAt, model: null, alive: true };
}

test("GROUP_ORDER and GROUP_LABELS", () => {
  assert.deepEqual(GROUP_ORDER, ["needs_input", "working", "done", "failed", "stopped"]);
  assert.deepEqual(GROUP_LABELS, {
    needs_input: "Needs input",
    working: "Working",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
  });
});

test("sortRows orders groups Needs input, Working, Done, Failed, Stopped; newest first inside a group", () => {
  const input = [
    row("s1", "stopped", 1),
    row("d1", "done", 1),
    row("f1", "failed", 5),
    row("w1", "working", 1),
    row("n1", "needs_input", 1),
    row("d2", "done", 3),
    row("w2", "working", 9),
    row("n2", "needs_input", 2),
  ];
  const copy = input.slice();
  const sorted = sortRows(input);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["n2", "n1", "w2", "w1", "d2", "d1", "f1", "s1"],
  );
  assert.deepEqual(input, copy, "input not mutated");
  assert.notEqual(sorted, input);
});

test("sortRows of empty list is empty", () => {
  assert.deepEqual(sortRows([]), []);
});

// --- formatAge ---

test("formatAge: under a minute is `just now`, then m, h, d with floor", () => {
  assert.equal(formatAge(0), "just now");
  assert.equal(formatAge(999), "just now");
  assert.equal(formatAge(45_000), "just now");
  assert.equal(formatAge(59_999), "just now");
  assert.equal(formatAge(60_000), "1m");
  assert.equal(formatAge(12 * 60_000 + 59_000), "12m");
  assert.equal(formatAge(3_600_000 - 1), "59m");
  assert.equal(formatAge(3_600_000), "1h");
  assert.equal(formatAge(3 * 3_600_000), "3h");
  assert.equal(formatAge(24 * 3_600_000 - 1), "23h");
  assert.equal(formatAge(24 * 3_600_000), "1d");
  assert.equal(formatAge(60_000 * 60 * 24), "1d");
  assert.equal(formatAge(2 * 86_400_000 + 5_000), "2d");
});

test("formatAge of negative or non-finite is `just now`", () => {
  assert.equal(formatAge(-5_000), "just now");
  assert.equal(formatAge(Number.NaN), "just now");
});

test("deriveRow age is now - createdAt, clock skew shows `just now`", () => {
  assert.equal(deriveRow(meta({ createdAt: NOW - 45_000 }), null, true, NOW).age, "just now");
  assert.equal(deriveRow(meta({ createdAt: NOW - 12 * 60_000 }), null, true, NOW).age, "12m");
  assert.equal(deriveRow(meta({ createdAt: NOW - 3 * 3_600_000 }), null, true, NOW).age, "3h");
  assert.equal(deriveRow(meta({ createdAt: NOW + 10_000 }), null, true, NOW).age, "just now");
});
