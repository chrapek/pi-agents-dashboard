import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeMeta,
  readMeta,
  listAgentIds,
  writeStatus,
  readStatus,
  enqueueInbox,
  drainInbox,
  removeAgentDir,
  type AgentMeta,
  type AgentStatus,
} from "../src/store.ts";
import { agentDir, inboxDir, metaPath, statusPath } from "../src/paths.ts";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-store-test-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function meta(id: string, overrides: Partial<AgentMeta> = {}): AgentMeta {
  return {
    id,
    name: id.replace(/-[0-9a-f]{4}$/, "").replace(/-/g, " "),
    prompt: "fix the bug",
    createdAt: 1_700_000_000_000,
    launchCwd: "/repo",
    cwd: `/h/worktrees/repo/${id}`,
    repoRoot: "/repo",
    worktree: `/h/worktrees/repo/${id}`,
    branch: `pi-agents/${id}`,
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
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function mkAgent(id: string): Promise<void> {
  await fs.mkdir(agentDir(home, id), { recursive: true });
}

// --- meta ---

test("writeMeta then readMeta round-trips", async () => {
  const m = meta("fix-bug-a1b2");
  await writeMeta(home, m);
  assert.deepEqual(await readMeta(home, m.id), m);
});

test("readMeta round-trips a non-repo agent with null fields", async () => {
  const m = meta("plain-0000", { repoRoot: null, worktree: null, branch: null, cwd: "/tmp/x" });
  await writeMeta(home, m);
  assert.deepEqual(await readMeta(home, m.id), m);
});

test("readMeta returns null when missing or invalid", async () => {
  assert.equal(await readMeta(home, "nope-0000"), null);
  await fs.mkdir(agentDir(home, "bad-0000"), { recursive: true });
  await fs.writeFile(metaPath(home, "bad-0000"), "{not json");
  assert.equal(await readMeta(home, "bad-0000"), null);
});

// --- listAgentIds ---

test("listAgentIds returns [] when home does not exist", async () => {
  assert.deepEqual(await listAgentIds(path.join(home, "missing")), []);
});

test("listAgentIds lists only agent dirs that have meta.json", async () => {
  await writeMeta(home, meta("b-agent-1111"));
  await writeMeta(home, meta("a-agent-2222"));
  await fs.mkdir(agentDir(home, "no-meta-3333"), { recursive: true });
  await fs.writeFile(path.join(home, "agents", "stray-file"), "x");
  assert.deepEqual(await listAgentIds(home), ["a-agent-2222", "b-agent-1111"]);
});

// --- status ---

test("writeStatus then readStatus round-trips", async () => {
  await mkAgent("w-0001");
  const s = status({
    phase: "working",
    activity: "bash: ls -la",
    lastText: "done",
    lastOutcome: "completed",
    uiPrompt: { kind: "confirm", title: "Run?" },
    sessionFile: "/s/x.jsonl",
    pid: 1234,
    model: "anthropic/claude",
    updatedAt: 42,
  });
  await writeStatus(home, "w-0001", s);
  assert.deepEqual(await readStatus(home, "w-0001"), s);
});

test("writeStatus skips silently when the agent dir is missing (does not recreate it)", async () => {
  await writeStatus(home, "gone-0002", status());
  await assert.rejects(fs.stat(agentDir(home, "gone-0002")), { code: "ENOENT" });
  assert.equal(await readStatus(home, "gone-0002"), null);
});

test("writeStatus after removeAgentDir does not resurrect the agent", async () => {
  const id = "deleted-0002";
  await writeMeta(home, meta(id));
  await writeStatus(home, id, status());
  await removeAgentDir(home, id);
  await writeStatus(home, id, status({ updatedAt: 99 }));
  await assert.rejects(fs.stat(agentDir(home, id)), { code: "ENOENT" });
  assert.deepEqual(await listAgentIds(home), []);
});

test("writeMeta creates the agent dir when missing", async () => {
  const m = meta("fresh-0002");
  await writeMeta(home, m);
  assert.ok((await fs.stat(agentDir(home, m.id))).isDirectory());
});

test("readStatus returns null for missing, empty, partial or invalid status", async () => {
  assert.equal(await readStatus(home, "missing-0000"), null);
  await fs.mkdir(agentDir(home, "x-0000"), { recursive: true });
  const p = statusPath(home, "x-0000");
  const bad = [
    "",
    "   ",
    '{"phase":"idle","activity":nu',
    "not json",
    "null",
    "[]",
    "42",
    JSON.stringify({ phase: "idle" }),
    JSON.stringify(status({ phase: "bogus" as never })),
    JSON.stringify(status({ lastOutcome: "meh" as never })),
    JSON.stringify(status({ updatedAt: "now" as never })),
    JSON.stringify(status({ uiPrompt: { kind: "x" } as never })),
    JSON.stringify(status({ pid: "1" as never })),
  ];
  for (const content of bad) {
    await fs.writeFile(p, content);
    assert.equal(await readStatus(home, "x-0000"), null, `content: ${content}`);
  }
});

test("readStatus returns null when status.json is a directory", async () => {
  await fs.mkdir(statusPath(home, "dir-0000"), { recursive: true });
  assert.equal(await readStatus(home, "dir-0000"), null);
});

test("writeStatus is atomic: concurrent readers never see a partial file, no tmp files remain", async () => {
  const id = "atomic-abcd";
  const big = "x".repeat(200_000);
  await mkAgent(id);
  await writeStatus(home, id, status({ lastText: big, updatedAt: 0 }));
  const p = statusPath(home, id);

  let writing = true;
  let reads = 0;
  const reader = async () => {
    while (writing) {
      const raw = await fs.readFile(p, "utf8");
      const parsed = JSON.parse(raw) as AgentStatus; // throws on a partial file
      assert.equal(parsed.lastText, big);
      reads++;
    }
  };
  const readers = [reader(), reader(), reader()];
  for (let i = 1; i <= 100; i++) {
    await writeStatus(home, id, status({ lastText: big, updatedAt: i }));
  }
  writing = false;
  await Promise.all(readers);

  assert.ok(reads > 0);
  assert.equal((await readStatus(home, id))?.updatedAt, 100);
  assert.deepEqual(await fs.readdir(agentDir(home, id)), ["status.json"]);
});

test("overlapping writeStatus calls: the last call wins on disk, no tmp files remain", async () => {
  const id = "race-0003";
  await mkAgent(id);
  // The first write is much larger (slower) than the rest; without serialization it would land last.
  const huge = "y".repeat(8_000_000);
  const writes = [writeStatus(home, id, status({ lastText: huge, updatedAt: 0 }))];
  for (let i = 1; i <= 50; i++) writes.push(writeStatus(home, id, status({ updatedAt: i })));
  await Promise.all(writes);
  assert.deepEqual(await readStatus(home, id), status({ updatedAt: 50 }));
  assert.deepEqual(await fs.readdir(agentDir(home, id)), ["status.json"]);
});

test("writeStatus serializes per path: a failed write does not block later writes", async () => {
  const id = "race-0004";
  await mkAgent(id);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const bad = writeStatus(home, id, status({ uiPrompt: circular as never }));
  const good = writeStatus(home, id, status({ updatedAt: 7 }));
  await assert.rejects(bad);
  await good;
  assert.equal((await readStatus(home, id))?.updatedAt, 7);
});

// --- inbox ---

test("enqueueInbox writes <ms>-<rand>.json with {text}", async () => {
  await mkAgent("i-0001");
  const name = await enqueueInbox(home, "i-0001", "hello");
  assert.match(name, /^\d{13}-[0-9a-f]+\.json$/);
  const raw = await fs.readFile(path.join(inboxDir(home, "i-0001"), name), "utf8");
  assert.deepEqual(JSON.parse(raw), { text: "hello" });
  assert.deepEqual(await fs.readdir(inboxDir(home, "i-0001")), [name]);
});

test("enqueueInbox filenames sort in enqueue order even within one millisecond", async () => {
  const names: string[] = [];
  await mkAgent("i-0002");
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 10_000 });
  try {
    for (let i = 0; i < 200; i++) names.push(await enqueueInbox(home, "i-0002", `m${i}`));
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual([...names].sort(), names);
  assert.equal(new Set(names).size, names.length);
  const got: string[] = [];
  await drainInbox(home, "i-0002", (t) => {
    got.push(t);
  });
  assert.deepEqual(got, names.map((_, i) => `m${i}`));
});

test("drainInbox delivers messages in enqueue order and deletes them", async () => {
  const id = "i-0003";
  await mkAgent(id);
  const texts = Array.from({ length: 30 }, (_, i) => `message ${i}`);
  for (const t of texts) await enqueueInbox(home, id, t);
  const got: string[] = [];
  const n = await drainInbox(home, id, (t) => {
    got.push(t);
  });
  assert.equal(n, texts.length);
  assert.deepEqual(got, texts);
  assert.deepEqual(await fs.readdir(inboxDir(home, id)), []);
  assert.equal(await drainInbox(home, id, () => assert.fail("nothing to deliver")), 0);
});

test("enqueueInbox rejects with a clear error when the agent dir is missing", async () => {
  await assert.rejects(enqueueInbox(home, "missing-0009", "hi"), /agent dir.*missing-0009/i);
  await assert.rejects(fs.stat(agentDir(home, "missing-0009")), { code: "ENOENT" });
});

test("concurrent drainInbox calls on one inbox never deliver a message twice", async () => {
  const id = "i-0008";
  await mkAgent(id);
  const texts = ["a", "b", "c"];
  for (const t of texts) await enqueueInbox(home, id, t);
  const got: string[] = [];
  const slowDeliver = async (t: string) => {
    await new Promise((r) => setTimeout(r, 20));
    got.push(t);
  };
  const counts = await Promise.all([
    drainInbox(home, id, slowDeliver),
    drainInbox(home, id, slowDeliver),
    drainInbox(home, id, slowDeliver),
  ]);
  assert.deepEqual(got, texts);
  assert.deepEqual(counts, [3, 0, 0]);
  assert.deepEqual(await fs.readdir(inboxDir(home, id)), []);
  // the guard is released: a later drain delivers new messages
  await enqueueInbox(home, id, "d");
  assert.equal(await drainInbox(home, id, slowDeliver), 1);
  assert.deepEqual(got, [...texts, "d"]);
});

test("drainInbox guard is released after a rejected drain", async () => {
  const id = "i-0010";
  await mkAgent(id);
  await enqueueInbox(home, id, "x");
  await assert.rejects(drainInbox(home, id, () => Promise.reject(new Error("nope"))), /nope/);
  const got: string[] = [];
  assert.equal(await drainInbox(home, id, (t) => void got.push(t)), 1);
  assert.deepEqual(got, ["x"]);
});

test("drainInbox returns 0 when the inbox does not exist", async () => {
  assert.equal(await drainInbox(home, "none-0000", () => assert.fail("no")), 0);
});

test("drainInbox deletes each file only after deliver resolves", async () => {
  const id = "i-0004";
  await mkAgent(id);
  const a = await enqueueInbox(home, id, "a");
  const b = await enqueueInbox(home, id, "b");
  const seen: string[][] = [];
  await drainInbox(home, id, async (t) => {
    seen.push(await fs.readdir(inboxDir(home, id)));
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(t === "a" || t === "b");
  });
  assert.deepEqual(seen, [[a, b], [b]]);
});

test("drainInbox keeps the file when deliver rejects and propagates the error", async () => {
  const id = "i-0005";
  await mkAgent(id);
  const a = await enqueueInbox(home, id, "a");
  const b = await enqueueInbox(home, id, "b");
  const got: string[] = [];
  await assert.rejects(
    drainInbox(home, id, (t) => {
      if (t === "b") throw new Error("boom");
      got.push(t);
    }),
    /boom/,
  );
  assert.deepEqual(got, ["a"]);
  assert.deepEqual(await fs.readdir(inboxDir(home, id)), [b]);
  assert.notEqual(a, b);
});

test("drainInbox ignores tmp, partial and invalid files without throwing", async () => {
  const id = "i-0006";
  await mkAgent(id);
  const first = await enqueueInbox(home, id, "first");
  const dir = inboxDir(home, id);
  const junk = {
    ".0000000000001-aa.json.tmp": '{"text":"tmp"}',
    "0000000000002-bb.json.tmp": '{"text":"tmp2"}',
    "0000000000003-cc.json": '{"text":"par',
    "0000000000004-dd.json": "[]",
    "0000000000005-ee.json": '{"text":5}',
    "notes.txt": "hello",
  };
  for (const [n, c] of Object.entries(junk)) await fs.writeFile(path.join(dir, n), c);
  await fs.mkdir(path.join(dir, "0000000000006-ff.json"));
  const last = await enqueueInbox(home, id, "last");

  const got: string[] = [];
  const n = await drainInbox(home, id, (t) => {
    got.push(t);
  });
  assert.equal(n, 2);
  assert.deepEqual(got, ["first", "last"]);
  const left = await fs.readdir(dir);
  assert.ok(!left.includes(first) && !left.includes(last));
});

test("drainInbox delivers texts with unicode and newlines intact", async () => {
  const id = "i-0007";
  await mkAgent(id);
  const text = 'multi\nline "quoted" — zażółć 🚀';
  await enqueueInbox(home, id, text);
  const got: string[] = [];
  await drainInbox(home, id, (t) => {
    got.push(t);
  });
  assert.deepEqual(got, [text]);
});

// --- id validation ---

test("removeAgentDir rejects invalid ids and never deletes agents/", async () => {
  await writeMeta(home, meta("keep-0001"));
  for (const bad of ["", ".", "..", "../x", "a/b", "Upper-0001", "with space"]) {
    await assert.rejects(removeAgentDir(home, bad), /invalid agent id/i, `id: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(await listAgentIds(home), ["keep-0001"]);
});

test("listAgentIds skips directories whose names are not valid ids", async () => {
  await writeMeta(home, meta("ok-0001"));
  await fs.mkdir(path.join(home, "agents", "Bad Name"), { recursive: true });
  await fs.writeFile(path.join(home, "agents", "Bad Name", "meta.json"), "{}");
  assert.deepEqual(await listAgentIds(home), ["ok-0001"]);
});

test("readStatus and readMeta return null for invalid ids", async () => {
  assert.equal(await readStatus(home, ""), null);
  assert.equal(await readMeta(home, "../x"), null);
});

// --- removeAgentDir ---

test("removeAgentDir removes everything and is ok when missing", async () => {
  const id = "rm-0001";
  await writeMeta(home, meta(id));
  await writeStatus(home, id, status());
  await enqueueInbox(home, id, "x");
  await removeAgentDir(home, id);
  await assert.rejects(fs.stat(agentDir(home, id)), { code: "ENOENT" });
  await removeAgentDir(home, id);
  assert.deepEqual(await listAgentIds(home), []);
});
