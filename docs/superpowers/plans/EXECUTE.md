Implement the Pi Agent Dashboard in ~/www/pi-agent-dashboard using subagents. I authorize delegation for this whole task.

Read first, fully:
- docs/superpowers/specs/2026-10-05-agent-dashboard-design.md (the spec — source of truth)
- docs/superpowers/plans/2026-10-05-agent-dashboard.md (work plan: WP1–WP8, waves, interfaces, done criteria)
Then load the subagent-driven-development and pi-subagents skills and follow them. Call subagents_enable.

How to run it:
1. Execute in waves exactly as the plan's graph says: [WP1] → [WP2, WP3, WP4, WP6] → [WP5, WP7] → [WP8].
2. One `worker` subagent per WP. Give each worker: the WP section verbatim, the spec sections it names,
   the plan's "Ground rules", and the exact interfaces of the WPs it depends on (copy from code already merged,
   not from memory). Tell it to use TDD (test-driven-development skill), keep to its own files, run
   `npm test && npm run typecheck`, and commit once with `feat: <wp name>`.
3. Parallel waves: one writer per working tree. Create a git worktree per WP outside
   ~/.agents/pi/extensions (e.g. ~/www/pi-agent-dashboard-wt/wpN on branch wp/N), run each worker there,
   then merge the branches into main yourself in WP order and rerun tests on main before the next wave.
   WPs touch disjoint files; if a merge conflicts, stop and tell me.
4. After each WP, run a fresh `reviewer` subagent on that WP's diff against the spec and the WP's
   "Done when". Fix blocking findings with the same worker (or a new one) before merging. Don't accept
   "tests pass" as proof — the reviewer checks the tests actually exercise the done criteria.
5. WP7 may start in wave 3 against a fake DashboardService using the interface in the plan; WP8 must
   wire it to the real AgentService.
6. WP8: do the symlink into ~/.agents/pi/extensions/agent-dashboard only after all tests pass on main.
   Then STOP and give me the 10-item manual checklist from the plan to run myself — attach/detach needs
   a real terminal, so don't fake it.

Rules:
- Don't change the spec or the WP interfaces. If something in the spec is wrong or impossible with
  Pi 1.0.2's APIs, stop and ask me with the evidence (doc path or type definition).
- Use the installed Pi docs/types under ~/.agents/pi/install/releases/1.0.2/node_modules/@earendil-works/
  for API questions; don't guess APIs.
- Integration tests must use throwaway tmux sockets (pi-agents-test-*) and temp git repos; never touch the
  real `pi-agents` socket or my repos.
- After each wave, give me a 3-line status: WPs merged, test count, open issues.
