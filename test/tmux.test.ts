import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TMUX_CONF, Tmux, TmuxError, TmuxNotFoundError } from "../src/tmux.ts";

const execFileAsync = promisify(execFile);
const RECORD_CHILD = fileURLToPath(new URL("./fixtures/tmux-record-child.ts", import.meta.url));
const NOT_FOUND_MESSAGE = "tmux not found — install tmux ≥ 3.5";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-tmux-test-"));
process.env.PI_AGENTS_HOME = tmpRoot;
const sockets: string[] = [];
let socketCounter = 0;

after(async () => {
  for (const socket of sockets) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // server already gone
    }
    // kill-server leaves the socket file behind
    await fs.rm(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid!()}`, socket), { force: true });
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A Tmux on a throwaway socket `pi-agents-test-<pid>-<n>`, killed in teardown. */
async function makeTmux(): Promise<{ tmux: Tmux; dir: string; socket: string }> {
  const socket = `pi-agents-test-${process.pid}-${++socketCounter}`;
  sockets.push(socket);
  const dir = await fs.mkdtemp(path.join(tmpRoot, "case-"));
  const tmux = new Tmux({ configPath: path.join(dir, "conf", "tmux.conf"), socket });
  return { tmux, dir, socket };
}

async function tmuxOut(socket: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["-L", socket, ...args]);
  return stdout.trim();
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

interface ChildRecord {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

const SPEC_CONF = `set -g status off
set -g prefix None
unbind C-b
bind -n 'C-\\' detach-client
set -g escape-time 0
set -g mouse on
set -g history-limit 10000
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features ',*:extkeys'
set -g default-terminal tmux-256color
set -g focus-events on
set -g allow-passthrough on
set -g window-size latest
`;

test("TMUX_CONF is exactly the spec §8 config", () => {
  assert.equal(TMUX_CONF, SPEC_CONF);
});

test("socket defaults to pi-agents", () => {
  assert.equal(new Tmux({ configPath: path.join(tmpRoot, "unused.conf") }).socket, "pi-agents");
});

test("ensureConfig writes TMUX_CONF to configPath, creating parent dirs and overwriting", async () => {
  const { tmux, dir } = await makeTmux();
  const configPath = path.join(dir, "conf", "tmux.conf");
  await tmux.ensureConfig();
  assert.equal(await fs.readFile(configPath, "utf8"), SPEC_CONF);
  await fs.writeFile(configPath, "stale\n");
  await tmux.ensureConfig();
  assert.equal(await fs.readFile(configPath, "utf8"), SPEC_CONF);
});

test("liveSessions is empty before any server; tracks newSession and killSession", async () => {
  const { tmux, dir } = await makeTmux();
  await tmux.ensureConfig();
  assert.deepEqual(await tmux.liveSessions(), new Set());
  const record = path.join(dir, "rec.json");
  await tmux.newSession({
    name: "alpha-1a2b",
    cwd: dir,
    cols: 100,
    rows: 30,
    env: { TMUX_RECORD_FILE: record },
    argv: [process.execPath, RECORD_CHILD],
  });
  assert.deepEqual(await tmux.liveSessions(), new Set(["alpha-1a2b"]));
  await tmux.killSession("alpha-1a2b");
  assert.deepEqual(await tmux.liveSessions(), new Set());
});

test("newSession passes argv and env to the child verbatim and honours -c, -x, -y", async () => {
  const { tmux, dir, socket } = await makeTmux();
  await tmux.ensureConfig();
  const cwd = path.join(dir, "work dir 'q' #S #P ##");
  await fs.mkdir(cwd);
  const record = path.join(dir, "rec.json");
  const args = [
    "--session",
    "-x",
    "--",
    "-e",
    "arg with spaces",
    "it's single",
    'say "double"',
    "$HOME",
    "back\\slash\\\\n",
    "",
    "; echo pwned",
    "*",
    "line1\nline2",
    "ends;",
    "back\\;",
    ";",
  ];
  await tmux.newSession({
    name: "verbatim-0001",
    cwd,
    cols: 123,
    rows: 45,
    env: {
      TMUX_RECORD_FILE: record,
      PI_AGENTS_ID: "verbatim-0001",
      SPACEY: "a value with spaces",
      EQUALS: "k=v=w",
      QUOTES: `it's "quoted" $HOME \\`,
      SEMI: "value ends;",
    },
    argv: [process.execPath, RECORD_CHILD, ...args],
  });
  const got = JSON.parse(await waitForFile(record)) as ChildRecord;
  assert.deepEqual(got.argv, args);
  assert.equal(got.env.PI_AGENTS_ID, "verbatim-0001");
  assert.equal(got.env.SPACEY, "a value with spaces");
  assert.equal(got.env.EQUALS, "k=v=w");
  assert.equal(got.env.QUOTES, `it's "quoted" $HOME \\`);
  assert.equal(got.env.SEMI, "value ends;");
  assert.equal(await fs.realpath(got.cwd), await fs.realpath(cwd));
  assert.equal(await tmuxOut(socket, ["display", "-p", "-t", "=verbatim-0001:", "#{window_width}x#{window_height}"]), "123x45");
});

test("newSession with a single argv element execs it directly, not through a shell", async () => {
  const { tmux, dir } = await makeTmux();
  await tmux.ensureConfig();
  const scriptDir = path.join(dir, `odd 'dir' "x" $HOME`);
  await fs.mkdir(scriptDir);
  const script = path.join(scriptDir, "tmux-child.sh");
  await fs.writeFile(script, '#!/bin/sh\nprintf "%s|%s" "$0" "$#" > "$TMUX_RECORD_FILE"\nexec sleep 600\n', { mode: 0o755 });
  const record = path.join(dir, "rec.txt");
  await tmux.newSession({ name: "single-0001", cwd: dir, cols: 80, rows: 24, env: { TMUX_RECORD_FILE: record }, argv: [script] });
  assert.equal(await waitForFile(record), `${script}|0`);
});

test("the started server uses the written config", async () => {
  const { tmux, dir, socket } = await makeTmux();
  await tmux.ensureConfig();
  await tmux.newSession({
    name: "conf-0001",
    cwd: dir,
    cols: 80,
    rows: 24,
    env: { TMUX_RECORD_FILE: path.join(dir, "rec.json") },
    argv: [process.execPath, RECORD_CHILD],
  });
  assert.equal(await tmuxOut(socket, ["show", "-gv", "status"]), "off");
  assert.equal(await tmuxOut(socket, ["show", "-gv", "escape-time"]), "0");
  assert.equal(await tmuxOut(socket, ["show", "-gv", "prefix"]), "None");
  assert.match(await tmuxOut(socket, ["list-keys", "-T", "root"]), /C-\\\\? +detach-client/);
});

test("newSession with a duplicate name throws TmuxError with the first stderr line", async () => {
  const { tmux, dir } = await makeTmux();
  await tmux.ensureConfig();
  const opts = {
    name: "dup-0001",
    cwd: dir,
    cols: 80,
    rows: 24,
    env: { TMUX_RECORD_FILE: path.join(dir, "rec.json") },
    argv: [process.execPath, RECORD_CHILD],
  };
  await tmux.newSession(opts);
  await assert.rejects(tmux.newSession(opts), (err: unknown) => {
    assert.ok(err instanceof TmuxError);
    assert.equal(err.cmd, "new-session");
    assert.match(err.stderr, /duplicate session/);
    assert.equal(err.message, "tmux new-session failed: duplicate session: dup-0001");
    return true;
  });
});

test("killSession is ok when the server or session doesn't exist, and matches names exactly", async () => {
  const { tmux, dir } = await makeTmux();
  await tmux.ensureConfig();
  await tmux.killSession("nope-0000");
  await tmux.newSession({
    name: "exact-0001",
    cwd: dir,
    cols: 80,
    rows: 24,
    env: { TMUX_RECORD_FILE: path.join(dir, "rec.json") },
    argv: [process.execPath, RECORD_CHILD],
  });
  await tmux.killSession("exact");
  await tmux.killSession("nope-0000");
  assert.deepEqual(await tmux.liveSessions(), new Set(["exact-0001"]));
});

test("attachSync strips TMUX and TMUX_PANE from the child env without mutating process.env", async () => {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "attach-"));
  const bin = path.join(dir, "fake-tmux");
  const argsOut = path.join(dir, "args.txt");
  const envOut = path.join(dir, "env.txt");
  await fs.writeFile(
    bin,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argsOut}'\nenv > '${envOut}'\nexit 7\n`,
    { mode: 0o755 },
  );
  const configPath = path.join(dir, "tmux.conf");
  const tmux = new Tmux({ configPath, socket: "pi-agents-test-fake", bin });
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, KEEP: process.env.PI_AGENTS_TEST_KEEP };
  process.env.TMUX = "/tmp/outer-tmux,123,0";
  process.env.TMUX_PANE = "%9";
  process.env.PI_AGENTS_TEST_KEEP = "kept value";
  const before = { ...process.env };
  try {
    const result = tmux.attachSync("agent-0001");
    assert.equal(result.status, 7);
    assert.equal(result.error, undefined);
    assert.deepEqual({ ...process.env }, before);
  } finally {
    for (const [k, v] of Object.entries({ TMUX: saved.TMUX, TMUX_PANE: saved.TMUX_PANE, PI_AGENTS_TEST_KEEP: saved.KEEP })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.deepEqual((await fs.readFile(argsOut, "utf8")).split("\n").slice(0, -1), [
    "-L",
    "pi-agents-test-fake",
    "-f",
    configPath,
    "attach-session",
    "-t",
    "=agent-0001",
  ]);
  const env = await fs.readFile(envOut, "utf8");
  assert.doesNotMatch(env, /^TMUX=/m);
  assert.doesNotMatch(env, /^TMUX_PANE=/m);
  assert.match(env, /^PI_AGENTS_TEST_KEEP=kept value$/m);
});

test("liveSessions/killSession treat only a missing server as empty; other connection errors throw", async () => {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "connerr-"));
  const fakeTmux = async (stderr: string) => {
    const bin = path.join(dir, `fake-tmux-${Math.random().toString(16).slice(2)}`);
    await fs.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit 1\n`, { mode: 0o755 });
    return new Tmux({ configPath: path.join(dir, "tmux.conf"), socket: "pi-agents-test-fake", bin });
  };
  for (const stderr of ["no server running on /tmp/tmux-1/x", "error connecting to /tmp/tmux-1/x (No such file or directory)"]) {
    const tmux = await fakeTmux(stderr);
    assert.deepEqual(await tmux.liveSessions(), new Set());
    await tmux.killSession("x-0001");
  }
  const denied = await fakeTmux("error connecting to /tmp/tmux-1/x (Permission denied)");
  await assert.rejects(denied.liveSessions(), (err: unknown) => {
    assert.ok(err instanceof TmuxError);
    assert.equal(err.message, "tmux list-sessions failed: error connecting to /tmp/tmux-1/x (Permission denied)");
    return true;
  });
  await assert.rejects(denied.killSession("x-0001"), (err: unknown) => {
    assert.ok(err instanceof TmuxError);
    assert.equal(err.cmd, "kill-session");
    return true;
  });
});

test("a missing tmux binary gives TmuxNotFoundError with the spec §10 message from every method", async () => {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "missing-"));
  const tmux = new Tmux({ configPath: path.join(dir, "tmux.conf"), socket: "pi-agents-test-missing", bin: "/nonexistent/tmux" });
  const isNotFound = (err: unknown) => {
    assert.ok(err instanceof TmuxNotFoundError);
    assert.equal(err.message, NOT_FOUND_MESSAGE);
    return true;
  };
  await assert.rejects(tmux.liveSessions(), isNotFound);
  await assert.rejects(
    tmux.newSession({ name: "x-0001", cwd: dir, cols: 80, rows: 24, env: {}, argv: ["true", "x"] }),
    isNotFound,
  );
  await assert.rejects(tmux.killSession("x-0001"), isNotFound);
  const result = tmux.attachSync("x-0001");
  assert.equal(result.status, null);
  isNotFound(result.error);
});
