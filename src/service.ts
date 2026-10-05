import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorktree, deleteBranch, deleteBranchIfMerged, isDirty, removeWorktree, repoRoot } from "./git.ts";
import { makeId, nameFromId } from "./ids.ts";
import { agentDir, agentsDir, tmuxConfPath, worktreePath } from "./paths.ts";
import { deriveRow, sortRows } from "./state.ts";
import type { Row } from "./state.ts";
import { enqueueInbox, listAgentIds, readMeta, readStatus, removeAgentDir, writeMeta } from "./store.ts";
import type { AgentMeta, AgentStatus } from "./store.ts";
import { Tmux, TmuxError } from "./tmux.ts";

export interface DashboardService {
  snapshot(): Promise<Row[]>;
  peek(id: string): Promise<{ meta: AgentMeta; status: AgentStatus | null; row: Row } | null>;
  dispatch(prompt: string, launchCwd: string): Promise<AgentMeta>;
  reply(id: string, text: string): Promise<"queued" | "restarted">;
  ensureRunning(id: string): Promise<void>;
  remove(id: string, force: boolean): Promise<{ removed: boolean; dirty?: string; branchKept?: string }>;
}

export interface AgentServiceOptions {
  home: string;
  tmux?: Tmux; // default: socket "pi-agents", config <home>/tmux.conf
  piBin?: string; // default env.PI_AGENTS_PI_BIN || "pi"
  env?: Record<string, string | undefined>; // default process.env (only used for PI_AGENTS_PI_BIN)
  size?: () => { cols: number; rows: number }; // default process.stdout size, fallback 120x40
  now?: () => number; // default Date.now
  randHex?: () => string; // passed to makeId
}

// Attempts at finding an id whose agent dir and tmux session are both free.
const MAX_ID_ATTEMPTS = 20;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

const BRANCH_PREFIX = "pi-agents/";

function defaultSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || DEFAULT_COLS, rows: process.stdout.rows || DEFAULT_ROWS };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// Repo-location variables would override `git -C <dir>` (same list as src/git.ts).
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
];

/** True when `refs/heads/<branch>` exists in `repoRoot`. */
function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { env }, (err) =>
      resolve(!err),
    );
  });
}

/** Runs each cleanup step, ignoring its failure, so the caller can rethrow the original error. */
async function bestEffort(steps: Array<() => Promise<unknown>>): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch {
      // keep cleaning up; the original error is what gets reported
    }
  }
}

export class AgentService implements DashboardService {
  private readonly home: string;
  private readonly tmux: Tmux;
  private readonly piBin: string;
  private readonly size: () => { cols: number; rows: number };
  private readonly now: () => number;
  private readonly randHex: (() => string) | undefined;

  constructor(opts: AgentServiceOptions) {
    this.home = opts.home;
    this.tmux = opts.tmux ?? new Tmux({ configPath: tmuxConfPath(opts.home) });
    this.piBin = opts.piBin ?? ((opts.env ?? process.env).PI_AGENTS_PI_BIN || "pi");
    this.size = opts.size ?? defaultSize;
    this.now = opts.now ?? Date.now;
    this.randHex = opts.randHex;
  }

  async snapshot(): Promise<Row[]> {
    const live = await this.tmux.liveSessions();
    const now = this.now();
    const rows: Row[] = [];
    for (const id of await listAgentIds(this.home)) {
      const meta = await readMeta(this.home, id);
      if (meta === null) continue;
      rows.push(deriveRow(meta, await readStatus(this.home, id), live.has(id), now));
    }
    return sortRows(rows);
  }

  async peek(id: string): Promise<{ meta: AgentMeta; status: AgentStatus | null; row: Row } | null> {
    const meta = await readMeta(this.home, id);
    if (meta === null) return null;
    const status = await readStatus(this.home, id);
    const alive = (await this.tmux.liveSessions()).has(id);
    return { meta, status, row: deriveRow(meta, status, alive, this.now()) };
  }

  async dispatch(rawPrompt: string, launchCwd: string): Promise<AgentMeta> {
    const prompt = rawPrompt.trim();
    if (prompt === "") throw new Error("dispatch: prompt is empty");
    const root = await repoRoot(launchCwd);
    const id = await this.freeId(prompt, root);
    const worktree = root === null ? null : worktreePath(this.home, path.basename(root), id);
    const branch = root === null ? null : `${BRANCH_PREFIX}${id}`;
    const meta: AgentMeta = {
      id,
      name: nameFromId(id),
      prompt,
      createdAt: this.now(),
      launchCwd,
      cwd: worktree ?? launchCwd,
      repoRoot: root,
      worktree,
      branch,
    };

    // createWorktree rolls back its own partial state, so only completed steps are tracked here.
    let createdWorktree = false;
    let createdAgentDir = false;
    let startedSession = false;
    try {
      if (root !== null && worktree !== null && branch !== null) {
        await createWorktree(root, worktree, branch);
        createdWorktree = true;
      }
      await this.claimAgentDir(id);
      createdAgentDir = true;
      await writeMeta(this.home, meta);
      startedSession = true; // new-session can fail after the session started (e.g. timeout)
      await this.startSession(meta, this.dispatchArgv(meta));
    } catch (err) {
      await bestEffort([
        async () => {
          if (startedSession) await this.tmux.killSession(id);
        },
        async () => {
          if (createdAgentDir) await removeAgentDir(this.home, id);
        },
        async () => {
          if (createdWorktree && root !== null && worktree !== null) await removeWorktree(root, worktree, true);
        },
        async () => {
          if (createdWorktree && root !== null && branch !== null) await deleteBranch(root, branch);
        },
      ]);
      throw err;
    }
    return meta;
  }

  async reply(id: string, text: string): Promise<"queued" | "restarted"> {
    const meta = await this.requireMeta(id);
    if ((await this.tmux.liveSessions()).has(id)) {
      await enqueueInbox(this.home, id, text);
      return "queued";
    }
    const sessionFile = (await readStatus(this.home, id))?.sessionFile ?? null;
    if (sessionFile !== null) {
      const started = await this.startOrJoinSession(meta, [...this.resumeArgv(sessionFile), "--", text]);
      if (!started) await enqueueInbox(this.home, id, text);
    } else {
      await this.startOrJoinSession(meta, this.dispatchArgv(meta));
      // The worker delivers it once the rerun prompt has finished.
      await enqueueInbox(this.home, id, text);
    }
    return "restarted";
  }

  async ensureRunning(id: string): Promise<void> {
    const meta = await this.requireMeta(id);
    if ((await this.tmux.liveSessions()).has(id)) return;
    const sessionFile = (await readStatus(this.home, id))?.sessionFile ?? null;
    await this.startOrJoinSession(meta, sessionFile !== null ? this.resumeArgv(sessionFile) : this.dispatchArgv(meta));
  }

  async remove(id: string, force: boolean): Promise<{ removed: boolean; dirty?: string; branchKept?: string }> {
    const meta = await readMeta(this.home, id);
    if (meta === null) return { removed: false };
    const { repoRoot: root, worktree, branch } = meta;
    if (root !== null && !(await pathExists(root))) return this.removeWithoutRepo(meta, force);
    if (worktree !== null && !force && (await pathExists(worktree)) && (await isDirty(worktree))) {
      return { removed: false, dirty: worktree };
    }
    await this.tmux.killSession(id);
    if (root !== null && worktree !== null) await removeWorktree(root, worktree, force);
    let branchKept: string | undefined;
    if (root !== null && branch !== null && !(await deleteBranchIfMerged(root, branch))) branchKept = branch;
    // The Pi session file lives outside the agent dir and is kept.
    await removeAgentDir(this.home, id);
    return branchKept === undefined ? { removed: true } : { removed: true, branchKept };
  }

  /**
   * The repo is gone (deleted or moved), so git can neither check nor remove anything. Without
   * force an existing worktree dir counts as dirty; with force it is deleted as a plain dir.
   */
  private async removeWithoutRepo(meta: AgentMeta, force: boolean): Promise<{ removed: boolean; dirty?: string }> {
    const worktree = meta.worktree !== null && (await pathExists(meta.worktree)) ? meta.worktree : null;
    if (worktree !== null && !force) return { removed: false, dirty: worktree };
    await this.tmux.killSession(meta.id);
    if (worktree !== null) await fs.rm(worktree, { recursive: true, force: true });
    await removeAgentDir(this.home, meta.id);
    return { removed: true };
  }

  /**
   * A new id whose agent dir does not exist, whose tmux session is not live and, in a repo, whose
   * `pi-agents/<id>` branch does not exist.
   */
  private async freeId(prompt: string, root: string | null): Promise<string> {
    const live = await this.tmux.liveSessions();
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = makeId(prompt, this.randHex);
      if (live.has(id) || (await pathExists(agentDir(this.home, id)))) continue;
      if (root !== null && (await branchExists(root, `${BRANCH_PREFIX}${id}`))) continue;
      return id;
    }
    throw new Error(`dispatch: no free agent id after ${MAX_ID_ATTEMPTS} attempts`);
  }

  /** Creates `<home>/agents/<id>` exclusively, so a concurrent dispatch of the same id fails here. */
  private async claimAgentDir(id: string): Promise<void> {
    await fs.mkdir(agentsDir(this.home), { recursive: true });
    try {
      await fs.mkdir(agentDir(this.home, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`dispatch: agent id ${id} is already in use`);
      throw err;
    }
  }

  private async requireMeta(id: string): Promise<AgentMeta> {
    const meta = await readMeta(this.home, id);
    if (meta === null) throw new Error(`unknown agent: ${id}`);
    return meta;
  }

  /** Spec §4 step 4 command. */
  private dispatchArgv(meta: AgentMeta): string[] {
    return [this.piBin, "--tui-mode", "fullscreen", "--name", meta.name, "--", meta.prompt];
  }

  /** Spec §7 resume command (a reply is appended as `-- <text>`). */
  private resumeArgv(sessionFile: string): string[] {
    return [this.piBin, "--tui-mode", "fullscreen", "--session", sessionFile];
  }

  /**
   * Starts the session; false when new-session failed because another dashboard started the same
   * session first (it is live now). Other failures are rethrown.
   */
  private async startOrJoinSession(meta: AgentMeta, argv: string[]): Promise<boolean> {
    try {
      await this.startSession(meta, argv);
      return true;
    } catch (err) {
      if (err instanceof TmuxError && (await this.tmux.liveSessions()).has(meta.id)) return false;
      throw err;
    }
  }

  private async startSession(meta: AgentMeta, argv: string[]): Promise<void> {
    await this.tmux.ensureConfig();
    const { cols, rows } = this.size();
    await this.tmux.newSession({
      name: meta.id,
      cwd: meta.cwd,
      cols,
      rows,
      env: { PI_AGENTS_ID: meta.id, PI_AGENTS_HOME: this.home, HERDR_ENV: "0" },
      argv,
    });
  }
}
