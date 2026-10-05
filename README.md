# Pi Agent Dashboard

A Pi extension that gives you one full-screen list of background Pi agents across all your repos.
Type a task at the bottom and the dashboard creates a git worktree and starts a real, interactive Pi session
there in a private tmux server. Move with the arrows, peek at an agent's latest output and reply without leaving
the list, or attach to the full Pi conversation and press `←` on an empty prompt to come back.
Agents keep running when you detach or close the dashboard.

## Requirements

- Pi 1.0.2
- tmux ≥ 3.5 (`brew install tmux` / your distro package)
- git ≥ 2.40
- Node 24
- macOS or Linux

## Install

```sh
git clone <this repo> ~/www/pi-agent-dashboard
ln -s ~/www/pi-agent-dashboard ~/.agents/pi/extensions/agent-dashboard
```

Use Pi's own extension directory instead if that is where your extensions live:

```sh
ln -s ~/www/pi-agent-dashboard ~/.pi/agent/extensions/agent-dashboard
```

Pi loads `index.ts` directly; there is no build step. Pi supplies `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` to the extension, so they are only peer dependencies. Run `npm install` only for
development (tests and typechecking).

Agents run the same `pi` binary with the same extensions, so the extension must be installed where every Pi
loads it, not just in one project.

## Opening the dashboard

- `/agents` in any Pi.
- `pi --agents` from the shell. A handy alias: `alias pa='pi --agents'`.
- `←` on an empty prompt.

Use `pi --agents` on its own, with no prompt after it. Pi's parser for extension flags takes the next word
as the flag's value, so `pi --agents fix the bug` would set the flag to `fix`, swallow that word, and not open
the dashboard. Dispatch tasks from the dashboard's input instead.

The dashboard needs the interactive TUI; `/agents` in RPC/print mode only shows a notice.
Inside an agent session, `/agents` says `Detach first (← or Ctrl+\)`.

## Keys

List (the dispatch input at the bottom is focused):

| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection |
| `Enter` | Input empty: attach to the selected agent. Input has text: dispatch a new agent and stay here |
| `Shift+Enter` | Dispatch a new agent and attach to it |
| `→` (empty input) | Attach to the selected agent |
| `Space` (empty input) | Open peek for the selected agent |
| `Ctrl+X` twice within 2 s | Delete the selected agent (tmux session, worktree, branch if merged, agent dir) |
| `Esc` | Clear the input, or close the dashboard when it is empty |

If the worktree has uncommitted changes, the first `Ctrl+X` warns
`Uncommitted changes in <path> — press ctrl+x again to discard`, and the second press removes it anyway.
A branch with unmerged commits is kept (`Branch kept: pi-agents/<id>`). The Pi session file is always kept.

Peek (the reply input is focused):

| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection; peek follows it |
| `Enter` | Send the reply to the agent (restarts a stopped agent with the reply) |
| `→` (empty reply) | Attach |
| `Esc` | Close peek |

Inside an attached agent:

| Key | Action |
|---|---|
| `←` on an empty prompt | Detach and return to the dashboard, with that agent still selected |
| `Ctrl+\` | Detach (always works, e.g. while a dialog is open) |

Detaching never interrupts a running turn. Attaching to a stopped agent resumes the same conversation.

Row states: `◆` Needs input, `✽` Working, `◇` Done, `✗` Failed, `∙` Stopped (its tmux session is gone).

New agents start with the model and thinking level the dashboard's Pi is using (shown under the input box).

## Naming

A new agent first appears under a name cut from its prompt (`fix the login redirect on`). In the background
a small model reads the prompt and gives it a short title (`Fix SSO redirect and add regression test`), usually
within a few seconds. The title replaces the name in the dashboard and becomes the agent's Pi session name
(as with `/name`). The agent id, tmux session, worktree and `pi-agents/<id>` branch keep the prompt slug.

If the model fails, times out (10 s) or has no credentials, the agent keeps the prompt name. A name you set
with `/name` inside an agent is kept unless the dashboard renames that agent again. Closing the dashboard's Pi
right after a dispatch drops the pending name.

## Configuration

All options live in one `agentDashboard` block in Pi's `settings.json` (global or project). An environment
variable, where there is one, overrides the setting.

```json
{
  "agentDashboard": {
    "namingModel": "openai/gpt-6-luna"
  }
}
```

| Setting | Env var | Default | Meaning |
|---|---|---|---|
| `namingModel` | `PI_AGENTS_NAMING_MODEL` | `openai/gpt-6-luna` | `provider/id` of the model that names new agents, or `"off"` |

Settings are read each time the dashboard opens. An invalid value or an unusable model shows a warning
once and turns that feature off.

## Storage

`<home>` is `$PI_AGENTS_HOME` if set, else `$PI_CODING_AGENT_DIR/agents-dashboard`, else
`~/.pi/agent/agents-dashboard`.

```
<home>/tmux.conf                          generated, private tmux server config
<home>/agents/<id>/meta.json              written once by the dashboard at dispatch
<home>/agents/<id>/status.json            written by the agent (atomic: tmp + rename)
<home>/agents/<id>/inbox/<ms>-<rand>.json replies, written by the dashboard, deleted by the agent
<home>/worktrees/<repoBasename>/<id>/     git worktrees, on branch pi-agents/<id>
```

Pi session `.jsonl` files stay where Pi puts them.

Environment variables:

| Variable | Meaning |
|---|---|
| `PI_AGENTS_HOME` | Overrides `<home>` |
| `PI_AGENTS_PI_BIN` | The `pi` binary agents run (default `pi`) |
| `PI_AGENTS_NAMING_MODEL` | Naming model, see [Configuration](#configuration) |
| `PI_AGENTS_ID` | Set by the dashboard in every agent; it makes the extension run as an agent, not a dashboard |

An agent's Pi reads `PI_AGENTS_ID` and `PI_AGENTS_HOME` once at startup and then removes them from its
environment, so Pis started from inside an agent (bash tool, subagents) run as normal Pis rather than as a second
copy of that agent. `/new`, `/resume` and `/reload` inside the agent keep its identity.

Agents run in a private tmux server, `tmux -L pi-agents`, separate from your own tmux. Agents get `HERDR_ENV=0`,
so they don't report into the dashboard's herdr pane.

## Known issues

- **`←` may open the dashboard while a built-in picker is open.** The `←` shortcut checks for an empty editor and
  no open extension dialog. Pi's built-in pickers (e.g. the model selector) are not extension dialogs, so `←`
  there can open the dashboard. Use `/agents` if this gets in the way.
- **Stale tmux server environment.** The private tmux server keeps the environment of whichever Pi started it
  first. After changing API keys or other environment variables, run `tmux -L pi-agents kill-server`.
  Running agents become Stopped; a reply or attach restarts them with the new environment.
- **Worktrees lack untracked files.** A new worktree has only committed files, without `.env`, `node_modules`
  and so on. Agents install dependencies themselves; copy secrets in yourself if a task needs them.

## Troubleshooting

- List the agent sessions: `tmux -L pi-agents ls`
- Attach by hand: `tmux -L pi-agents attach -t <id>` (detach with `Ctrl+\`)
- Stop every agent (they become Stopped and can be restarted from the dashboard):
  `tmux -L pi-agents kill-server`
- `tmux not found — install tmux ≥ 3.5` in the dashboard: install tmux and make sure it is on `PATH`;
  dispatch stays disabled until it is.
- Failed git/tmux calls show as `<action> failed: <first stderr line>` on the dashboard's message line.

## Development

```sh
npm install
npm test          # node --test, Node 24 native TypeScript
npm run typecheck
```

Tests use throwaway tmux sockets named `pi-agents-test-*` and temp dirs; they never touch the real
`pi-agents` server or `~/.pi`.
