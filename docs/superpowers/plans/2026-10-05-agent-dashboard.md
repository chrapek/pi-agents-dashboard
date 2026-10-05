# Pi Agent Dashboard — Work Plan

**Spec:** `docs/superpowers/specs/2026-10-05-agent-dashboard-design.md` (every work package reads it; section refs below).
**Repo:** `~/www/pi-agent-dashboard` · installed later by symlink into `~/.agents/pi/extensions/agent-dashboard`.

This plan splits the build into work packages (WPs) for subagents. Each WP says what to build, the
interface it must expose, and how we know it's done. Implementation steps are the subagent's job (TDD).

## Ground rules (all WPs)

- TypeScript, erasable syntax only, run directly by Node 24 (`node --test`) and by Pi (jiti). Relative imports end in `.ts`.
- Pure logic stays free of Pi runtime imports (`import type` only) so it is testable without Pi.
- Subprocesses via argv arrays (`execFile`/`spawn`), never shell strings.
- `npm test` and `npm run typecheck` pass at the end of every WP; one commit per WP.
- Names fixed by the spec: tmux socket `pi-agents`, branch prefix `pi-agents/`, env `PI_AGENTS_ID`, `PI_AGENTS_HOME`, `PI_AGENTS_PI_BIN`, children get `HERDR_ENV=0`.

## Work packages

| WP | Name | Spec | Depends on |
|---|---|---|---|
| 1 | Scaffold + file store | §3 | — |
| 2 | Row state rules | §5 | 1 |
| 3 | Git worktree adapter | §4, §7 | 1 |
| 4 | Private tmux adapter | §4, §8 | 1 |
| 5 | Agent service | §4, §7, §10 | 2, 3, 4 |
| 6 | Worker role (inside each hosted Pi) | §5, §7, §8 | 1 |
| 7 | Dashboard screen | §6 | 2, 5 (interface only) |
| 8 | Wiring, install, end-to-end check | §6, §9, §10 | all |

```
WP1 ─┬─ WP2 ─┐
     ├─ WP3 ─┼─ WP5 ─┐
     ├─ WP4 ─┘       ├─ WP8
     ├─ WP6 ─────────┤
     └─ (WP7 after WP2 + WP5 interface) ─┘
```
Parallel waves: **[1] → [2, 3, 4, 6] → [5, 7] → [8]**. WP7 can start as soon as WP5's interface below is fixed (it tests against a fake service).

---

### WP1 — Scaffold + file store
**Build:** `package.json` (`"type":"module"`, `pi.extensions: ["./index.ts"]`, scripts `test`/`typecheck`, dev deps `typescript`, `@types/node`, `@earendil-works/pi-coding-agent@1.0.2`, `@earendil-works/pi-tui@1.0.2`), `tsconfig.json`; `src/paths.ts` (home resolution + every path in spec §3), `src/ids.ts` (slug/id/name rules), `src/store.ts` (meta, status, inbox).
**Exposes:** `AgentMeta`, `AgentStatus`, `Phase`, `Outcome` types (field lists in spec §3/§5); `resolveHome`, path helpers; `writeMeta/readMeta/listAgentIds/writeStatus(atomic)/readStatus/enqueueInbox/drainInbox/removeAgentDir`.
**Done when:** ids are `[a-z0-9-]`, ≤ 32-char slug + 4 hex; status writes are atomic; inbox drains in order; unreadable status reads as "none".

### WP2 — Row state rules
**Build:** `src/state.ts`, pure.
**Exposes:** `RowState`, `Row`, `deriveRow(meta, status, alive, now)`, `sortRows`, `formatAge`.
**Done when:** every line of the spec §5 row-state table has a test, including the "ends with `?`" rule and the empty/starting cases.

### WP3 — Git worktree adapter
**Build:** `src/git.ts`.
**Exposes:** `repoRoot`, `createWorktree`, `isDirty`, `removeWorktree`, `deleteBranch`, `deleteBranchIfMerged`, `GitError` (message `git <cmd> failed: <stderr line>`).
**Done when:** integration-tested against throwaway repos, covering repo with no commits, branch already exists, dirty worktree, unmerged branch kept, and dispatch from inside a linked worktree.

### WP4 — Private tmux adapter
**Build:** `src/tmux.ts` with the exact config from spec §8.
**Exposes:** `Tmux` (`ensureConfig`, `liveSessions`, `newSession`, `killSession`, `attachSync`), `TmuxNotFoundError`.
**Done when:** integration-tested on a throwaway socket. Env and argv (including flag-like and quoted args) reach the child verbatim. Attach strips `TMUX`/`TMUX_PANE` so it works when the dashboard itself runs inside tmux or herdr. A missing tmux gives the spec §10 message.

### WP5 — Agent service
**Build:** `src/service.ts` combining WP1–4.
**Exposes (fixed now so WP7 can start):**
```ts
interface DashboardService {
  snapshot(): Promise<Row[]>
  peek(id: string): Promise<{ meta: AgentMeta; status: AgentStatus | null; row: Row } | null>
  dispatch(prompt: string, launchCwd: string): Promise<AgentMeta>
  reply(id: string, text: string): Promise<"queued" | "restarted">
  ensureRunning(id: string): Promise<void>
  remove(id: string, force: boolean): Promise<{ removed: boolean; dirty?: string; branchKept?: string }>
}
```
**Done when:** tested with a fake `pi` script. Dispatch creates the worktree and branch, starts tmux with the spec §4 argv/env, and rolls everything back if any step fails. Reply goes to the inbox when the session is alive and restarts with `--session` when stopped. Delete refuses a dirty worktree unless forced and keeps unmerged branches.

### WP6 — Worker role
**Build:** `src/worker-status.ts` (pure reducer from Pi events to `AgentStatus`, spec §5 event table) and `src/worker.ts` (`registerWorker(pi, id, home)`).
**Behaviour:** writes status, coalesced (immediate on settle/prompt/shutdown). Polls the inbox every 500 ms and delivers via `pi.sendUserMessage`, as a follow-up while working. `←` on an empty editor with no open dialog runs `tmux detach-client`. `/agents` inside a worker says `Detach first (← or Ctrl+\)`.
**Done when:** the reducer has a test per event-table row; the wiring is verified in WP8.

### WP7 — Dashboard screen
**Build:** `src/ui/view.ts` (pure renderer: rows, groups, peek panel, input lines, fits width/height, scrolls to the selection) and `src/ui/dashboard.ts` (Pi TUI component, all keys from spec §6, 1 s refresh, spinner, double `Ctrl+X` with the dirty warning).
**Exposes:** `Dashboard` component that resolves `{type:"close"} | {type:"attach", id}`.
**Done when:** the renderer is tested for layout/width/scrolling and the component is tested for every key in spec §6 against a fake `DashboardService`.

### WP8 — Wiring, install, end-to-end check
**Build:** `src/dashboard-role.ts` and `index.ts`. The role is chosen by `PI_AGENTS_ID`. The dashboard loop and attach use the `tui.stop()` → `tmux attach` → `tui.start()` pattern from Pi's `examples/extensions/interactive-shell.ts`. Also `/agents`, `--agents` flag, `←` to open, and a README (install, keys, `alias pa='pi --agents'`, storage, `Ctrl+\` fallback). Symlink into `~/.agents/pi/extensions/agent-dashboard`.
**Done when:** this manual checklist passes in real Pi:
1. `pi --agents` opens an empty dashboard in a git repo.
2. Dispatch a task that asks a question: the row goes Working → Needs input.
3. Peek shows the question; replying moves the row to Working → Done.
4. Enter attaches to the real Pi in the worktree. `←` returns with the row still selected, and a turn left running keeps running.
5. Shift+Enter dispatches and attaches; `Ctrl+\` detaches.
6. Works when the dashboard runs inside herdr and inside tmux; children don't touch the dashboard's herdr state.
7. `/exit` in a session marks the row Stopped, and Enter resumes the same conversation.
8. `tmux -L pi-agents kill-server` marks all rows Stopped, and a reply restarts one.
9. Double `Ctrl+X` deletes a clean agent (row, worktree, branch); a dirty one warns first.
10. Quit Pi and run `pi --agents` again: sessions are still there and alive.

## Risks to watch

1. **Pi loading duplicate `@earendil-works/*` packages** from the repo's `node_modules`. If WP8 hits it, move them to peer deps.
2. **`←` hijack:** it could fire while a built-in picker (not an extension dialog) is open with an empty editor. Accept for v1, but note it in the README.
3. **Stale tmux server environment.** The server inherits the env of whichever Pi started it first, so after changing API keys, `tmux -L pi-agents kill-server` refreshes it. Document this in the README.
4. **Worktrees lack untracked files** (`.env`, `node_modules`). This is out of scope for v1, and agents install dependencies themselves.
