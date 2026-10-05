# Pi Agent Dashboard — Design

Date: 2026-10-05 · Status: draft for review · Target: Pi 1.0.2, tmux ≥ 3.5, git ≥ 2.40, Node 24, macOS/Linux

## 1. Intent

A Claude-Code-`agents`-style dashboard for Pi. One full-screen list of every agent session I dispatched,
across all repos. I type a prompt at the bottom → Pi creates a new git worktree and starts a new, real,
interactive Pi session there with that prompt, in the background. I move with arrows, peek at a session's
latest output and reply without leaving the list, or attach to get the complete native Pi conversation, then
press `←` on an empty prompt to come back. Sessions keep running when I'm not looking at them and when I close
the dashboard.

Success:
- Dispatching N tasks gives N isolated worktrees and N live Pi sessions running in parallel.
- Attached sessions are the real Pi UI with all my extensions, skills, AGENTS.md, providers — no emulation.
- Detaching never interrupts a turn. Closing the dashboard never stops a session.
- The list shows at a glance which sessions need me, which work, which are done.

Non-goals (v1): model-written row summaries, PR status labels, pinning, group-by-repo, notifications,
stop-without-delete, copying untracked files (`.env`) into worktrees, listing Pi sessions not dispatched from
the dashboard, Windows.

## 2. Architecture

Same shape as Claude Code's agent view, with a private tmux server in the role of Claude's supervisor daemon.

```
 dashboard Pi (your terminal)                     tmux server  (-L pi-agents, own config)
 ┌───────────────────────────┐   new-session    ┌───────────────────────────────────────┐
 │ /agents, `pi --agents`, ← │ ───────────────▶ │ session <id>: pi (worker role)         │
 │ list · peek · dispatch    │   attach (fg)    │   cwd = worktree, --tui-mode fullscreen│
 │                           │ ◀──────────────▶ │ session <id2>: pi ...                  │
 └─────────────┬─────────────┘                  └──────────────┬────────────────────────┘
               │ reads meta/status, writes inbox                │ writes status, drains inbox
               ▼                                                ▼
                     <home>/agents/<id>/{meta.json,status.json,inbox/}
```

One extension, two roles, chosen at load time by env:
- **Worker role** (`PI_AGENTS_ID` set — every Pi the dashboard starts): writes `status.json`, delivers inbox
  messages with `pi.sendUserMessage`, detaches the tmux client on `←` with an empty prompt.
- **Dashboard role** (otherwise — any normal Pi): `/agents` command, `--agents` CLI flag, `←` on an empty
  prompt opens the dashboard.

Attach uses the public pattern from Pi's `examples/extensions/interactive-shell.ts`: inside `ctx.ui.custom()`
call `tui.stop()`, run `tmux attach-session` with `stdio: "inherit"` via `spawnSync`, then `tui.start()`.

## 3. Storage

`home` = `$PI_AGENTS_HOME` if set, else `$PI_CODING_AGENT_DIR/agents-dashboard`, else `~/.pi/agent/agents-dashboard`.

```
<home>/tmux.conf                          generated, private server config
<home>/agents/<id>/meta.json              written once by dashboard at dispatch
<home>/agents/<id>/status.json            written by worker (atomic: tmp + rename)
<home>/agents/<id>/inbox/<ms>-<rand>.json {"text": "..."} written by dashboard, deleted by worker
<home>/worktrees/<repoBasename>/<id>/     git worktrees
```

Pi session `.jsonl` files stay where Pi puts them; the worker reports the path in `status.json`.

`id` = slug of the first words of the prompt (lowercase `[a-z0-9-]`, ≤ 32 chars, no leading/trailing `-`,
`agent` if empty) + `-` + 4 lowercase hex chars. It is also the tmux session name and the branch suffix.
`name` = the slug with `-` replaced by spaces.

## 4. Dispatch

1. `repoRoot = git -C <dashboard cwd> rev-parse --show-toplevel` (null when not a repo).
2. Repo: `git -C repoRoot worktree add -b pi-agents/<id> <home>/worktrees/<repoBasename>/<id> HEAD`; cwd = worktree.
   Not a repo: no worktree, cwd = dashboard cwd (row shows `no worktree`).
3. Write `meta.json`.
4. `tmux -L pi-agents -f <home>/tmux.conf new-session -d -s <id> -c <cwd> -x <cols> -y <rows>
   -e PI_AGENTS_ID=<id> -e PI_AGENTS_HOME=<home> -e HERDR_ENV=0 -- <pi> --tui-mode fullscreen --name <name> -- <prompt>`
   (`HERDR_ENV=0` stops the herdr integration in children from reporting into the dashboard's pane.)
   `<pi>` = `$PI_AGENTS_PI_BIN` or `pi`.

`Enter` dispatches and stays on the dashboard. `Shift+Enter` dispatches and attaches.

## 5. Session state

Worker writes `AgentStatus` from Pi events:

| Pi event | Effect |
|---|---|
| `session_start` | `phase: idle`, `sessionFile`, `pid`, `model` |
| `agent_start` | `phase: working`, `activity: null` |
| `tool_execution_start` | `activity` = `bash: <first line of command>` / `<tool> <path>` / `<tool>`, ≤ 80 chars |
| `message_end` (assistant) | `lastText` = its text content joined |
| `agent_end` | `lastOutcome` from last assistant `stopReason`: `error`→error, `aborted`→aborted, else completed |
| `agent_settled` | `phase: idle`, `activity: null` |
| `ui_prompt_start` / `ui_prompt_end` | set / clear `uiPrompt {kind,title}` |
| `session_shutdown` | `phase: exited` |

Dashboard derives a row state (first match wins):

| Row state | Condition | Icon | Summary |
|---|---|---|---|
| `stopped` | tmux session not alive | `∙` dim | `lastText` first line, or `Exited before starting` |
| `needs_input` | `uiPrompt` set, or idle + `lastOutcome=completed` + `lastText` ends with `?` | `●` warning | `uiPrompt.title`, else last sentence ending in `?` |
| `working` | no status yet (`Starting…`), or `phase=working` | animated `✽✻✶✢` accent | `activity` or `Working…` |
| `failed` | idle + `lastOutcome` error | `✗` error | `lastText` first line |
| `done` | otherwise | `✓` success | `lastText` first line |

"Ends with `?`" ignores trailing whitespace and the characters `` * _ ` ) " ' ``.
Groups render in the order Needs input, Working, Done, Failed, Stopped; newest first inside a group.
Age = now − `createdAt`, shown as `45s`, `12m`, `3h`, `2d`.

## 6. Dashboard UI

```
 Agents  1 needs input · 2 working · 3 done
 Needs input (1)
 ▸ ● fix login test        my-app   Should I also update the snapshot?          12m
 Working (2)
   ✽ add rate limiter      my-app   bash: npm test                               3m
 ── peek ─────────────────────────────── (only when open)
 fix login test · my-app · pi-agents/fix-login-test-3f9a · needs input · claude-opus-5-5
 <last ~12 wrapped lines of lastText>
 reply › _
 ───────────────────────────────────────
 › Describe a task for a new agent…
 ↑↓ select · enter attach · space peek · ctrl+x delete · esc close
```

Keys, list mode (dispatch input focused):
- `↑`/`↓` move selection. `Enter`: input empty → attach selected; else dispatch. `Shift+Enter` with text → dispatch + attach.
- `→` with empty input → attach. `Space` with empty input → open peek. `Esc` → clear input if non-empty, else close dashboard.
- `Ctrl+X` twice within 2 s → delete selected. If its worktree is dirty the first press says
  `Uncommitted changes in <path> — press ctrl+x again to discard`, and the second press forces removal.

Keys, peek mode (reply input focused): `↑`/`↓` move selection (peek follows), `Enter` sends a non-empty reply,
`→` with empty reply attaches, `Esc` closes peek.

Refresh: every 1000 ms re-read all agents and live tmux sessions; spinner advances one frame per refresh.
The list scrolls to keep the selection visible when there are more rows than fit.

Attach: ensure the session is running (§7), stop the TUI, `tmux attach-session -t <id>` with `TMUX` removed
from env, restart the TUI, reopen the dashboard with that row selected.

## 7. Reply, resume, delete

- **Reply, session alive:** write an inbox file. The worker watches `inbox/` (poll 500 ms), delivers each
  message in filename order with `pi.sendUserMessage(text)` when idle or `{deliverAs: "followUp"}` when working,
  then deletes the file.
- **Reply or attach, session stopped:** start a new tmux session with the same id and cwd running
  `<pi> --tui-mode fullscreen --session <sessionFile>` (plus `-- <reply>` for a reply). Without a known
  `sessionFile`, rerun the original dispatch argv.
- **Delete:** kill the tmux session; `git worktree remove [--force] <path>`; `git branch -d pi-agents/<id>`
  (safe delete — if it refuses because of unmerged commits, keep the branch and show `Branch kept: <branch>`);
  remove `<home>/agents/<id>`. The Pi session file is kept.

## 8. Detach and the private tmux server

Worker role: `ctx.ui.onTerminalInput` consumes `←` when the editor text is empty and no `uiPrompt` is open,
and runs `tmux detach-client`. Fallback that always works: `Ctrl+\` (tmux root binding).

`<home>/tmux.conf`:
```
set -g status off
set -g prefix None
unbind C-b
bind -n 'C-\' detach-client
set -g escape-time 0
set -g mouse on
set -g history-limit 10000
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features ',*:extkeys'
set -g default-terminal tmux-256color
set -g focus-events on
set -g allow-passthrough on
set -g window-size latest
```

Children run `--tui-mode fullscreen` because tmux owns scrollback (same reason Claude forces fullscreen for
attached sessions).

## 9. Opening the dashboard

- `/agents` in any non-worker Pi.
- `pi --agents` from the shell (flag registered by the extension; `session_start` opens the dashboard).
- `←` on an empty prompt in any non-worker Pi when no `uiPrompt` is open.
- In a worker, `/agents` notifies `Detach first (← or Ctrl+\)`.

## 10. Errors

Every failed git/tmux call surfaces in the dashboard's message line as `<action> failed: <stderr first line>`
and leaves no half-created state behind: a failed `new-session` removes the worktree, branch, and agent dir it
created. A missing `tmux` binary shows `tmux not found — install tmux ≥ 3.5` and disables dispatch.

## 11. Testing

`node --test` on Node 24 (native TS type stripping). Pure modules (ids, state, worker reducer, view) get unit
tests. git and tmux modules get integration tests against temp repos and a per-test tmux socket running
`sleep`. The service is tested with a fake `pi` script that records its argv and env. UI wiring (attach,
`←`, real Pi) is verified with a manual checklist.
