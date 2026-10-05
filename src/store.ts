import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { agentDir, agentsDir, assertAgentId, inboxDir, metaPath, statusPath } from "./paths.ts";

export type Phase = "idle" | "working" | "exited";
export type Outcome = "completed" | "error" | "aborted";

export interface AgentMeta {
  id: string; // slug-xxxx
  name: string; // slug with '-' -> ' '
  prompt: string; // original prompt
  createdAt: number; // ms epoch
  launchCwd: string; // dashboard cwd at dispatch
  cwd: string; // where Pi runs: worktree path, or launchCwd when not a repo
  repoRoot: string | null; // null when launchCwd is not a git repo
  worktree: string | null; // null when no worktree
  branch: string | null; // "pi-agents/<id>" or null
}

export interface AgentStatus {
  phase: Phase;
  activity: string | null;
  lastText: string | null;
  lastOutcome: Outcome | null;
  uiPrompt: { kind: string; title: string } | null;
  sessionFile: string | null;
  pid: number | null;
  model: string | null;
  updatedAt: number; // ms epoch of last write
}

const PHASES: readonly string[] = ["idle", "working", "exited"] satisfies Phase[];
const OUTCOMES: readonly string[] = ["completed", "error", "aborted"] satisfies Outcome[];
// Inbox entries are "<13-digit ms>-<hex>.json"; anything else (tmp files etc.) is ignored.
const INBOX_FILE_RE = /^\d{13}-[0-9a-f]+\.json$/;

function randHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Write via a tmp file in the same directory, then rename, so readers never see a partial file. Does not create `dir`. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randHex(4)}.tmp`);
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Parsed JSON of the file at `fileOf()`, or undefined on any error (including an invalid id). */
async function readJson(fileOf: () => string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(fileOf(), "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isAgentMeta(v: unknown): v is AgentMeta {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.prompt === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.launchCwd === "string" &&
    typeof v.cwd === "string" &&
    isStringOrNull(v.repoRoot) &&
    isStringOrNull(v.worktree) &&
    isStringOrNull(v.branch)
  );
}

function isUiPrompt(v: unknown): v is AgentStatus["uiPrompt"] {
  return v === null || (isRecord(v) && typeof v.kind === "string" && typeof v.title === "string");
}

function isAgentStatus(v: unknown): v is AgentStatus {
  return (
    isRecord(v) &&
    typeof v.phase === "string" &&
    PHASES.includes(v.phase) &&
    isStringOrNull(v.activity) &&
    isStringOrNull(v.lastText) &&
    (v.lastOutcome === null || (typeof v.lastOutcome === "string" && OUTCOMES.includes(v.lastOutcome))) &&
    isUiPrompt(v.uiPrompt) &&
    isStringOrNull(v.sessionFile) &&
    (v.pid === null || typeof v.pid === "number") &&
    isStringOrNull(v.model) &&
    typeof v.updatedAt === "number"
  );
}

function isErrnoCode(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code;
}

/** Creates the agent dir (dispatch) and writes meta.json. */
export async function writeMeta(home: string, meta: AgentMeta): Promise<void> {
  await fs.mkdir(agentDir(home, meta.id), { recursive: true });
  await writeFileAtomic(metaPath(home, meta.id), JSON.stringify(meta, null, 2) + "\n");
}

/** Returns null when meta.json is missing or not a valid AgentMeta. */
export async function readMeta(home: string, id: string): Promise<AgentMeta | null> {
  const v = await readJson(() => metaPath(home, id));
  return isAgentMeta(v) ? v : null;
}

/**
 * Sets meta.json's `name` (README "Naming"); false when the agent is gone. Never recreates a removed
 * agent dir, so a name arriving after a delete is dropped.
 */
export async function renameAgent(home: string, id: string, name: string): Promise<boolean> {
  const meta = await readMeta(home, id);
  if (meta === null) return false;
  try {
    await writeFileAtomic(metaPath(home, id), JSON.stringify({ ...meta, name }, null, 2) + "\n");
    return true;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false; // removed between the read and the write
    throw err;
  }
}

/** Ids of agent dirs that contain meta.json, sorted; [] when home or agents dir is missing. */
export async function listAgentIds(home: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(agentsDir(home), { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isAgentId(e.name)) continue;
    try {
      if ((await fs.stat(metaPath(home, e.name))).isFile()) ids.push(e.name);
    } catch {
      // no meta.json: not a dispatched agent
    }
  }
  return ids.sort();
}

function isAgentId(id: string): boolean {
  try {
    assertAgentId(id);
    return true;
  } catch {
    return false;
  }
}

// Per status path: tail of the in-process write chain, so overlapping writes land in call order.
const statusWriteChains = new Map<string, Promise<void>>();

/**
 * Atomic (tmp file in the agent dir, then rename over status.json) and serialized per path, so the
 * last call wins on disk. Skips silently when the agent dir no longer exists (never recreates it).
 */
export function writeStatus(home: string, id: string, status: AgentStatus): Promise<void> {
  let file: string;
  try {
    file = statusPath(home, id);
  } catch (err) {
    return Promise.reject(err);
  }
  const write = async (): Promise<void> => {
    const content = JSON.stringify(status) + "\n";
    try {
      await writeFileAtomic(file, content);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return; // agent dir deleted
      throw err;
    }
  };
  const prev = statusWriteChains.get(file) ?? Promise.resolve();
  const next = prev.then(write, write);
  statusWriteChains.set(file, next);
  const release = () => {
    if (statusWriteChains.get(file) === next) statusWriteChains.delete(file);
  };
  next.then(release, release);
  return next;
}

/** Missing, empty, partial or invalid status reads as null ("none"); never throws. */
export async function readStatus(home: string, id: string): Promise<AgentStatus | null> {
  const v = await readJson(() => statusPath(home, id));
  return isAgentStatus(v) ? v : null;
}

let lastInboxMs = 0;

/**
 * Writes inbox/<ms>-<rand>.json = {"text": ...}; ms is strictly increasing per process so name order
 * = enqueue order. Rejects when the agent dir does not exist.
 */
export async function enqueueInbox(home: string, id: string, text: string): Promise<string> {
  const dir = inboxDir(home, id);
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) throw new Error(`enqueueInbox: agent dir missing for ${id}: ${agentDir(home, id)}`);
    if (!isErrnoCode(err, "EEXIST")) throw err;
  }
  const ms = Math.max(Date.now(), lastInboxMs + 1);
  lastInboxMs = ms;
  const name = `${String(ms).padStart(13, "0")}-${randHex(3)}.json`;
  await writeFileAtomic(path.join(dir, name), JSON.stringify({ text }));
  return name;
}

// Inbox dirs with a drain in progress in this process.
const runningDrains = new Map<string, Promise<number>>();

/**
 * Delivers inbox messages in filename order, deleting each file only after `deliver` resolves.
 * Tmp, partial and invalid files are skipped. A rejecting `deliver` stops the drain, keeps that
 * file for the next drain, and propagates the error. Returns the number delivered by this call:
 * a call made while another drain of the same inbox is running waits for it and returns 0.
 */
export async function drainInbox(
  home: string,
  id: string,
  deliver: (text: string) => void | Promise<void>,
): Promise<number> {
  const dir = inboxDir(home, id);
  const running = runningDrains.get(dir);
  if (running) {
    await running.catch(() => undefined);
    return 0;
  }
  const drain = drainInboxDir(dir, deliver);
  runningDrains.set(dir, drain);
  try {
    return await drain;
  } finally {
    runningDrains.delete(dir);
  }
}

async function drainInboxDir(dir: string, deliver: (text: string) => void | Promise<void>): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let delivered = 0;
  for (const name of names.filter((n) => INBOX_FILE_RE.test(n)).sort()) {
    const file = path.join(dir, name);
    const v = await readJson(() => file);
    if (!isRecord(v) || typeof v.text !== "string") continue;
    await deliver(v.text);
    await fs.rm(file, { force: true });
    delivered++;
  }
  return delivered;
}

/** Recursively removes <home>/agents/<id>; ok if missing. */
export async function removeAgentDir(home: string, id: string): Promise<void> {
  await fs.rm(agentDir(home, id), { recursive: true, force: true });
}
