import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  GitError,
  repoRoot,
  createWorktree,
  isDirty,
  removeWorktree,
  deleteBranch,
  deleteBranchIfMerged,
} from "../src/git.ts";

// Isolate every git call (ours and the module's) from the user's git config.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const run = promisify(execFile);

let tmp: string;

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-git-test-")));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// Repo-location variables that would override `-C`; stripped like src/git.ts does.
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

let counter = 0;
async function newDir(label: string): Promise<string> {
  const dir = path.join(tmp, `${label}-${++counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function emptyRepo(): Promise<string> {
  const dir = await newDir("repo");
  await git(dir, "init", "-q", "-b", "main");
  return dir;
}

async function commit(repo: string, file: string, content: string, message = file): Promise<string> {
  await fs.writeFile(path.join(repo, file), content);
  await git(repo, "add", file);
  await git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

async function repoWithCommit(): Promise<string> {
  const repo = await emptyRepo();
  await commit(repo, "README.md", "hello\n");
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

async function worktreeList(repo: string): Promise<string> {
  return git(repo, "worktree", "list", "--porcelain");
}

// --- GitError -------------------------------------------------------------

test("GitError message is `git <cmd> failed: <first non-empty stderr line>`", () => {
  const err = new GitError("worktree add", "\n  \nfatal: invalid reference: HEAD\nmore detail\n");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "GitError");
  assert.equal(err.cmd, "worktree add");
  assert.equal(err.stderr, "\n  \nfatal: invalid reference: HEAD\nmore detail\n");
  assert.equal(err.message, "git worktree add failed: fatal: invalid reference: HEAD");
});

test("GitError with empty stderr still has a readable message", () => {
  const err = new GitError("branch -d", "");
  assert.equal(err.message, "git branch -d failed: unknown error");
});

// --- repoRoot -------------------------------------------------------------

test("repoRoot returns the toplevel from a subdirectory", async () => {
  const repo = await repoWithCommit();
  const sub = path.join(repo, "a", "b");
  await fs.mkdir(sub, { recursive: true });
  assert.equal(await repoRoot(sub), repo);
});

test("repoRoot works in a repo with no commits", async () => {
  const repo = await emptyRepo();
  assert.equal(await repoRoot(repo), repo);
});

test("repoRoot of a non-repo directory is null", async () => {
  const dir = await newDir("plain");
  assert.equal(await repoRoot(dir), null);
});

test("repoRoot of a missing directory is null", async () => {
  assert.equal(await repoRoot(path.join(tmp, "does-not-exist")), null);
});

// --- createWorktree -------------------------------------------------------

test("createWorktree creates a worktree on a new branch at HEAD, creating parent dirs", async () => {
  const repo = await repoWithCommit();
  const head = await git(repo, "rev-parse", "HEAD");
  const wt = path.join(tmp, `home-${++counter}`, "worktrees", "repo", "fix-bug-a1b2");

  await createWorktree(repo, wt, "pi-agents/fix-bug-a1b2");

  assert.equal(await git(wt, "rev-parse", "HEAD"), head);
  assert.equal(await git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "pi-agents/fix-bug-a1b2");
  assert.equal(await repoRoot(wt), wt);
  assert.ok((await worktreeList(repo)).includes(`worktree ${wt}`));
});

test("createWorktree in a repo with no commits throws GitError and leaves nothing behind", async () => {
  const repo = await emptyRepo();
  const home = path.join(tmp, `home-${++counter}`);
  const wt = path.join(home, "worktrees", "repo", "x-0001");

  await assert.rejects(createWorktree(repo, wt, "pi-agents/x-0001"), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.cmd, "worktree add");
    const firstLine = err.stderr.split("\n").find((l) => l.trim() !== "");
    assert.ok(firstLine);
    assert.equal(err.message, `git worktree add failed: ${firstLine.trim()}`);
    assert.match(err.message, /^git worktree add failed: .*HEAD/);
    return true;
  });

  assert.equal(await branchExists(repo, "pi-agents/x-0001"), false);
  assert.equal(await exists(wt), false);
  assert.equal(await exists(home), false, "created parent dirs are removed too");
  assert.equal((await worktreeList(repo)).includes(wt), false);
});

test("createWorktree with an existing branch throws GitError, keeps the branch, creates no dir", async () => {
  const repo = await repoWithCommit();
  await git(repo, "branch", "pi-agents/dup-0002");
  const before = await git(repo, "rev-parse", "pi-agents/dup-0002");
  await commit(repo, "second.txt", "2\n");
  const home = path.join(tmp, `home-${++counter}`);
  const wt = path.join(home, "worktrees", "repo", "dup-0002");

  await assert.rejects(createWorktree(repo, wt, "pi-agents/dup-0002"), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.cmd, "worktree add");
    assert.match(err.message, /^git worktree add failed: .*already exists/);
    return true;
  });

  assert.equal(await branchExists(repo, "pi-agents/dup-0002"), true);
  assert.equal(await git(repo, "rev-parse", "pi-agents/dup-0002"), before);
  assert.equal(await exists(wt), false);
  assert.equal(await exists(home), false);
});

test("createWorktree onto an existing non-empty path throws GitError, keeps the path, creates no branch", async () => {
  const repo = await repoWithCommit();
  const wt = await newDir("occupied");
  await fs.writeFile(path.join(wt, "keep.txt"), "mine\n");

  await assert.rejects(createWorktree(repo, wt, "pi-agents/occ-0003"), GitError);

  assert.equal(await branchExists(repo, "pi-agents/occ-0003"), false);
  assert.equal(await fs.readFile(path.join(wt, "keep.txt"), "utf8"), "mine\n");
});

test("failed createWorktree keeps the registration of an unrelated worktree whose dir was moved away", async () => {
  const repo = await repoWithCommit();
  const sibling = path.join(tmp, `sibling-${++counter}`);
  await git(repo, "worktree", "add", "-q", "-b", "sibling", sibling, "HEAD");
  await fs.rename(sibling, `${sibling}-moved`);
  await git(repo, "branch", "pi-agents/taken-0005");
  const wt = path.join(tmp, `home-${++counter}`, "worktrees", "repo", "taken-0005");

  await assert.rejects(createWorktree(repo, wt, "pi-agents/taken-0005"), GitError);

  assert.ok((await worktreeList(repo)).includes(`worktree ${sibling}`), "sibling registration survives");
});

test("failed createWorktree removes the registration of its own target", async () => {
  const repo = await repoWithCommit();
  const wt = path.join(tmp, `home-${++counter}`, "worktrees", "repo", "own-0006");
  // A post-checkout hook that fails makes git register and populate the worktree, then report failure.
  await fs.writeFile(path.join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho hook boom >&2\nexit 1\n", {
    mode: 0o755,
  });

  await assert.rejects(createWorktree(repo, wt, "pi-agents/own-0006"), GitError);

  assert.equal(await exists(wt), false);
  assert.equal((await worktreeList(repo)).includes(wt), false);
  assert.equal(await branchExists(repo, "pi-agents/own-0006"), false);
});

test("createWorktree surfaces a parent-dir mkdir failure as GitError('worktree add') and creates no branch", async () => {
  const repo = await repoWithCommit();
  const file = path.join(await newDir("blocker"), "not-a-dir");
  await fs.writeFile(file, "x\n");
  const wt = path.join(file, "worktrees", "repo", "mk-0007");

  await assert.rejects(createWorktree(repo, wt, "pi-agents/mk-0007"), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.cmd, "worktree add");
    assert.match(err.message, /^git worktree add failed: .*(ENOTDIR|EEXIST)/);
    return true;
  });
  assert.equal(await branchExists(repo, "pi-agents/mk-0007"), false);
});

test("createWorktree throws the original GitError even when every rollback git call fails", async () => {
  const missingRepo = path.join(tmp, `missing-repo-${++counter}`);
  const wt = path.join(tmp, `home-${++counter}`, "worktrees", "repo", "rb-0008");

  await assert.rejects(createWorktree(missingRepo, wt, "pi-agents/rb-0008"), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.cmd, "worktree add");
    return true;
  });
  assert.equal(await exists(path.join(tmp, `home-${counter}`)), false);
});

test("GIT_DIR and friends in the environment do not redirect repoRoot or createWorktree", async (t) => {
  const repo = await repoWithCommit();
  const other = await repoWithCommit();
  const saved = new Map(GIT_LOCATION_VARS.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.GIT_DIR = path.join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  process.env.GIT_INDEX_FILE = path.join(other, ".git", "index");
  process.env.GIT_PREFIX = "nested/";

  const sub = path.join(repo, "sub");
  await fs.mkdir(sub);
  assert.equal(await repoRoot(sub), repo);

  const wt = path.join(tmp, `home-${++counter}`, "worktrees", "repo", "env-0009");
  await createWorktree(repo, wt, "pi-agents/env-0009");
  assert.ok((await worktreeList(repo)).includes(`worktree ${wt}`));
  assert.equal((await worktreeList(other)).includes(wt), false);
  assert.equal(await branchExists(other, "pi-agents/env-0009"), false);
  assert.equal(await isDirty(wt), false);
});

test("dispatch from inside a linked worktree: repoRoot is that worktree and createWorktree branches from its HEAD", async () => {
  const repo = await repoWithCommit();
  const linked = path.join(tmp, `linked-${++counter}`);
  await git(repo, "worktree", "add", "-q", "-b", "feature", linked, "HEAD");
  const linkedHead = await commit(linked, "feature.txt", "f\n");
  assert.notEqual(await git(repo, "rev-parse", "HEAD"), linkedHead);
  const sub = path.join(linked, "deep", "dir");
  await fs.mkdir(sub, { recursive: true });

  const root = await repoRoot(sub);
  assert.equal(root, linked);

  const wt = path.join(tmp, `home-${++counter}`, "worktrees", path.basename(linked), "nested-0004");
  await createWorktree(root!, wt, "pi-agents/nested-0004");

  assert.equal(await git(wt, "rev-parse", "HEAD"), linkedHead);
  assert.equal(await git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "pi-agents/nested-0004");
  assert.ok((await worktreeList(repo)).includes(`worktree ${wt}`));

  await removeWorktree(root!, wt, false);
  assert.equal(await exists(wt), false);
  assert.equal(await deleteBranchIfMerged(root!, "pi-agents/nested-0004"), true);
  assert.equal(await branchExists(repo, "pi-agents/nested-0004"), false);
});

// --- isDirty / removeWorktree --------------------------------------------

async function freshWorktree(): Promise<{ repo: string; wt: string; branch: string }> {
  const repo = await repoWithCommit();
  const id = `wt-${++counter}`;
  const wt = path.join(tmp, `home-${id}`, "worktrees", "repo", id);
  const branch = `pi-agents/${id}`;
  await createWorktree(repo, wt, branch);
  return { repo, wt, branch };
}

test("isDirty is false for a clean worktree", async () => {
  const { wt } = await freshWorktree();
  assert.equal(await isDirty(wt), false);
});

test("isDirty is true for a modified tracked file", async () => {
  const { wt } = await freshWorktree();
  await fs.appendFile(path.join(wt, "README.md"), "change\n");
  assert.equal(await isDirty(wt), true);
});

test("isDirty is true for an untracked file", async () => {
  const { wt } = await freshWorktree();
  await fs.writeFile(path.join(wt, "new.txt"), "untracked\n");
  assert.equal(await isDirty(wt), true);
});

test("isDirty is true for a staged change", async () => {
  const { wt } = await freshWorktree();
  await fs.writeFile(path.join(wt, "staged.txt"), "s\n");
  await git(wt, "add", "staged.txt");
  assert.equal(await isDirty(wt), true);
});

test("removeWorktree removes a clean worktree without force", async () => {
  const { repo, wt } = await freshWorktree();
  await removeWorktree(repo, wt, false);
  assert.equal(await exists(wt), false);
  assert.equal((await worktreeList(repo)).includes(wt), false);
});

test("removeWorktree of a dirty worktree fails without force and succeeds with force", async () => {
  const { repo, wt } = await freshWorktree();
  await fs.appendFile(path.join(wt, "README.md"), "change\n");
  await fs.writeFile(path.join(wt, "new.txt"), "untracked\n");

  await assert.rejects(removeWorktree(repo, wt, false), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.cmd, "worktree remove");
    assert.match(err.message, /^git worktree remove failed: .*(modified|untracked)/);
    return true;
  });
  assert.equal(await exists(wt), true);

  await removeWorktree(repo, wt, true);
  assert.equal(await exists(wt), false);
  assert.equal((await worktreeList(repo)).includes(wt), false);
});

test("removeWorktree of an already-deleted path prunes and succeeds", async () => {
  const { repo, wt } = await freshWorktree();
  await fs.rm(wt, { recursive: true, force: true });
  assert.ok((await worktreeList(repo)).includes(wt));

  await removeWorktree(repo, wt, false);
  assert.equal((await worktreeList(repo)).includes(wt), false);
});

// --- deleteBranch / deleteBranchIfMerged ---------------------------------

test("deleteBranchIfMerged keeps an unmerged branch and returns false", async () => {
  const { repo, wt, branch } = await freshWorktree();
  await commit(wt, "work.txt", "work\n");
  await removeWorktree(repo, wt, false);

  assert.equal(await deleteBranchIfMerged(repo, branch), false);
  assert.equal(await branchExists(repo, branch), true);
});

test("deleteBranchIfMerged deletes a merged branch and returns true", async () => {
  const { repo, wt, branch } = await freshWorktree();
  await commit(wt, "work.txt", "work\n");
  await removeWorktree(repo, wt, false);
  await git(repo, "merge", "-q", "--ff-only", branch);

  assert.equal(await deleteBranchIfMerged(repo, branch), true);
  assert.equal(await branchExists(repo, branch), false);
});

test("deleteBranchIfMerged of a missing branch returns true", async () => {
  const repo = await repoWithCommit();
  assert.equal(await deleteBranchIfMerged(repo, "pi-agents/never-0000"), true);
});

test("deleteBranchIfMerged throws GitError for other failures (branch checked out in a worktree)", async () => {
  const { repo, branch } = await freshWorktree();
  await assert.rejects(deleteBranchIfMerged(repo, branch), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.cmd, "branch -d");
    assert.match(err.message, /^git branch -d failed: /);
    return true;
  });
  assert.equal(await branchExists(repo, branch), true);
});

test("deleteBranch force-deletes an unmerged branch", async () => {
  const { repo, wt, branch } = await freshWorktree();
  await commit(wt, "work.txt", "work\n");
  await removeWorktree(repo, wt, false);

  await deleteBranch(repo, branch);
  assert.equal(await branchExists(repo, branch), false);
});

test("deleteBranch of a missing branch throws GitError", async () => {
  const repo = await repoWithCommit();
  await assert.rejects(deleteBranch(repo, "pi-agents/never-0000"), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.cmd, "branch -D");
    return true;
  });
});
