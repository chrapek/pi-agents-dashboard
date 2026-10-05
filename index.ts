// Pi Agent Dashboard extension. One extension, two roles chosen at load time (spec §2):
// the Pi that the dashboard starts in tmux runs the worker role; any other Pi runs the dashboard role.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDashboardRole } from "./src/dashboard-role.ts";
import { resolveHome } from "./src/paths.ts";
import { registerWorker } from "./src/worker.ts";

interface WorkerIdentity {
  id: string;
  home: string;
}

/** Process-wide slot that keeps the worker identity across extension reloads (/new, /resume, /reload). */
const WORKER_KEY = Symbol.for("pi-agent-dashboard.worker");

/**
 * Reads PI_AGENTS_ID / PI_AGENTS_HOME once per process, saves them, and removes them from `process.env`, so
 * Pis started from inside an agent (bash tool, subagents) don't inherit them and act as a second worker for
 * the same id. Later loads in the same process reuse the saved identity.
 */
function takeWorkerIdentity(): WorkerIdentity | undefined {
  const slot = globalThis as { [WORKER_KEY]?: WorkerIdentity };
  if (slot[WORKER_KEY]) return slot[WORKER_KEY];
  const id = process.env.PI_AGENTS_ID;
  if (!id) return undefined;
  const identity = { id, home: resolveHome(process.env) };
  slot[WORKER_KEY] = identity;
  delete process.env.PI_AGENTS_ID;
  delete process.env.PI_AGENTS_HOME;
  return identity;
}

export default function (pi: ExtensionAPI): void {
  const worker = takeWorkerIdentity();
  if (worker) registerWorker(pi, worker.id, worker.home);
  else registerDashboardRole(pi);
}
