import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgentService } from "../src/service.ts";
import type { AgentServiceOptions } from "../src/service.ts";
import { Tmux, TmuxError, TmuxNotFoundError } from "../src/tmux.ts";
import type { NewSessionOptions } from "../src/tmux.ts";
import { agentDir, inboxDir, tmuxConfPath } from "../src/paths.ts";
import { readMeta, writeMeta, writeStatus } from "../src/store.ts";
import type { AgentStatus } from "../src/store.ts";

// Isolate every git call (ours and the module's) from the user's git config.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const run = promisify(execFile);

const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-service-test-")));
process.env.PI_AGENTS_HOME = path.join(tmpRoot, "unused-home");
const sockets: string[] = [];
let counter = 0;

/** A fresh throwaway socket name `pi-agents-test-<pid>-<n>`, killed in teardown. */
function testSocket(): string {
  const socket = `pi-agents-test-${process.pid}-${++counter}`;
  sockets.push(socket);
  return socket;
}

/** Kills every throwaway tmux server started so far and removes its socket file. */
async function killTestServers(): Promise<void> {
  for (const socket of sockets.splice(0)) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // server already gone
    }
    await fs.rm(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid!()}`, socket), { force: true });
  }
}

afterEach(killTestServers);

after(async () => {
  await killTestServers();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// --- helpers -----------------------------------------------------------------

const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
];

function helperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  return env;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    { env: helperEnv() },
  );
  return stdout.trim();
}

async function newDir(label: string): Promise<string> {
  const dir = path.join(tmpRoot, `${label}-${++counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function repoWithCommit(name = "myrepo"): Promise<string> {
  const repo = path.join(await newDir("repos"), name);
  await fs.mkdir(repo);
  await git(repo, "init", "-q", "--template=", "-b", "main");
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface PiRecord {
  argv: string[];
  env: { PI_AGENTS_ID?: string; PI_AGENTS_HOME?: string; HERDR_ENV?: string };
  cwd: string;
}

interface Fixture {
  home: string;
  tmux: Tmux;
  socket: string;
  service: AgentService;
  /** Where the fake pi records its latest start for `id`. */
  recordFile(id: string): string;
  /** Record the fake pi wrote on its latest start for `id` (waits for it). */
  record(id: string): Promise<PiRecord>;
  /** Forget the latest record so the next start can be awaited. */
  clearRecord(id: string): Promise<void>;
}

/**
 * Checked-in fakes: macOS scans every freshly written executable on its first exec, which takes
 * seconds under parallel test load. The fake pi records its start to
 * `<dirname($PI_AGENTS_HOME)>/pi-records/<PI_AGENTS_ID>.json` and stays alive.
 */
const FAKE_PI = fileURLToPath(new URL("./fixtures/service-fake-pi.cjs", import.meta.url));
const FAILING_TMUX = fileURLToPath(new URL("./fixtures/service-failing-tmux.sh", import.meta.url));

before(async () => {
  await run(FAKE_PI, ["--warmup"]);
  await run(FAILING_TMUX, []);
});

/** Temp home, a throwaway tmux socket, and the fake pi. */
async function fixture(
  opts: Partial<AgentServiceOptions> = {},
  makeTmux?: (configPath: string, socket: string) => Tmux,
): Promise<Fixture> {
  const base = await newDir("case");
  const home = path.join(base, "home");
  const socket = testSocket();
  const tmux = makeTmux ? makeTmux(tmuxConfPath(home), socket) : new Tmux({ configPath: tmuxConfPath(home), socket });
  const service = new AgentService({ home, tmux, piBin: FAKE_PI, size: () => ({ cols: 101, rows: 33 }), ...opts });
  const recordFile = (id: string) => path.join(base, "pi-records", `${id}.json`);
  return {
    home,
    tmux,
    socket,
    service,
    recordFile,
    record: (id) =>
      waitFor(async () => {
        try {
          return JSON.parse(await fs.readFile(recordFile(id), "utf8")) as PiRecord;
        } catch {
          return undefined;
        }
      }),
    clearRecord: (id) => fs.rm(recordFile(id), { force: true }),
  };
}

async function inboxTexts(home: string, id: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await fs.readdir(inboxDir(home, id))).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const name of names) {
    texts.push((JSON.parse(await fs.readFile(path.join(inboxDir(home, id), name), "utf8")) as { text: string }).text);
  }
  return texts;
}

function status(partial: Partial<AgentStatus>): AgentStatus {
  return {
    phase: "idle",
    activity: null,
    lastText: null,
    lastOutcome: null,
    uiPrompt: null,
    sessionFile: null,
    pid: null,
    model: null,
    updatedAt: 1,
    ...partial,
  };
}

const PROMPT = `  --help "quoted" it's $HOME; echo pwned  `;
const TRIMMED = PROMPT.trim();

// --- dispatch ----------------------------------------------------------------

test("dispatch in a repo creates worktree + branch, writes meta, starts tmux with spec §4 argv/env/cwd/size", async () => {
  const f = await fixture({ now: () => 1_000_000, randHex: () => "beef" });
  const repo = await repoWithCommit("myrepo");
  const sub = path.join(repo, "sub");
  await fs.mkdir(sub);

  const meta = await f.service.dispatch(PROMPT, sub);

  const id = "help-quoted-it-s-home-echo-pwned-beef";
  const worktree = path.join(f.home, "worktrees", "myrepo", id);
  assert.deepEqual(meta, {
    id,
    name: "help quoted it s home echo pwned",
    prompt: TRIMMED,
    createdAt: 1_000_000,
    launchCwd: sub,
    cwd: worktree,
    repoRoot: repo,
    worktree,
    branch: `pi-agents/${id}`,
  });
  assert.deepEqual(await readMeta(f.home, id), meta);
  assert.ok(await exists(path.join(worktree, "README.md")));
  assert.equal(await git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), `pi-agents/${id}`);
  assert.equal(await fs.readFile(tmuxConfPath(f.home), "utf8").then((s) => s.includes("prefix None")), true);

  const rec = await f.record(id);
  assert.deepEqual(rec.argv, ["--tui-mode", "fullscreen", "--name", meta.name, "--", TRIMMED]);
  assert.deepEqual(rec.env, { PI_AGENTS_ID: id, PI_AGENTS_HOME: f.home, HERDR_ENV: "0" });
  assert.equal(await fs.realpath(rec.cwd), await fs.realpath(worktree));
  assert.deepEqual(await f.tmux.liveSessions(), new Set([id]));
  const { stdout } = await run("tmux", ["-L", f.socket, "display", "-p", "-t", `=${id}:`, "#{window_width}x#{window_height}"]);
  assert.equal(stdout.trim(), "101x33");
});

test("dispatch outside a repo: no worktree, cwd = launchCwd, row repo is `no worktree`", async () => {
  const f = await fixture({ randHex: () => "0a0b" });
  const launchCwd = await newDir("plain");

  const meta = await f.service.dispatch("fix the thing", launchCwd);

  assert.equal(meta.id, "fix-the-thing-0a0b");
  assert.equal(meta.cwd, launchCwd);
  assert.equal(meta.repoRoot, null);
  assert.equal(meta.worktree, null);
  assert.equal(meta.branch, null);
  assert.equal(await exists(path.join(f.home, "worktrees")), false);
  const rec = await f.record(meta.id);
  assert.deepEqual(rec.argv, ["--tui-mode", "fullscreen", "--name", "fix the thing", "--", "fix the thing"]);
  assert.equal(await fs.realpath(rec.cwd), await fs.realpath(launchCwd));
  const rows = await f.service.snapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.repo, "no worktree");
  assert.equal(rows[0]!.alive, true);
});

test("piBin defaults to env.PI_AGENTS_PI_BIN", async () => {
  const f = await fixture();
  const service = new AgentService({ home: f.home, tmux: f.tmux, env: { PI_AGENTS_PI_BIN: FAKE_PI }, randHex: () => "e0e0" });
  const meta = await service.dispatch("from env", await newDir("plain"));
  assert.deepEqual((await f.record(meta.id)).argv, ["--tui-mode", "fullscreen", "--name", "from env", "--", "from env"]);
});

test("dispatch passes modelArgs before --name", async () => {
  const f = await fixture({ randHex: () => "c0de", modelArgs: () => ["--model", "anthropic/claude-opus-5-5", "--thinking", "high"] });
  const meta = await f.service.dispatch("pick a model", await newDir("plain"));
  assert.deepEqual((await f.record(meta.id)).argv, [
    "--tui-mode", "fullscreen", "--model", "anthropic/claude-opus-5-5", "--thinking", "high",
    "--name", "pick a model", "--", "pick a model",
  ]);
});

/** A namer whose answer the test releases by hand; records the prompts it was asked about. */
function gatedNamer() {
  const prompts: string[] = [];
  let release!: (name: string | null) => void;
  const answer = new Promise<string | null>((resolve) => (release = resolve));
  return { prompts, release, answer, namer: (prompt: string) => (prompts.push(prompt), answer) };
}

test("dispatch returns at once with the slug name, then the namer's name replaces meta.name", async () => {
  const g = gatedNamer();
  const f = await fixture({ randHex: () => "face", namer: () => g.namer });
  const meta = await f.service.dispatch("  the login page redirects to 404, fix it  ", await newDir("plain"));

  assert.equal(meta.name, "the login page redirects to 404");
  assert.deepEqual(g.prompts, ["the login page redirects to 404, fix it"]);
  assert.equal((await readMeta(f.home, meta.id))!.name, meta.name);
  assert.deepEqual((await f.record(meta.id)).argv.slice(2, 4), ["--name", meta.name]);

  g.release("Fix login redirect");
  const renamed = await waitFor(async () => {
    const m = await readMeta(f.home, meta.id);
    return m?.name === "Fix login redirect" ? m : undefined;
  }, 5_000);
  assert.deepEqual(renamed, { ...meta, name: "Fix login redirect" });
  assert.equal((await f.service.snapshot())[0]!.name, "Fix login redirect");
});

test("a null name from the namer leaves the slug name", async () => {
  const g = gatedNamer();
  const f = await fixture({ randHex: () => "face", namer: () => g.namer });
  const meta = await f.service.dispatch("keep my name", await newDir("plain"));
  g.release(null);
  await g.answer;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readMeta(f.home, meta.id))!.name, "keep my name");
});

test("a name arriving after the agent was removed is dropped without recreating the agent dir", async () => {
  const g = gatedNamer();
  const f = await fixture({ randHex: () => "face", namer: () => g.namer });
  const meta = await f.service.dispatch("short lived", await newDir("plain"));
  assert.deepEqual(await f.service.remove(meta.id, true), { removed: true });
  g.release("Too late");
  await g.answer;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
});

test("a failed dispatch never applies the name", async () => {
  const g = gatedNamer();
  const base = await newDir("case");
  const home = path.join(base, "home");
  const tmux = new Tmux({ configPath: tmuxConfPath(home), bin: FAILING_TMUX, socket: testSocket() });
  const service = new AgentService({ home, tmux, piBin: "/bin/true", randHex: () => "dead", namer: () => g.namer });
  await assert.rejects(service.dispatch("doomed", await newDir("plain")));
  g.release("Doomed task");
  await g.answer;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await exists(agentDir(home, "doomed-dead")), false);
});

test("no namer (or a getter returning null) keeps today's behaviour", async () => {
  const f = await fixture({ randHex: () => "face", namer: () => null });
  const meta = await f.service.dispatch("plain name", await newDir("plain"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readMeta(f.home, meta.id))!.name, "plain name");
});

test("dispatch rejects an empty or whitespace-only prompt without creating anything", async () => {
  const f = await fixture();
  const launchCwd = await newDir("plain");
  await assert.rejects(f.service.dispatch("   \n ", launchCwd), /prompt/i);
  assert.equal(await exists(f.home), false);
});

test("dispatch picks another id when the agent dir or a live session already uses it", async () => {
  const hexes = ["aaaa", "aaaa", "bbbb", "cccc"];
  const f = await fixture({ randHex: () => hexes.shift()! });
  const launchCwd = await newDir("plain");
  await fs.mkdir(agentDir(f.home, "dup-aaaa"), { recursive: true });
  // a live session named dup-bbbb without an agent dir
  await f.tmux.ensureConfig();
  await f.tmux.newSession({ name: "dup-bbbb", cwd: launchCwd, cols: 80, rows: 24, env: {}, argv: ["sleep", "300"] });

  const meta = await f.service.dispatch("dup", launchCwd);
  assert.equal(meta.id, "dup-cccc");
});

test("dispatch gives up after bounded retries when every id collides", async () => {
  const f = await fixture({ randHex: () => "aaaa" });
  const launchCwd = await newDir("plain");
  await fs.mkdir(agentDir(f.home, "dup-aaaa"), { recursive: true });
  await assert.rejects(f.service.dispatch("dup", launchCwd), /id/i);
});

test("dispatch rolls back worktree, branch and agent dir when tmux new-session fails", async () => {
  const base = await newDir("case");
  const home = path.join(base, "home");
  const tmux = new Tmux({ configPath: tmuxConfPath(home), bin: FAILING_TMUX, socket: testSocket() });
  const service = new AgentService({ home, tmux, piBin: "/bin/true", randHex: () => "dead" });
  const repo = await repoWithCommit("rb");

  await assert.rejects(service.dispatch("roll me back", repo), {
    message: "tmux new-session failed: fake new-session failure",
  });

  const id = "roll-me-back-dead";
  assert.equal(await exists(path.join(home, "worktrees", "rb", id)), false);
  assert.equal(await branchExists(repo, `pi-agents/${id}`), false);
  assert.equal(await exists(agentDir(home, id)), false);
  assert.doesNotMatch(await git(repo, "worktree", "list", "--porcelain"), new RegExp(id));
});

/** Real tmux for listing; new-session behaves as if the tmux binary vanished. */
class TmuxMissingAtNewSession extends Tmux {
  async newSession(_opts: NewSessionOptions): Promise<void> {
    throw new TmuxNotFoundError();
  }
}

test("dispatch rolls back everything when tmux is missing at new-session (TmuxNotFoundError)", async () => {
  const f = await fixture({ randHex: () => "dead" }, (configPath, socket) => new TmuxMissingAtNewSession({ configPath, socket }));
  const repo = await repoWithCommit("missing");

  await assert.rejects(f.service.dispatch("no tmux", repo), TmuxNotFoundError);
  const id = "no-tmux-dead";
  assert.equal(await exists(path.join(f.home, "worktrees", "missing", id)), false);
  assert.equal(await branchExists(repo, `pi-agents/${id}`), false);
  assert.equal(await exists(agentDir(f.home, id)), false);
});

/** new-session starts the session, then reports failure (e.g. a timeout after tmux did its work). */
class TmuxFailsAfterStart extends Tmux {
  async newSession(opts: NewSessionOptions): Promise<void> {
    await super.newSession(opts);
    throw new TmuxError("new-session", "", "timed out after 10000ms");
  }
}

test("dispatch rollback also kills a session that new-session started before failing", async () => {
  const f = await fixture({ randHex: () => "fa11" }, (configPath, socket) => new TmuxFailsAfterStart({ configPath, socket }));
  // Outside a repo, so the session's cwd survives the rollback and only killSession can end it.
  const launchCwd = await newDir("plain");

  await assert.rejects(f.service.dispatch("half started", launchCwd), {
    message: "tmux new-session failed: timed out after 10000ms",
  });
  const id = "half-started-fa11";
  assert.deepEqual(await f.tmux.liveSessions(), new Set());
  assert.equal(await exists(agentDir(f.home, id)), false);
});

test("concurrent dispatches racing for the same id: the loser fails without deleting the winner's agent dir", async () => {
  const f = await fixture({ randHex: () => "aaaa" });
  const launchCwd = await newDir("plain");

  const results = await Promise.allSettled([f.service.dispatch("race", launchCwd), f.service.dispatch("race", launchCwd)]);
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.deepEqual(await readMeta(f.home, "race-aaaa"), (won[0] as PromiseFulfilledResult<unknown>).value);
  assert.deepEqual(await f.tmux.liveSessions(), new Set(["race-aaaa"]));
});

test("dispatch in a repo skips an id whose pi-agents/<id> branch already exists", async () => {
  const hexes = ["aaaa", "bbbb"];
  const f = await fixture({ randHex: () => hexes.shift()! });
  const repo = await repoWithCommit("branchy");
  await git(repo, "branch", "pi-agents/dup-aaaa");

  const meta = await f.service.dispatch("dup", repo);
  assert.equal(meta.id, "dup-bbbb");
  assert.equal(await branchExists(repo, "pi-agents/dup-aaaa"), true);
});

test("dispatch rolls back when worktree add fails (repo without commits): no agent dir, no branch", async () => {
  const f = await fixture({ randHex: () => "c0de" });
  const repo = path.join(await newDir("repos"), "empty");
  await fs.mkdir(repo);
  await git(repo, "init", "-q", "--template=", "-b", "main");

  await assert.rejects(f.service.dispatch("empty repo", repo), {
    name: "GitError",
    message: /^git worktree add failed: /,
  });
  const id = "empty-repo-c0de";
  assert.equal(await exists(agentDir(f.home, id)), false);
  assert.equal(await exists(path.join(f.home, "worktrees", "empty", id)), false);
  assert.equal(await branchExists(repo, `pi-agents/${id}`), false);
  assert.deepEqual(await f.tmux.liveSessions(), new Set());
});

// --- snapshot / peek ---------------------------------------------------------

test("snapshot derives rows from meta + status + live sessions, sorted by group then newest", async () => {
  let t = 10_000;
  const hexes = ["0001", "0002", "0003", "0004"];
  const f = await fixture({ now: () => t, randHex: () => hexes.shift()! });
  const launchCwd = await newDir("plain");

  const working = await f.service.dispatch("working one", launchCwd);
  t += 1000;
  const asking = await f.service.dispatch("asking one", launchCwd);
  t += 1000;
  const stopped = await f.service.dispatch("stopped one", launchCwd);
  t += 1000;
  const working2 = await f.service.dispatch("working two", launchCwd);
  await writeStatus(f.home, working.id, status({ phase: "working", activity: "editing", model: "m1" }));
  await writeStatus(f.home, asking.id, status({ lastOutcome: "completed", lastText: "Shall I proceed?" }));
  await writeStatus(f.home, stopped.id, status({ lastOutcome: "completed", lastText: "all done" }));
  await f.tmux.killSession(stopped.id);
  // working2 has no status yet: alive → working "Starting…"
  // an agent dir without valid meta is skipped
  await fs.mkdir(agentDir(f.home, "broken-ffff"), { recursive: true });
  await fs.writeFile(path.join(agentDir(f.home, "broken-ffff"), "meta.json"), "{nope");
  t = 3_000_000 + 10_000;

  const rows = await f.service.snapshot();
  assert.deepEqual(
    rows.map((r) => [r.id, r.state, r.summary, r.alive]),
    [
      [asking.id, "needs_input", "Shall I proceed?", true],
      [working2.id, "working", "Starting…", true],
      [working.id, "working", "editing", true],
      [stopped.id, "stopped", "all done", false],
    ],
  );
  assert.equal(rows.find((r) => r.id === working.id)!.model, "m1");
  assert.equal(rows.find((r) => r.id === working.id)!.age, "50m");
});

test("snapshot propagates TmuxNotFoundError", async () => {
  const base = await newDir("case");
  const home = path.join(base, "home");
  await writeMeta(home, {
    id: "x-0001", name: "x", prompt: "x", createdAt: 1, launchCwd: base, cwd: base, repoRoot: null, worktree: null, branch: null,
  });
  const tmux = new Tmux({ configPath: tmuxConfPath(home), bin: "/nonexistent/tmux", socket: testSocket() });
  const service = new AgentService({ home, tmux });
  await assert.rejects(service.snapshot(), TmuxNotFoundError);
});

test("peek returns meta, status and row; null for an unknown id", async () => {
  const f = await fixture({ now: () => 5000, randHex: () => "abcd" });
  const meta = await f.service.dispatch("peek me", await newDir("plain"));
  const st = status({ phase: "working", activity: "thinking" });
  await writeStatus(f.home, meta.id, st);

  const got = await f.service.peek(meta.id);
  assert.ok(got);
  assert.deepEqual(got.meta, meta);
  assert.deepEqual(got.status, st);
  assert.equal(got.row.state, "working");
  assert.equal(got.row.alive, true);
  assert.equal(await f.service.peek("nope-0000"), null);
});

// --- reply / ensureRunning ---------------------------------------------------

test("reply to a live session writes an inbox file and returns queued", async () => {
  const f = await fixture({ randHex: () => "1111" });
  const meta = await f.service.dispatch("talk to me", await newDir("plain"));
  await f.record(meta.id);
  await f.clearRecord(meta.id);

  assert.equal(await f.service.reply(meta.id, "--yes, go on"), "queued");
  assert.deepEqual(await inboxTexts(f.home, meta.id), ["--yes, go on"]);
  assert.deepEqual(await f.tmux.liveSessions(), new Set([meta.id]));
});

test("reply to a stopped session with a sessionFile restarts with --session <file> -- <text>", async () => {
  const f = await fixture({ randHex: () => "2222" });
  const repo = await repoWithCommit("resume");
  const meta = await f.service.dispatch("resume me", repo);
  await f.record(meta.id);
  const sessionFile = path.join(f.home, "sessions", "s 1.jsonl");
  await writeStatus(f.home, meta.id, status({ phase: "exited", sessionFile }));
  await f.tmux.killSession(meta.id);
  await f.clearRecord(meta.id);

  assert.equal(await f.service.reply(meta.id, "-- continue please"), "restarted");
  const rec = await f.record(meta.id);
  assert.deepEqual(rec.argv, ["--tui-mode", "fullscreen", "--session", sessionFile, "--", "-- continue please"]);
  assert.deepEqual(rec.env, { PI_AGENTS_ID: meta.id, PI_AGENTS_HOME: f.home, HERDR_ENV: "0" });
  assert.equal(await fs.realpath(rec.cwd), await fs.realpath(meta.cwd));
  assert.deepEqual(await inboxTexts(f.home, meta.id), []);
  assert.deepEqual(await f.tmux.liveSessions(), new Set([meta.id]));
});

test("reply to a stopped session without a sessionFile reruns the dispatch argv and queues the reply", async () => {
  const f = await fixture({ randHex: () => "3333" });
  const meta = await f.service.dispatch("rerun me", await newDir("plain"));
  await f.record(meta.id);
  await f.tmux.killSession(meta.id);
  await f.clearRecord(meta.id);

  assert.equal(await f.service.reply(meta.id, "the reply"), "restarted");
  const rec = await f.record(meta.id);
  assert.deepEqual(rec.argv, ["--tui-mode", "fullscreen", "--name", "rerun me", "--", "rerun me"]);
  assert.deepEqual(await inboxTexts(f.home, meta.id), ["the reply"]);
});

/** Reports no live sessions on its first liveSessions() call (another dashboard starts the session in between). */
class TmuxLosesStartRace extends Tmux {
  private stale = true;
  async liveSessions(): Promise<Set<string>> {
    if (this.stale) {
      this.stale = false;
      return new Set();
    }
    return super.liveSessions();
  }
}

test("reply that loses a restart race to another dashboard queues the reply and returns restarted", async () => {
  const f = await fixture({ randHex: () => "3a3a" });
  const meta = await f.service.dispatch("raced reply", await newDir("plain"));
  await f.record(meta.id);
  await writeStatus(f.home, meta.id, status({ phase: "exited", sessionFile: path.join(f.home, "s.jsonl") }));
  await f.clearRecord(meta.id);
  const racy = new AgentService({ home: f.home, tmux: new TmuxLosesStartRace({ configPath: tmuxConfPath(f.home), socket: f.socket }), piBin: FAKE_PI });

  assert.equal(await racy.reply(meta.id, "late reply"), "restarted");
  assert.deepEqual(await inboxTexts(f.home, meta.id), ["late reply"]);
  assert.deepEqual(await f.tmux.liveSessions(), new Set([meta.id]));
  await assert.rejects(fs.access(f.recordFile(meta.id)));
});

test("ensureRunning that loses a start race to another dashboard succeeds", async () => {
  const f = await fixture({ randHex: () => "4a4a" });
  const meta = await f.service.dispatch("raced start", await newDir("plain"));
  await f.record(meta.id);
  const racy = new AgentService({ home: f.home, tmux: new TmuxLosesStartRace({ configPath: tmuxConfPath(f.home), socket: f.socket }), piBin: FAKE_PI });

  await racy.ensureRunning(meta.id);
  assert.deepEqual(await f.tmux.liveSessions(), new Set([meta.id]));
  assert.deepEqual(await inboxTexts(f.home, meta.id), []);
});

test("reply to an unknown id rejects", async () => {
  const f = await fixture();
  await assert.rejects(f.service.reply("nope-0000", "hi"), /nope-0000/);
});

test("ensureRunning: no-op when alive; restarts with --session (no reply) or the dispatch argv when stopped", async () => {
  const f = await fixture({ randHex: () => "4444" });
  const meta = await f.service.dispatch("keep running", await newDir("plain"));
  await f.record(meta.id);
  await f.clearRecord(meta.id);

  await f.service.ensureRunning(meta.id);
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fs.access(f.recordFile(meta.id)));

  await f.tmux.killSession(meta.id);
  await f.service.ensureRunning(meta.id);
  assert.deepEqual((await f.record(meta.id)).argv, ["--tui-mode", "fullscreen", "--name", "keep running", "--", "keep running"]);

  const sessionFile = path.join(f.home, "s.jsonl");
  await writeStatus(f.home, meta.id, status({ phase: "exited", sessionFile }));
  await f.tmux.killSession(meta.id);
  await f.clearRecord(meta.id);
  await f.service.ensureRunning(meta.id);
  assert.deepEqual((await f.record(meta.id)).argv, ["--tui-mode", "fullscreen", "--session", sessionFile]);
  assert.deepEqual(await inboxTexts(f.home, meta.id), []);
});

test("ensureRunning on an unknown id rejects", async () => {
  const f = await fixture();
  await assert.rejects(f.service.ensureRunning("nope-0000"), /nope-0000/);
});

// --- remove ------------------------------------------------------------------

test("remove clean: kills session, removes worktree, deletes merged branch and agent dir, keeps session file", async () => {
  const f = await fixture({ randHex: () => "5555" });
  const repo = await repoWithCommit("clean");
  const meta = await f.service.dispatch("clean up", repo);
  await f.record(meta.id);
  const sessionFile = path.join(f.home, "pi-sessions", "keep.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "{}\n");
  await writeStatus(f.home, meta.id, status({ sessionFile }));

  assert.deepEqual(await f.service.remove(meta.id, false), { removed: true });
  assert.deepEqual(await f.tmux.liveSessions(), new Set());
  assert.equal(await exists(meta.worktree!), false);
  assert.equal(await branchExists(repo, meta.branch!), false);
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
  assert.equal(await exists(sessionFile), true);
});

test("remove a dirty worktree without force refuses and changes nothing; with force removes it", async () => {
  const f = await fixture({ randHex: () => "6666" });
  const repo = await repoWithCommit("dirty");
  const meta = await f.service.dispatch("dirty work", repo);
  await f.record(meta.id);
  await fs.writeFile(path.join(meta.worktree!, "untracked.txt"), "x\n");

  assert.deepEqual(await f.service.remove(meta.id, false), { removed: false, dirty: meta.worktree });
  assert.deepEqual(await f.tmux.liveSessions(), new Set([meta.id]));
  assert.equal(await exists(path.join(meta.worktree!, "untracked.txt")), true);
  assert.equal(await branchExists(repo, meta.branch!), true);
  assert.deepEqual(await readMeta(f.home, meta.id), meta);

  assert.deepEqual(await f.service.remove(meta.id, true), { removed: true });
  assert.deepEqual(await f.tmux.liveSessions(), new Set());
  assert.equal(await exists(meta.worktree!), false);
  assert.equal(await branchExists(repo, meta.branch!), false);
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
});

test("remove keeps an unmerged branch and reports branchKept", async () => {
  const f = await fixture({ randHex: () => "7777" });
  const repo = await repoWithCommit("unmerged");
  const meta = await f.service.dispatch("new commits", repo);
  await f.record(meta.id);
  await fs.writeFile(path.join(meta.worktree!, "feature.txt"), "y\n");
  await git(meta.worktree!, "add", "feature.txt");
  await git(meta.worktree!, "commit", "-q", "-m", "feature");

  assert.deepEqual(await f.service.remove(meta.id, false), { removed: true, branchKept: meta.branch });
  assert.equal(await exists(meta.worktree!), false);
  assert.equal(await branchExists(repo, meta.branch!), true);
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
});

test("remove without a worktree kills the session and removes the agent dir; unknown id → removed false", async () => {
  const f = await fixture({ randHex: () => "8888" });
  const meta = await f.service.dispatch("plain agent", await newDir("plain"));
  await f.record(meta.id);

  assert.deepEqual(await f.service.remove(meta.id, false), { removed: true });
  assert.deepEqual(await f.tmux.liveSessions(), new Set());
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
  assert.deepEqual(await f.service.remove("nope-0000", false), { removed: false });
});

test("remove succeeds when the worktree dir is already gone", async () => {
  const f = await fixture({ randHex: () => "9999" });
  const repo = await repoWithCommit("gone");
  const meta = await f.service.dispatch("gone already", repo);
  await f.record(meta.id);
  await f.tmux.killSession(meta.id);
  await fs.rm(meta.worktree!, { recursive: true, force: true });

  assert.deepEqual(await f.service.remove(meta.id, false), { removed: true });
  assert.equal(await branchExists(repo, meta.branch!), false);
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
});

test("remove when the repo is gone: refuses without force while the worktree exists; force removes everything", async () => {
  const f = await fixture({ randHex: () => "9a9a" });
  const repo = await repoWithCommit("deleted");
  const meta = await f.service.dispatch("repo vanished", repo);
  await f.record(meta.id);
  await fs.rm(repo, { recursive: true, force: true });

  assert.deepEqual(await f.service.remove(meta.id, false), { removed: false, dirty: meta.worktree });
  assert.deepEqual(await f.tmux.liveSessions(), new Set([meta.id]));
  assert.equal(await exists(meta.worktree!), true);
  assert.deepEqual(await readMeta(f.home, meta.id), meta);

  assert.deepEqual(await f.service.remove(meta.id, true), { removed: true });
  assert.deepEqual(await f.tmux.liveSessions(), new Set());
  assert.equal(await exists(meta.worktree!), false);
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
});

test("remove when the repo and the worktree are gone succeeds without force", async () => {
  const f = await fixture({ randHex: () => "9b9b" });
  const repo = await repoWithCommit("alsogone");
  const meta = await f.service.dispatch("all gone", repo);
  await f.record(meta.id);
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(meta.worktree!, { recursive: true, force: true });

  assert.deepEqual(await f.service.remove(meta.id, false), { removed: true });
  assert.deepEqual(await f.tmux.liveSessions(), new Set());
  assert.equal(await exists(agentDir(f.home, meta.id)), false);
});
