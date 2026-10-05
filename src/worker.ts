import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { nameFromId } from "./ids.ts";
import { drainInbox, readMeta, readStatus, writeStatus } from "./store.ts";
import { initialStatus, isUrgent, reduceStatus, type WorkerEvent } from "./worker-status.ts";

/** Trailing coalescing window for non-urgent status writes. */
export const STATUS_WRITE_DELAY_MS = 250;
/** Inbox poll interval (spec §7). */
export const INBOX_POLL_MS = 500;
/** Safety net: forget a pending run (prompt sent, no agent_start yet) after this long, once Pi is idle. */
export const RUN_PENDING_TIMEOUT_MS = 30_000;

export const DETACH_FIRST_MESSAGE = "Detach first (← or Ctrl+\\)";

/** Test seams; Pi wiring passes none of these. */
export interface WorkerDeps {
  /** Detaches the tmux client; default runs `tmux detach-client`. */
  detach?: () => void;
  /** Environment checked for `TMUX`; default `process.env`. */
  env?: Record<string, string | undefined>;
  statusDelayMs?: number;
  pollMs?: number;
  runPendingTimeoutMs?: number;
}

/** Thrown inside drainInbox's deliver to keep the message for a later poll; not an error. */
const HOLD_MESSAGE = Symbol("hold inbox message");

function tmuxDetachClient(): void {
  execFile("tmux", ["detach-client"], () => {
    // Nothing useful to do on failure: Ctrl+\ is the fallback.
  });
}

/**
 * Worker role (spec §2): mirrors Pi events into `<home>/agents/<id>/status.json`, delivers inbox
 * messages with `pi.sendUserMessage`, and detaches the tmux client on ← with an empty editor.
 * Timers and subscriptions live from `session_start` to `session_shutdown`.
 */
export function registerWorker(pi: ExtensionAPI, id: string, home: string, deps: WorkerDeps = {}): void {
  const detach = deps.detach ?? tmuxDetachClient;
  const env = deps.env ?? process.env;
  const statusDelayMs = deps.statusDelayMs ?? STATUS_WRITE_DELAY_MS;
  const pollMs = deps.pollMs ?? INBOX_POLL_MS;
  const runPendingTimeoutMs = deps.runPendingTimeoutMs ?? RUN_PENDING_TIMEOUT_MS;

  let status = initialStatus(Date.now());
  let session: ExtensionContext | undefined; // set between session_start and session_shutdown
  let writeTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let draining = false;
  // meta.name last applied as the session name. Starts as the slug name the dashboard passed with `--name`,
  // so only a name the dashboard generated later is pushed, and a `/name` typed in the agent is kept.
  let appliedName = nameFromId(id);
  let syncingName = false;
  let unsubscribeInput: (() => void) | undefined;
  // A prompt was sent or typed (idle input / before_agent_start) but its agent_start has not arrived yet. Pi only
  // marks the run active after sendUserMessage returns, and a followUp sent while no run is active
  // becomes a second prompt that fails with "Agent is already processing".
  let runPending = false;
  let runPendingTimer: NodeJS.Timeout | undefined;

  function setRunPending(pending: boolean): void {
    clearTimeout(runPendingTimer);
    runPendingTimer = undefined;
    runPending = pending;
    if (pending) {
      // Re-arm while Pi is busy (e.g. slow input handlers or compaction before agent_start).
      runPendingTimer = setTimeout(() => setRunPending(session?.isIdle() === false), runPendingTimeoutMs);
      runPendingTimer.unref();
    }
  }

  function writeNow(): Promise<void> {
    clearTimeout(writeTimer);
    writeTimer = undefined;
    return writeStatus(home, id, status).catch(() => {
      // A failed status write must never break the hosted Pi; the next event writes again.
    });
  }

  function apply(e: WorkerEvent): Promise<void> {
    status = reduceStatus(status, e, Date.now());
    if (isUrgent(e)) return writeNow();
    if (!writeTimer) {
      writeTimer = setTimeout(() => void writeNow(), statusDelayMs);
      writeTimer.unref();
    }
    return Promise.resolve();
  }

  async function pollInbox(): Promise<void> {
    if (draining || !session) return;
    draining = true;
    try {
      await drainInbox(home, id, (text) => {
        const ctx = session;
        if (!ctx) throw HOLD_MESSAGE; // keep the file for the next session
        if (ctx.isIdle() && status.phase === "idle" && !runPending) {
          setRunPending(true);
          try {
            pi.sendUserMessage(text);
          } catch (err) {
            setRunPending(false);
            throw err;
          }
        } else if (!ctx.isIdle() && status.phase === "working") {
          pi.sendUserMessage(text, { deliverAs: "followUp" });
        } else {
          // Run pending, compacting, or between run states: neither form is safe right now.
          throw HOLD_MESSAGE;
        }
      });
    } catch {
      // HOLD_MESSAGE or a failed send: the message stays in the inbox and is retried on the next poll.
    } finally {
      draining = false;
    }
  }

  /** Mirrors a changed meta.name (README "Naming") into Pi's session name. */
  async function syncName(): Promise<void> {
    if (syncingName || !session) return;
    syncingName = true;
    try {
      const name = (await readMeta(home, id))?.name;
      if (name === undefined || name === appliedName || !session) return;
      appliedName = name;
      if (pi.getSessionName() !== name) pi.setSessionName(name);
    } catch {
      // retried on the next poll
    } finally {
      syncingName = false;
    }
  }

  function subscribeDetachKey(ctx: ExtensionContext): void {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (!ctx.hasUI) return;
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "left") || isKeyRelease(data)) return undefined;
      if (!env.TMUX || status.uiPrompt !== null || ctx.ui.getEditorText() !== "") return undefined;
      detach();
      return { consume: true };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    // Seed from disk so lastText/lastOutcome survive a restart (`pi --session` resume).
    const saved = await readStatus(home, id);
    if (saved) status = { ...status, lastText: saved.lastText, lastOutcome: saved.lastOutcome };
    session = ctx;
    subscribeDetachKey(ctx);
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void pollInbox();
        void syncName();
      }, pollMs);
      pollTimer.unref();
    }
    await apply({
      type: "session_start",
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      pid: process.pid,
      model: ctx.model?.id ?? null, // model id only, without provider
    });
  });

  // Idle input (no streamingBehavior) will start a run; noticed here before input/auth handlers finish.
  pi.on("input", (event) => {
    if (event.streamingBehavior === undefined) setRunPending(true);
  });
  pi.on("before_agent_start", () => {
    setRunPending(true);
  });
  pi.on("agent_start", () => {
    setRunPending(false);
    return apply({ type: "agent_start" });
  });
  pi.on("tool_execution_start", (event) => apply({ type: "tool_execution_start", toolName: event.toolName, args: event.args }));
  pi.on("message_end", async (event) => {
    await apply({ type: "message_end", message: event.message });
  });
  pi.on("agent_end", (event) => apply({ type: "agent_end", messages: event.messages }));
  pi.on("agent_settled", () => apply({ type: "agent_settled" }));
  pi.on("ui_prompt_start", (event) => apply({ type: "ui_prompt_start", kind: event.kind, title: event.title }));
  pi.on("ui_prompt_end", () => apply({ type: "ui_prompt_end" }));
  pi.on("model_select", (event) => apply({ type: "model_select", model: event.model.id }));

  pi.on("session_shutdown", async () => {
    session = undefined;
    clearInterval(pollTimer);
    pollTimer = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    setRunPending(false);
    await apply({ type: "session_shutdown" });
  });

  pi.registerCommand("agents", {
    description: "Agent dashboard (detach from this agent first)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(DETACH_FIRST_MESSAGE, "info");
    },
  });
}
