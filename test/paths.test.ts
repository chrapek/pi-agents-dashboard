import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveHome,
  tmuxConfPath,
  agentsDir,
  agentDir,
  metaPath,
  statusPath,
  inboxDir,
  worktreesDir,
  worktreePath,
} from "../src/paths.ts";

test("resolveHome prefers PI_AGENTS_HOME", () => {
  const env = { PI_AGENTS_HOME: "/tmp/pa-home", PI_CODING_AGENT_DIR: "/tmp/coding" };
  assert.equal(resolveHome(env, "/Users/me"), "/tmp/pa-home");
});

test("resolveHome falls back to PI_CODING_AGENT_DIR/agents-dashboard", () => {
  const env = { PI_CODING_AGENT_DIR: "/tmp/coding" };
  assert.equal(resolveHome(env, "/Users/me"), path.join("/tmp/coding", "agents-dashboard"));
});

test("resolveHome falls back to ~/.pi/agent/agents-dashboard", () => {
  assert.equal(resolveHome({}, "/Users/me"), path.join("/Users/me", ".pi", "agent", "agents-dashboard"));
});

test("resolveHome ignores empty env values", () => {
  const env = { PI_AGENTS_HOME: "", PI_CODING_AGENT_DIR: "" };
  assert.equal(resolveHome(env, "/Users/me"), path.join("/Users/me", ".pi", "agent", "agents-dashboard"));
});

test("resolveHome returns an absolute path for relative env values", () => {
  const home = resolveHome({ PI_AGENTS_HOME: "rel/home" }, "/Users/me");
  assert.ok(path.isAbsolute(home));
  assert.equal(home, path.resolve("rel/home"));
});

test("resolveHome expands a leading ~ in PI_AGENTS_HOME using homedir", () => {
  assert.equal(resolveHome({ PI_AGENTS_HOME: "~" }, "/Users/me"), "/Users/me");
  assert.equal(resolveHome({ PI_AGENTS_HOME: "~/agents-home" }, "/Users/me"), "/Users/me/agents-home");
});

test("resolveHome expands a leading ~ in PI_CODING_AGENT_DIR using homedir", () => {
  assert.equal(resolveHome({ PI_CODING_AGENT_DIR: "~" }, "/Users/me"), "/Users/me/agents-dashboard");
  assert.equal(
    resolveHome({ PI_CODING_AGENT_DIR: "~/.pi/custom" }, "/Users/me"),
    "/Users/me/.pi/custom/agents-dashboard",
  );
});

test("resolveHome does not expand ~user or a ~ that is not leading", () => {
  assert.equal(resolveHome({ PI_AGENTS_HOME: "/data/~/x" }, "/Users/me"), "/data/~/x");
  assert.equal(resolveHome({ PI_AGENTS_HOME: "~other/x" }, "/Users/me"), path.resolve("~other/x"));
});

test("agent path helpers reject ids outside [a-z0-9-]", () => {
  for (const bad of ["", ".", "..", "../x", "a/b", "Upper", "with space", "x\\y"]) {
    assert.throws(() => agentDir("/h", bad), /invalid agent id/i, `id: ${JSON.stringify(bad)}`);
    assert.throws(() => statusPath("/h", bad), /invalid agent id/i);
    assert.throws(() => worktreePath("/h", "repo", bad), /invalid agent id/i);
  }
  assert.equal(agentDir("/h", "ok-1234"), "/h/agents/ok-1234");
});

test("path helpers match spec §3 layout", () => {
  const home = "/h";
  assert.equal(tmuxConfPath(home), "/h/tmux.conf");
  assert.equal(agentsDir(home), "/h/agents");
  assert.equal(agentDir(home, "fix-bug-a1b2"), "/h/agents/fix-bug-a1b2");
  assert.equal(metaPath(home, "fix-bug-a1b2"), "/h/agents/fix-bug-a1b2/meta.json");
  assert.equal(statusPath(home, "fix-bug-a1b2"), "/h/agents/fix-bug-a1b2/status.json");
  assert.equal(inboxDir(home, "fix-bug-a1b2"), "/h/agents/fix-bug-a1b2/inbox");
  assert.equal(worktreesDir(home), "/h/worktrees");
  assert.equal(worktreePath(home, "my-repo", "fix-bug-a1b2"), "/h/worktrees/my-repo/fix-bug-a1b2");
});
