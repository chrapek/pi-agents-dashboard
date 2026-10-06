// Dashboard screen (spec §6): a pi-tui component opened by WP8 through ctx.ui.custom().
// Resolves `{type:"close"}` or `{type:"attach", id}`; attaching itself (stop TUI, tmux attach) is WP8's job.
import { Input, matchesKey, SelectList } from "@earendil-works/pi-tui";
import type { AutocompleteProvider, AutocompleteSuggestions, Component, Focusable, SelectListTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { isDirty as gitIsDirty } from "../git.ts";
import { sortRows } from "../state.ts";
import type { Row } from "../state.ts";
import type { DashboardResult, DashboardService } from "./service-types.ts";
import { DISPATCH_PLACEHOLDER, renderDashboard } from "./view.ts";
import type { DashboardView, HeaderContext, InputLineModel, MessageTone, Paint } from "./view.ts";

export type ThemeLike = Pick<Theme, "fg" | "bg" | "bold">;

export interface DashboardOptions {
  service: DashboardService;
  launchCwd: string; // passed to dispatch
  context: HeaderContext; // title bar and input box label
  theme: ThemeLike;
  done: (r: DashboardResult) => void; // from ctx.ui.custom
  requestRender: () => void; // tui.requestRender
  height: () => number; // available rows
  initialSelectedId?: string;
  isDirty?: (path: string) => Promise<boolean>; // default: isDirty from src/git.ts
  refreshMs?: number; // default 1000
  doubleKeyMs?: number; // default 2000
  now?: () => number; // for the Ctrl+X window; default Date.now
  slash?: SlashCommands; // default: none (a `/` line is dispatched like any prompt)
  autocompleteMaxVisible?: number; // rows of the `/` menu; default 5, as in Pi
}

/** Pi's slash commands, as its editor offers them (README "Slash commands"). */
export interface SlashCommands {
  /** The autocomplete provider of Pi's editor; null until Pi has built it. */
  autocomplete(): AutocompleteProvider | null;
  /**
   * Whether `/name …` runs in this Pi (built-in and extension commands). Other lines, including prompt
   * templates and skills, are dispatched to a new agent as its prompt.
   */
  runsHere(name: string): Promise<boolean>;
}

/** The open `/` menu: the provider's prefix (needed to apply an item) and the list drawn under the input. */
interface Suggestions {
  prefix: string;
  list: SelectList;
}

/** Same column widths as Pi's editor uses for its slash command menu. */
const SLASH_MENU_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

/** `name` of a `/name …` line, or null when the line is not a slash command. */
export function slashCommandName(text: string): string | null {
  const match = /^\/(\S+)/.exec(text.trim());
  return match ? match[1]! : null;
}

// pi-tui's Input keeps its cursor private; completions need it to read and place the caret.
function inputCursor(input: Input): number {
  const cursor = (input as unknown as { cursor?: unknown }).cursor;
  return typeof cursor === "number" ? cursor : input.getValue().length;
}

function setInputValue(input: Input, value: string, cursor: number): void {
  input.setValue(value);
  (input as unknown as { cursor: number }).cursor = Math.max(0, Math.min(cursor, value.length));
}

/**
 * A pending Ctrl+X: `dirty` is null while the first press is still checking the worktree; `at` is the
 * first press, then restarts when the prompt is shown.
 */
interface ArmedDelete {
  id: string;
  name: string;
  at: number;
  dirty: boolean | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dirtyMessage(path: string): string {
  return `Uncommitted changes in ${path} — press ctrl+x again to discard`;
}

export class Dashboard implements Component, Focusable {
  private readonly service: DashboardService;
  private readonly launchCwd: string;
  private readonly context: HeaderContext;
  private readonly theme: ThemeLike;
  private readonly done: (r: DashboardResult) => void;
  private readonly requestRender: () => void;
  private readonly height: () => number;
  private readonly isDirty: (path: string) => Promise<boolean>;
  private readonly doubleKeyMs: number;
  private readonly now: () => number;
  private readonly slash: SlashCommands | null;
  private readonly autocompleteMaxVisible: number;

  private rows: Row[] = [];
  private selectedId: string | null;
  private selectedIndex = 0;
  private spinnerFrame = 0;
  private peekOpen = false;
  private peekText: { id: string; lastText: string | null } | null = null;
  private message: { text: string; tone: MessageTone } | null = null;
  private armed: ArmedDelete | null = null;
  private tmuxMissing: string | null = null; // the TmuxNotFoundError message while tmux is missing
  private busy = false; // an attach/dispatch/reply/remove is in flight
  private closed = false;
  private refreshSeq = 0;
  private refreshesInFlight = 0;
  private timer: ReturnType<typeof setInterval> | null;
  private hasFocus = false;
  private suggestions: Suggestions | null = null;
  private suggestionsRequest: AbortController | null = null;

  private readonly paint: Paint = (role, text) =>
    role === "bold" ? this.theme.bold(text) : role === "selected" ? this.theme.bg("selectedBg", text) : this.theme.fg(role, text);
  private readonly dispatchInput = new Input({
    prompt: "",
    placeholder: DISPATCH_PLACEHOLDER,
    placeholderStyle: (text) => this.paint("dim", text),
  });
  private readonly replyInput = new Input({ prompt: "" });

  constructor(opts: DashboardOptions) {
    this.service = opts.service;
    this.launchCwd = opts.launchCwd;
    this.context = opts.context;
    this.theme = opts.theme;
    this.done = opts.done;
    this.requestRender = opts.requestRender;
    this.height = opts.height;
    this.isDirty = opts.isDirty ?? gitIsDirty;
    this.doubleKeyMs = opts.doubleKeyMs ?? 2000;
    this.now = opts.now ?? Date.now;
    this.slash = opts.slash ?? null;
    this.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(opts.autocompleteMaxVisible ?? 5)));
    this.selectedId = opts.initialSelectedId ?? null;
    this.timer = setInterval(() => {
      if (this.refreshesInFlight === 0) void this.refresh();
    }, opts.refreshMs ?? 1000);
    this.timer.unref();
    void this.refresh();
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.syncFocus();
  }

  /** One snapshot (plus the peeked agent when peek is open); never rejects. */
  async refresh(): Promise<void> {
    if (this.closed) return;
    const seq = ++this.refreshSeq;
    this.refreshesInFlight++;
    try {
      let rows: Row[];
      try {
        rows = await this.service.snapshot();
      } catch (err) {
        if (seq === this.refreshSeq) this.showError(err);
        return;
      }
      if (seq !== this.refreshSeq || this.closed) return;
      this.tmuxMissing = null;
      this.rows = sortRows(rows);
      this.spinnerFrame++;
      this.reconcileSelection();
      this.expireArm();
      if (this.peekOpen && this.selectedId !== null) await this.loadPeek(this.selectedId);
    } finally {
      this.refreshesInFlight--;
      this.update();
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.expireArm();
    if (!this.armed) this.message = null;
    if (this.suggestions !== null && !this.isPeekMode() && this.handleSuggestionKey(data)) {
      this.update();
      return;
    }
    if (matchesKey(data, "up")) this.moveSelection(-1);
    else if (matchesKey(data, "down")) this.moveSelection(1);
    else if (this.isPeekMode()) this.handlePeekKey(data);
    else this.handleListKey(data);
    this.update();
  }

  render(width: number): string[] {
    this.syncFocus();
    return renderDashboard(this.buildView(), width, this.height(), this.paint);
  }

  invalidate(): void {
    // Nothing cached: every render rebuilds from state with the current theme.
  }

  dispose(): void {
    this.closed = true;
    this.stopTimer();
    this.clearSuggestions();
  }

  // --- keys ---

  /** Keys for the open `/` menu, as in Pi's editor; false lets the key through to the input. */
  private handleSuggestionKey(data: string): boolean {
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.suggestions!.list.handleInput(data);
      return true;
    }
    if (matchesKey(data, "tab")) {
      this.applySuggestion();
      return true;
    }
    if (matchesKey(data, "enter")) {
      // A completed command name runs right away (Pi submits it too); a completed argument waits for Enter.
      const commandName = this.suggestions!.prefix.startsWith("/");
      this.applySuggestion();
      if (commandName) void this.runAction(() => this.submit(false, true));
      return true;
    }
    if (matchesKey(data, "escape")) {
      this.clearSuggestions();
      return true;
    }
    return false;
  }

  private handleListKey(data: string): void {
    const value = this.dispatchInput.getValue();
    if (matchesKey(data, "shift+enter") || matchesKey(data, "enter")) {
      const attachAfter = matchesKey(data, "shift+enter");
      if (value.trim() === "") this.attachSelected();
      else void this.runAction(() => this.submit(attachAfter, false));
    } else if (matchesKey(data, "right") && value === "") {
      this.attachSelected();
    } else if (matchesKey(data, "space") && value === "") {
      this.openPeek();
    } else if (matchesKey(data, "escape")) {
      if (value !== "") this.clearDispatchInput();
      else this.finish({ type: "close" });
    } else if (matchesKey(data, "ctrl+x")) {
      void this.ctrlX();
    } else {
      this.dispatchInput.handleInput(data);
      if (this.dispatchInput.getValue() !== value) this.requestSuggestions();
    }
  }

  private handlePeekKey(data: string): void {
    const value = this.replyInput.getValue();
    if (matchesKey(data, "enter")) {
      if (value.trim() !== "") void this.runAction(() => this.replyNow());
    } else if (matchesKey(data, "right") && value === "") {
      this.attachSelected();
    } else if (matchesKey(data, "escape")) {
      this.peekOpen = false;
      this.peekText = null;
      this.replyInput.setValue("");
    } else {
      this.replyInput.handleInput(data);
    }
  }

  // --- selection & peek ---

  private selectedRow(): Row | null {
    return this.rows.find((r) => r.id === this.selectedId) ?? null;
  }

  private isPeekMode(): boolean {
    return this.peekOpen && this.selectedRow() !== null;
  }

  private reconcileSelection(): void {
    const idx = this.selectedId === null ? -1 : this.rows.findIndex((r) => r.id === this.selectedId);
    if (idx >= 0) {
      this.selectedIndex = idx;
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.rows.length - 1));
      this.selectedId = this.rows[this.selectedIndex]?.id ?? null;
    }
    if (this.selectedId === null) this.peekOpen = false;
    if (this.armed && this.armed.id !== this.selectedId) this.disarm();
  }

  private moveSelection(delta: number): void {
    if (this.rows.length === 0) return;
    const idx = Math.max(0, Math.min(this.selectedIndex + delta, this.rows.length - 1));
    const id = this.rows[idx]!.id;
    if (id === this.selectedId) return;
    this.selectedIndex = idx;
    this.selectedId = id;
    this.disarm();
    if (this.peekOpen) {
      this.replyInput.setValue(""); // a draft must not go to a different agent
      void this.loadPeek(id);
    }
  }

  private openPeek(): void {
    const row = this.selectedRow();
    if (!row) return;
    this.peekOpen = true;
    this.peekText = null;
    void this.loadPeek(row.id);
  }

  /** Never rejects; ignores results for a selection that has moved on. */
  private async loadPeek(id: string): Promise<void> {
    try {
      const peek = await this.service.peek(id);
      if (this.closed || !this.peekOpen || this.selectedId !== id) return;
      this.peekText = { id, lastText: peek?.status?.lastText ?? null };
    } catch (err) {
      this.showError(err);
    } finally {
      this.update();
    }
  }

  // --- actions ---

  /** Runs one service action at a time; errors land on the message line. */
  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      await action();
    } catch (err) {
      this.showError(err);
    } finally {
      this.busy = false;
      this.update();
    }
  }

  private attachSelected(): void {
    const row = this.selectedRow();
    if (row) void this.runAction(() => this.attachNow(row.id));
  }

  private async attachNow(id: string): Promise<void> {
    await this.service.ensureRunning(id);
    this.finish({ type: "attach", id });
  }

  /**
   * Enter on a non-empty input: a built-in or extension `/command` closes the dashboard and runs in this Pi;
   * anything else is dispatched. `completed`: the line was just completed from the `/` menu, so a prompt
   * template or skill is left in the input for the task to be typed after it.
   */
  private async submit(attachAfter: boolean, completed: boolean): Promise<void> {
    const text = this.dispatchInput.getValue().trim();
    const name = slashCommandName(text);
    if (name !== null && this.slash !== null && (await this.slash.runsHere(name))) {
      this.finish({ type: "command", text });
      return;
    }
    if (!completed) await this.dispatchNow(attachAfter);
  }

  private async dispatchNow(attachAfter: boolean): Promise<void> {
    if (this.tmuxMissing !== null) {
      this.message = { text: this.tmuxMissing, tone: "error" };
      return;
    }
    const sent = this.dispatchInput.getValue();
    const meta = await this.service.dispatch(sent.trim(), this.launchCwd);
    if (this.closed) return;
    if (this.dispatchInput.getValue() === sent) this.clearDispatchInput();
    this.selectedId = meta.id;
    this.disarm();
    this.message = { text: `Dispatched ${meta.name}`, tone: "info" };
    await this.refresh();
    if (attachAfter) await this.attachNow(meta.id);
  }

  private async replyNow(): Promise<void> {
    const row = this.selectedRow();
    if (!row) return;
    const sent = this.replyInput.getValue();
    const result = await this.service.reply(row.id, sent.trim());
    if (this.closed) return;
    if (this.replyInput.getValue() === sent) this.replyInput.setValue("");
    this.message = { text: result === "queued" ? "Reply sent" : `Restarted ${row.name}`, tone: "info" };
  }

  private async ctrlX(): Promise<void> {
    const row = this.selectedRow();
    if (!row || this.busy) return;
    const armed = this.armed;
    if (armed && armed.id === row.id) {
      if (armed.dirty === null) return; // still checking the worktree: the user must see the prompt first
      if (this.now() - armed.at <= this.doubleKeyMs) {
        await this.runAction(() => this.removeNow(armed));
        return;
      }
    }
    await this.arm(row);
  }

  private async arm(row: Row): Promise<void> {
    const armed: ArmedDelete = { id: row.id, name: row.name, at: this.now(), dirty: null };
    this.armed = armed;
    try {
      const peek = await this.service.peek(row.id);
      const path = peek?.meta.worktree ?? null;
      let dirty = false;
      if (path !== null) {
        // An unreadable worktree counts as clean: remove(id, false) still refuses to discard changes.
        dirty = await this.isDirty(path).catch(() => false);
      }
      if (this.armed !== armed) return;
      armed.dirty = dirty;
      armed.at = this.now(); // the double-press window starts when the prompt is shown
      this.message =
        dirty && path !== null
          ? { text: dirtyMessage(path), tone: "warning" }
          : { text: `Press ctrl+x again to delete ${row.name}`, tone: "info" };
    } catch (err) {
      if (this.armed !== armed) return;
      this.armed = null;
      this.showError(err);
    } finally {
      this.update();
    }
  }

  private async removeNow(armed: ArmedDelete): Promise<void> {
    let result: { removed: boolean; dirty?: string; branchKept?: string };
    try {
      result = await this.service.remove(armed.id, armed.dirty === true);
    } catch (err) {
      this.disarm();
      throw err;
    }
    if (this.closed) return;
    if (result.removed) {
      this.armed = null;
      const kept = result.branchKept ? ` · Branch kept: ${result.branchKept}` : "";
      this.message = { text: `Deleted ${armed.name}${kept}`, tone: "info" };
      await this.refresh();
    } else if (result.dirty !== undefined) {
      this.armed = { ...armed, at: this.now(), dirty: true };
      this.message = { text: dirtyMessage(result.dirty), tone: "warning" };
    } else {
      this.armed = null;
      this.message = { text: `Could not delete ${armed.name}`, tone: "error" };
    }
  }

  private expireArm(): void {
    // A still-running worktree check never expires: its window starts when the prompt is shown.
    if (this.armed && this.armed.dirty !== null && this.now() - this.armed.at > this.doubleKeyMs) this.disarm();
  }

  /** Drops a pending Ctrl+X together with its prompt. */
  private disarm(): void {
    if (!this.armed) return;
    this.armed = null;
    this.message = null;
  }

  // --- `/` menu ---

  /** Asks Pi's autocomplete for the current input; the menu shows only for `/` lines, like Pi's editor. */
  private requestSuggestions(): void {
    this.suggestionsRequest?.abort();
    this.suggestionsRequest = null;
    const provider = this.slash?.autocomplete() ?? null;
    const value = this.dispatchInput.getValue();
    if (provider === null || !value.trimStart().startsWith("/")) {
      this.suggestions = null;
      return;
    }
    const request = new AbortController();
    this.suggestionsRequest = request;
    const stale = () => request.signal.aborted || this.closed || this.dispatchInput.getValue() !== value;
    provider.getSuggestions([value], 0, inputCursor(this.dispatchInput), { signal: request.signal }).then(
      (result) => {
        if (stale()) return;
        this.suggestionsRequest = null;
        this.suggestions = result !== null && result.items.length > 0 ? this.suggestionsFor(result) : null;
        this.update();
      },
      () => {
        if (stale()) return; // a failing provider just means no menu
        this.suggestionsRequest = null;
        this.suggestions = null;
        this.update();
      },
    );
  }

  private suggestionsFor(result: AutocompleteSuggestions): Suggestions {
    const { items, prefix } = result;
    const slashTheme: SelectListTheme = {
      selectedPrefix: (t) => this.paint("accent", t),
      selectedText: (t) => this.paint("accent", t),
      description: (t) => this.paint("muted", t),
      scrollInfo: (t) => this.paint("muted", t),
      noMatch: (t) => this.paint("muted", t),
    };
    const list = new SelectList(items, this.autocompleteMaxVisible, slashTheme, prefix.startsWith("/") ? SLASH_MENU_LAYOUT : undefined);
    // As Pi's editor: preselect an exact match, else the first item that starts with what was typed.
    const exact = items.findIndex((i) => i.value === prefix);
    const best = exact >= 0 ? exact : prefix === "" ? -1 : items.findIndex((i) => i.value.startsWith(prefix));
    if (best >= 0) list.setSelectedIndex(best);
    return { prefix, list };
  }

  private applySuggestion(): void {
    const suggestions = this.suggestions;
    const item = suggestions?.list.getSelectedItem() ?? null;
    const provider = this.slash?.autocomplete() ?? null;
    this.clearSuggestions();
    if (suggestions === null || item === null || provider === null) return;
    const value = this.dispatchInput.getValue();
    const result = provider.applyCompletion([value], 0, inputCursor(this.dispatchInput), item, suggestions.prefix);
    setInputValue(this.dispatchInput, result.lines[0] ?? "", result.cursorCol);
  }

  private clearSuggestions(): void {
    this.suggestionsRequest?.abort();
    this.suggestionsRequest = null;
    this.suggestions = null;
  }

  private clearDispatchInput(): void {
    this.dispatchInput.setValue("");
    this.clearSuggestions();
  }

  // --- plumbing ---

  private showError(err: unknown): void {
    if (this.closed) return;
    const text = errorMessage(err);
    if (err instanceof Error && err.name === "TmuxNotFoundError") this.tmuxMissing = text;
    this.message = { text, tone: "error" };
  }

  private finish(result: DashboardResult): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.done(result);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private update(): void {
    if (!this.closed) this.requestRender();
  }

  private syncFocus(): void {
    const peek = this.isPeekMode();
    this.dispatchInput.focused = this.hasFocus && !peek;
    this.replyInput.focused = this.hasFocus && peek;
  }

  private inputModel(input: Input, placeholder: string, active: boolean): InputLineModel {
    return {
      value: input.getValue(),
      placeholder,
      render: active ? (width) => input.render(width)[0] ?? "" : undefined,
    };
  }

  private buildView(): DashboardView {
    const row = this.selectedRow();
    const peek = this.peekOpen && row !== null;
    return {
      rows: this.rows,
      selectedId: this.selectedId,
      spinnerFrame: this.spinnerFrame,
      peek: peek
        ? {
            row,
            lastText: this.peekText?.id === row.id ? this.peekText.lastText : null,
            loading: this.peekText?.id !== row.id,
            reply: this.inputModel(this.replyInput, "", true),
          }
        : null,
      message: this.message,
      input: this.inputModel(this.dispatchInput, DISPATCH_PLACEHOLDER, !peek),
      suggestions: !peek && this.suggestions !== null ? this.suggestions.list : null,
      context: this.context,
    };
  }
}
