// Dashboard role (spec §2, §9): any Pi that is not an agent. Opens the dashboard screen from `/agents`,
// `pi --agents`, or ← on an empty prompt, and runs the attach loop (stop TUI → tmux attach → start TUI).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { AutocompleteProvider, Component, Focusable, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { resolveConfig } from "./config.ts";
import { currentBranch, repoRoot } from "./git.ts";
import { createNamer, type Namer } from "./namer.ts";
import { resolveHome, tmuxConfPath } from "./paths.ts";
import { AgentService } from "./service.ts";
import { Tmux } from "./tmux.ts";
import { Dashboard } from "./ui/dashboard.ts";
import type { DashboardOptions, SlashCommands } from "./ui/dashboard.ts";
import type { DashboardResult, DashboardService } from "./ui/service-types.ts";
import type { HeaderContext } from "./ui/view.ts";

export const NEEDS_TUI_MESSAGE = "The agent dashboard needs the interactive TUI";

/**
 * Full-screen overlay. A plain `ctx.ui.custom()` only replaces the editor area (chat above and footer
 * below stay visible), so the dashboard is an overlay covering the whole terminal; `FullScreen` pads it
 * to the terminal height so the chat does not show through below it.
 */
export const DASHBOARD_OVERLAY_OPTIONS: OverlayOptions = { width: "100%", maxHeight: "100%", anchor: "top-left" };

/** Upper bound on waiting for in-flight input (key releases) before handing the terminal to tmux. */
const ATTACH_DRAIN_MAX_MS = 300;

type DashboardComponent = Component & Focusable & { dispose(): void };

/** Test seams; Pi wiring passes none of these. */
export interface DashboardRoleDeps {
  /** Agent store home; default `resolveHome()`. Used only to build the default service and tmux. */
  home?: string;
  /** Default: socket `pi-agents`, config `<home>/tmux.conf`. */
  tmux?: Tmux;
  /** Default: `AgentService` on `home` sharing `tmux`. */
  service?: DashboardService;
  createDashboard?: (opts: DashboardOptions) => DashboardComponent;
  /** Branch and repo membership of the launch dir; default asks git. */
  gitInfo?: (cwd: string) => Promise<{ branch: string | null; inRepo: boolean }>;
  /** Environment for config overrides; default `process.env`. */
  env?: Record<string, string | undefined>;
}

async function defaultGitInfo(cwd: string): Promise<{ branch: string | null; inRepo: boolean }> {
  const [branch, root] = await Promise.all([currentBranch(cwd), repoRoot(cwd)]);
  return { branch, inRepo: root !== null };
}

/** Pads the dashboard to the terminal height so the full-screen overlay hides the chat behind it. */
class FullScreen implements Component, Focusable {
  private readonly inner: DashboardComponent;
  private readonly height: () => number;

  constructor(inner: DashboardComponent, height: () => number) {
    this.inner = inner;
    this.height = height;
  }

  get focused(): boolean {
    return this.inner.focused;
  }

  set focused(value: boolean) {
    this.inner.focused = value;
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    while (lines.length < this.height()) lines.push("");
    return lines;
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  dispose(): void {
    this.inner.dispose();
  }
}

/** `~/x` for paths under the home directory. */
export function displayPath(p: string, home: string = homedir()): string {
  if (p === home) return "~";
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** The dashboard's model and thinking level, which new agents inherit. */
export interface ModelChoice {
  provider: string;
  id: string;
  thinking: string;
}

export function modelLabel(m: ModelChoice | null): string | null {
  return m === null ? null : m.thinking === "off" ? m.id : `${m.id} (${m.thinking})`;
}

export function modelArgs(m: ModelChoice | null): string[] {
  return m === null ? [] : ["--model", `${m.provider}/${m.id}`, "--thinking", m.thinking];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SubmittableEditor {
  onSubmit?: (text: string) => unknown;
  getText?: () => string;
}

/**
 * Runs `text` the way Pi runs a line submitted from its editor: Pi's submit handler is the only entry point
 * for built-in commands (`/model`, `/settings`, …), so call it on the editor, which has focus again once the
 * dashboard overlay is gone. Without one, leave the line in the editor for the user to submit.
 */
export function submitToEditor(ctx: ExtensionContext, tui: TUI, text: string): void {
  // Pi's TUI (TuiBase) has getFocusedComponent(); the TUI interface it hands to extensions does not declare it.
  const focused = (tui as { getFocusedComponent?: () => unknown }).getFocusedComponent?.();
  const editor = (focused ?? null) as SubmittableEditor | null;
  if (typeof editor?.onSubmit === "function" && typeof editor.getText === "function") {
    Promise.resolve()
      .then(() => editor.onSubmit!(text))
      .catch((err: unknown) => ctx.ui.notify(`${text} failed: ${errorMessage(err)}`, "error"));
    return;
  }
  ctx.ui.setEditorText(text);
  ctx.ui.notify(`Press Enter to run ${text}`, "info");
}

export function registerDashboardRole(pi: ExtensionAPI, deps: DashboardRoleDeps = {}): void {
  const createDashboard = deps.createDashboard ?? ((opts: DashboardOptions) => new Dashboard(opts));
  let wiring: { service: DashboardService; tmux: Tmux } | undefined;
  let open = false; // single instance: the dashboard or an attach is on screen
  let uiPromptOpen = false;
  let unsubscribeInput: (() => void) | undefined;
  let model: ModelChoice | null = null; // captured when the dashboard opens; read by every dispatch
  let namer: Namer | null = null; // built when the dashboard opens; read by every dispatch
  let editorAutocomplete: AutocompleteProvider | null = null; // Pi's editor autocomplete, captured on session_start
  const reportedNamingProblems = new Set<string>();

  const slash: SlashCommands = {
    autocomplete: () => editorAutocomplete,
    async runsHere(name) {
      // Prompt templates and skills expand into a prompt, so they belong to the new agent.
      const registered = pi.getCommands().find((c) => c.name === name);
      if (registered) return registered.source === "extension";
      // Built-in commands are not in getCommands(); Pi's editor lists them with everything else.
      if (editorAutocomplete === null) return false;
      const all = await editorAutocomplete.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
      return all?.items.some((item) => item.value === name) ?? false;
    },
  };

  /** Built on first open, so loading the extension never touches the store or tmux. */
  function getWiring(): { service: DashboardService; tmux: Tmux } {
    if (!wiring) {
      const home = deps.home ?? resolveHome();
      const tmux = deps.tmux ?? new Tmux({ configPath: tmuxConfPath(home) });
      const service: DashboardService = deps.service ?? new AgentService({
        home,
        tmux,
        modelArgs: () => modelArgs(model),
        namer: () => namer,
      });
      wiring = { service, tmux };
    }
    return wiring;
  }

  function attach(ctx: ExtensionContext, tmux: Tmux, id: string): Promise<void> {
    return ctx.ui.custom<void>((tui, _theme, _kb, done) => {
      void (async () => {
        // The attach key fires on press; with the kitty protocol on, its release (`ESC[1;1:3C` for "→")
        // is still in flight. Disable the protocol and swallow pending input first, or tmux receives the
        // release, cannot parse it, and leaves `1;1:3C` in the agent's input.
        await tui.terminal.drainInput(ATTACH_DRAIN_MAX_MS).catch(() => {}); // never block the attach
        tui.stop();
        process.stdout.write("\x1b[2J\x1b[H");
        const res = tmux.attachSync(id);
        tui.start();
        tui.requestRender(true);
        done();
        if (res.error) ctx.ui.notify(res.error.message, "error");
        else if (res.status !== 0) ctx.ui.notify(`tmux attach failed: exit ${res.status}`, "error");
      })();
      return { render: () => [], invalidate() {} };
    });
  }

  /** Re-reads the config (README "Naming") and builds the namer; each problem is reported once. */
  function setupNaming(ctx: ExtensionContext): void {
    const { config, errors } = resolveConfig({ env: deps.env ?? process.env, settings: pi.getSettings() });
    const problems = [...errors];
    namer = null;
    if (config.namingModel !== null) {
      const made = createNamer(ctx.modelRegistry, config.namingModel);
      if (typeof made === "function") namer = made;
      else problems.push(made.error);
    }
    const fresh = problems.filter((p) => !reportedNamingProblems.has(p));
    for (const p of fresh) reportedNamingProblems.add(p);
    if (fresh.length > 0) {
      ctx.ui.notify(`${namer === null ? "Agent naming off" : "Agent dashboard config"}: ${fresh.join("; ")}`, "warning");
    }
  }

  async function headerContext(ctx: ExtensionContext): Promise<HeaderContext> {
    const { branch, inRepo } = await (deps.gitInfo ?? defaultGitInfo)(ctx.cwd);
    return { cwd: displayPath(ctx.cwd), branch, inRepo, modelLabel: modelLabel(model) };
  }

  /** Shows the dashboard until it closes; returns the `/command` line to run, if that is how it closed. */
  async function runDashboard(ctx: ExtensionContext): Promise<{ text: string; tui: TUI } | undefined> {
    const { service, tmux } = getWiring();
    const maxVisible = pi.getSettings().autocompleteMaxVisible;
    let screen: TUI | undefined;
    model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, thinking: pi.getThinkingLevel() } : null;
    setupNaming(ctx);
    const context = await headerContext(ctx);
    let selected: string | undefined;
    while (true) {
      const initialSelectedId = selected;
      const result = await ctx.ui.custom<DashboardResult>(
        (tui, theme, _kb, done) => {
          screen = tui;
          const height = () => tui.terminal.rows;
          const dashboard = createDashboard({
            service,
            launchCwd: ctx.cwd,
            context,
            theme,
            done,
            requestRender: () => tui.requestRender(),
            height,
            initialSelectedId,
            slash,
            autocompleteMaxVisible: maxVisible,
          });
          return new FullScreen(dashboard, height);
        },
        { overlay: true, overlayOptions: DASHBOARD_OVERLAY_OPTIONS },
      );
      if (result.type === "close") return undefined;
      if (result.type === "command") return screen ? { text: result.text, tui: screen } : undefined;
      selected = result.id;
      await attach(ctx, tmux, result.id);
    }
  }

  /** Opens the dashboard unless it is already open; never rejects. */
  async function openDashboard(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(NEEDS_TUI_MESSAGE, "warning");
      return;
    }
    if (open) return;
    open = true;
    let command: { text: string; tui: TUI } | undefined;
    try {
      command = await runDashboard(ctx);
    } catch (err) {
      ctx.ui.notify(`Agent dashboard failed: ${errorMessage(err)}`, "error");
    } finally {
      open = false;
    }
    // After `open` is cleared, so `/agents` (or ← on an empty prompt afterwards) can reopen the dashboard.
    if (command) submitToEditor(ctx, command.tui, command.text);
  }

  /** Keeps the autocomplete Pi's editor uses, for the dashboard's `/` menu, without changing it. */
  function captureEditorAutocomplete(ctx: ExtensionContext): void {
    editorAutocomplete = null;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => {
      editorAutocomplete = current;
      return current;
    });
  }

  function subscribeOpenKey(ctx: ExtensionContext): void {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "left") || isKeyRelease(data)) return undefined;
      if (open || uiPromptOpen || ctx.ui.getEditorText() !== "") return undefined;
      void openDashboard(ctx);
      return { consume: true };
    });
  }

  pi.registerFlag("agents", { type: "boolean", description: "Open the agent dashboard on startup" });

  pi.registerCommand("agents", {
    description: "Open the agent dashboard",
    handler: (_args, ctx) => openDashboard(ctx),
  });

  pi.on("session_start", (event, ctx) => {
    subscribeOpenKey(ctx);
    captureEditorAutocomplete(ctx);
    // Only the initial startup: /new, /resume, or /reload keep the user where they are.
    if (event.reason === "startup" && pi.getFlag("agents") === true && ctx.mode === "tui") {
      void openDashboard(ctx); // not awaited: startup must not wait for the dashboard to close
    }
  });

  pi.on("ui_prompt_start", () => {
    uiPromptOpen = true;
  });
  pi.on("ui_prompt_end", () => {
    uiPromptOpen = false;
  });

  pi.on("session_shutdown", () => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
  });
}
