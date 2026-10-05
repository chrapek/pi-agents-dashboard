import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** Private tmux server config, verbatim from spec §8. */
export const TMUX_CONF = `set -g status off
set -g prefix None
unbind C-b
bind -n 'C-\\' detach-client
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
`;

export class TmuxNotFoundError extends Error {
  constructor() {
    super("tmux not found — install tmux ≥ 3.5");
    this.name = "TmuxNotFoundError";
  }
}

export class TmuxError extends Error {
  readonly cmd: string;
  readonly stderr: string;
  /** `fallback` is the message detail when stderr is empty. */
  constructor(cmd: string, stderr: string, fallback: string) {
    const firstLine = stderr.split("\n").find((line) => line.trim() !== "")?.trim() ?? fallback;
    super(`tmux ${cmd} failed: ${firstLine}`);
    this.name = "TmuxError";
    this.cmd = cmd;
    this.stderr = stderr;
  }
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>; // each becomes `-e KEY=VALUE`
  argv: string[]; // command + args, passed after `--`, reaches the child verbatim
}

// stderr when no server listens on the socket. Other connection errors (e.g. Permission denied) are real failures.
const NO_SERVER_RE = /no server running|error connecting to .*\(No such file or directory\)/;
const NO_SESSION_RE = /can't find session/;
// A wedged server must not hang the dashboard.
const RUN_TIMEOUT_MS = 10_000;

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** tmux treats a command argument ending in `;` as a command separator; `\\;` at the end yields a literal `;`. */
function escapeTrailingSemicolon(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

/** `-t` value that matches the session name exactly (tmux otherwise falls back to prefix/pattern matching). */
function exactTarget(name: string): string {
  return `=${name}`;
}

export class Tmux {
  readonly socket: string;
  private readonly configPath: string;
  private readonly bin: string;

  constructor(opts: { configPath: string; socket?: string; bin?: string }) {
    this.configPath = opts.configPath;
    this.socket = opts.socket ?? "pi-agents";
    this.bin = opts.bin ?? "tmux";
  }

  async ensureConfig(): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, TMUX_CONF);
  }

  async liveSessions(): Promise<Set<string>> {
    try {
      const stdout = await this.run("list-sessions", ["-F", "#{session_name}"]);
      return new Set(stdout.split("\n").filter((line) => line !== ""));
    } catch (err) {
      if (err instanceof TmuxError && NO_SERVER_RE.test(err.stderr)) return new Set();
      throw err;
    }
  }

  async newSession(opts: NewSessionOptions): Promise<void> {
    if (opts.argv.length === 0) throw new Error("newSession: argv must not be empty");
    // tmux format-expands `-c` (`#S`, `#P`, …); `##` is a literal `#`. `-e` values and argv are not expanded.
    const cwd = opts.cwd.replaceAll("#", "##");
    const args = ["-d", "-s", opts.name, "-c", cwd, "-x", String(opts.cols), "-y", String(opts.rows)];
    for (const [key, value] of Object.entries(opts.env)) args.push("-e", `${key}=${value}`);
    // tmux runs a lone command argument through `sh -c`; with two or more it execs them directly.
    // Wrap a single-element argv so it is exec'd verbatim too.
    const argv = opts.argv.length === 1 ? ["/bin/sh", "-c", 'exec "$0"', opts.argv[0]!] : opts.argv;
    await this.run("new-session", [...args, "--", ...argv]);
  }

  /** Kills the session named exactly `name`; ok if it or the server doesn't exist. */
  async killSession(name: string): Promise<void> {
    try {
      await this.run("kill-session", ["-t", exactTarget(name)]);
    } catch (err) {
      if (err instanceof TmuxError && (NO_SERVER_RE.test(err.stderr) || NO_SESSION_RE.test(err.stderr))) return;
      throw err;
    }
  }

  /** Attach to the session named exactly `name` in the foreground; TMUX/TMUX_PANE are dropped so it works from inside tmux or herdr. */
  attachSync(name: string): { status: number | null; error?: Error } {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const result = spawnSync(this.bin, [...this.baseArgs(), "attach-session", "-t", exactTarget(name)], {
      stdio: "inherit",
      env,
    });
    if (result.error) return { status: result.status, error: isEnoent(result.error) ? new TmuxNotFoundError() : result.error };
    return { status: result.status };
  }

  private baseArgs(): string[] {
    return ["-L", this.socket, "-f", this.configPath];
  }

  /** Runs `tmux -L <socket> -f <config> <cmd> <args…>`, resolving with stdout. */
  private run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const argv = [...this.baseArgs(), cmd, ...args.map(escapeTrailingSemicolon)];
      execFile(this.bin, argv, { encoding: "utf8", timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (isEnoent(err)) return reject(new TmuxNotFoundError());
        const fallback = err.killed ? `timed out after ${RUN_TIMEOUT_MS}ms` : `exit ${err.code ?? err.signal}`;
        reject(new TmuxError(cmd, stderr, fallback));
      });
    });
  }
}
