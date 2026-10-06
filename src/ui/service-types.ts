import type { Row } from "../state.ts";
import type { AgentMeta, AgentStatus } from "../store.ts";

/**
 * What the dashboard needs from the agent service (plan, WP5 interface). Methods reject with Errors whose
 * message is user-facing (`<action> failed: <stderr line>`); `snapshot()` rejects with `TmuxNotFoundError`
 * when tmux is missing.
 */
export interface DashboardService {
  snapshot(): Promise<Row[]>;
  peek(id: string): Promise<{ meta: AgentMeta; status: AgentStatus | null; row: Row } | null>;
  dispatch(prompt: string, launchCwd: string): Promise<AgentMeta>;
  reply(id: string, text: string): Promise<"queued" | "restarted">;
  ensureRunning(id: string): Promise<void>;
  remove(id: string, force: boolean): Promise<{ removed: boolean; dirty?: string; branchKept?: string }>;
}

/** `command`: close the dashboard and run `text` (a `/command …` line) in this Pi, as if typed into its editor. */
export type DashboardResult = { type: "close" } | { type: "attach"; id: string } | { type: "command"; text: string };
