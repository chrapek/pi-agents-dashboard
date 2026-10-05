import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export class GitError extends Error {
  readonly cmd: string;
  readonly stderr: string;

  constructor(cmd: string, stderr: string) {
    const firstLine = stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "unknown error";
    super(`git ${cmd} failed: ${firstLine}`);
    this.name = "GitError";
    this.cmd = cmd;
    this.stderr = stderr;
  }
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Repo-location variables (e.g. set when Pi runs inside a git hook) would override `-C <dir>`.
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
];

// LC_ALL=C keeps git's stderr in English so message matching ("not fully merged") is locale-proof.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  return env;
}

function runGit(args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { env: gitEnv(), maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        resolve({ ok: false, stdout: stdout ?? "", stderr: stderr || error.message });
      },
    );
  });
}

async function git(cmd: string, args: string[]): Promise<string> {
  const result = await runGit(args);
  if (!result.ok) throw new GitError(cmd, result.stderr);
  return result.stdout;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// Non-recursive rmdir from `dir` up to and including `top`; stops at the first non-empty dir so a
// concurrent dispatch sharing a freshly created parent never loses its worktree.
async function removeEmptyDirsUpTo(dir: string, top: string): Promise<void> {
  let current = dir;
  for (;;) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    if (current === top) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.ok;
}

/** Toplevel of the work tree containing `cwd`; null when `cwd` is not inside a git work tree. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const result = await runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root === "" ? null : root;
}

/** Absolute paths of the worktrees registered in `repoRoot` (empty when listing fails). */
async function registeredWorktrees(repoRoot: string): Promise<Set<string>> {
  const result = await runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const paths = new Set<string>();
  if (!result.ok) return paths;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) paths.add(line.slice("worktree ".length));
  }
  return paths;
}

/** `target` plus its form with a realpath'd parent, which is how git records worktree paths. */
async function pathForms(target: string): Promise<string[]> {
  try {
    return [target, path.join(await fs.realpath(path.dirname(target)), path.basename(target))];
  } catch {
    return [target];
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `git -C repoRoot worktree add --quiet -b <branch> <path> HEAD`, creating parent dirs of `path`.
 * On failure throws GitError and removes only the branch, directories, and worktree registration it
 * created; each rollback step is best-effort so the original GitError is always what is thrown.
 */
export async function createWorktree(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
  const target = path.resolve(worktreePath);
  const hadBranch = await branchExists(repoRoot, branch);
  const hadPath = await pathExists(target);

  let firstCreatedParent: string | undefined;
  try {
    firstCreatedParent = await fs.mkdir(path.dirname(target), { recursive: true });
  } catch (err) {
    throw new GitError("worktree add", errorMessage(err));
  }

  const registered = await registeredWorktrees(repoRoot);
  const wasRegistered = (await pathForms(target)).some((form) => registered.has(form));

  // --quiet drops the "Preparing worktree ..." stderr chatter so the first stderr line is the error.
  const result = await runGit(["-C", repoRoot, "worktree", "add", "--quiet", "-b", branch, target, "HEAD"]);
  if (result.ok) return;

  const rollback: Array<() => Promise<unknown>> = [
    // Targeted: drops only this worktree's registration (works when its dir is missing too), unlike
    // `worktree prune`, which would also drop unrelated worktrees whose dirs were moved away.
    async () => {
      if (!hadPath && !wasRegistered) await runGit(["-C", repoRoot, "worktree", "remove", "--force", target]);
    },
    async () => {
      if (!hadPath) await fs.rm(target, { recursive: true, force: true });
    },
    async () => {
      if (firstCreatedParent !== undefined) await removeEmptyDirsUpTo(path.dirname(target), firstCreatedParent);
    },
    async () => {
      if (!hadBranch && (await branchExists(repoRoot, branch))) {
        await runGit(["-C", repoRoot, "branch", "-D", branch]);
      }
    },
  ];
  for (const step of rollback) {
    try {
      await step();
    } catch {
      // Best-effort cleanup; the worktree add failure below is the error to report.
    }
  }
  throw new GitError("worktree add", result.stderr);
}

/** True when the work tree at `path` has tracked changes (staged or not) or untracked files. */
export async function isDirty(worktreePath: string): Promise<boolean> {
  const out = await git("status", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=normal"]);
  return out.trim() !== "";
}

/** `git -C repoRoot worktree remove [--force] <path>`; if `path` is already gone, prune and succeed. */
export async function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<void> {
  const target = path.resolve(worktreePath);
  if (!(await pathExists(target))) {
    await git("worktree prune", ["-C", repoRoot, "worktree", "prune"]);
    return;
  }
  const args = ["-C", repoRoot, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(target);
  await git("worktree remove", args);
}

/** Force-delete `branch` (`git branch -D`); used for rollback. */
export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  await git("branch -D", ["-C", repoRoot, "branch", "-D", branch]);
}

/**
 * Safe delete (`git branch -d`). True = deleted (or already missing);
 * false = refused because not fully merged (branch kept). Other failures throw GitError.
 */
export async function deleteBranchIfMerged(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(["-C", repoRoot, "branch", "-d", branch]);
  if (result.ok) return true;
  if (/not fully merged/.test(result.stderr)) return false;
  if (/branch '.*' not found/.test(result.stderr)) return true;
  throw new GitError("branch -d", result.stderr);
}
