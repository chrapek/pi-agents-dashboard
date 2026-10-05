import os from "node:os";
import path from "node:path";

const AGENT_ID_RE = /^[a-z0-9-]+$/;

// Same rule as Pi's normalizePath for PI_CODING_AGENT_DIR: only "~" and a "~/" prefix expand.
function expandTilde(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/")) return path.join(homedir, p.slice(2));
  return p;
}

/** Dashboard home per spec §3: $PI_AGENTS_HOME, else $PI_CODING_AGENT_DIR/agents-dashboard, else ~/.pi/agent/agents-dashboard. */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir(),
): string {
  if (env.PI_AGENTS_HOME) return path.resolve(expandTilde(env.PI_AGENTS_HOME, homedir));
  if (env.PI_CODING_AGENT_DIR) {
    return path.resolve(expandTilde(env.PI_CODING_AGENT_DIR, homedir), "agents-dashboard");
  }
  return path.resolve(homedir, ".pi", "agent", "agents-dashboard");
}

/** Throws unless `id` matches [a-z0-9-]+, so no id can escape or address <home>/agents itself. */
export function assertAgentId(id: string): void {
  if (!AGENT_ID_RE.test(id)) throw new Error(`invalid agent id: ${JSON.stringify(id)}`);
}

export function tmuxConfPath(home: string): string {
  return path.join(home, "tmux.conf");
}

export function agentsDir(home: string): string {
  return path.join(home, "agents");
}

export function agentDir(home: string, id: string): string {
  assertAgentId(id);
  return path.join(agentsDir(home), id);
}

export function metaPath(home: string, id: string): string {
  return path.join(agentDir(home, id), "meta.json");
}

export function statusPath(home: string, id: string): string {
  return path.join(agentDir(home, id), "status.json");
}

export function inboxDir(home: string, id: string): string {
  return path.join(agentDir(home, id), "inbox");
}

export function worktreesDir(home: string): string {
  return path.join(home, "worktrees");
}

export function worktreePath(home: string, repoBasename: string, id: string): string {
  assertAgentId(id);
  return path.join(worktreesDir(home), repoBasename, id);
}
