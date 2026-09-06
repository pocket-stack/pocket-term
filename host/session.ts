/** Durable PTY and terminal state. No device transport or UI objects. */
import pty from "node-pty";
import { GhosttyCore } from "@wterm/ghostty";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
export interface SessionOptions { shell: string; cwd: string; login: boolean }
export interface SessionEvents { output(): void; titles(): void; exit(sid: number): void }

const SCROLLBACK = 2000;

/** The core loads its WASM by fetching a URL, and Node's fetch has no `file:`
 *  scheme — so the module is read once at startup and handed over as a data
 *  URL. Reading it here also fails loudly at boot rather than on the first
 *  session. */
const ghosttyWasmUrl = (() => {
  const path = createRequire(import.meta.url).resolve("@wterm/ghostty/ghostty-vt.wasm");
  return `data:application/wasm;base64,${readFileSync(path).toString("base64")}`;
})();

export class Session {
  readonly sid: number;
  private readonly options: SessionOptions;
  private readonly events: SessionEvents;
  title: string;
  readonly pty: pty.IPty;
  /** The authority. Null only for the moment between spawning the shell and
   *  the core's WASM finishing instantiation; bytes wait in `backlog`. */
  core: GhosttyCore | null = null;
  #backlog: string[] = [];
  cols: number;
  rows: number;
  disposed = false;

  constructor(sid: number, cols: number, rows: number, options: SessionOptions, events: SessionEvents) {
    this.options = options; this.events = events;
    this.sid = sid;
    this.cols = cols;
    this.rows = rows;
    this.title = `${this.options.shell.split("/").pop()} #${sid}`;
    this.pty = pty.spawn(options.shell, [options.login ? "-il" : "-i"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    this.pty.onData((data) => this.#parse(data));
    this.pty.onExit(() => events.exit(this.sid));

    void GhosttyCore.load({ wasmPath: ghosttyWasmUrl, scrollbackLimit: SCROLLBACK })
      .then((core) => {
        if (this.disposed) return;
        core.init(this.cols, this.rows);
        this.core = core;
        const waiting = this.#backlog;
        this.#backlog = [];
        for (const chunk of waiting) this.#parse(chunk);
        this.events.output();
      })
      .catch((error: unknown) => {
        console.error(`[term] session #${sid}: terminal core failed to load: ${String(error)}`);
        events.exit(sid);
      });
  }

  /** Feed the core, then let it answer. libghostty parses synchronously, so
   *  the buffer this serializes reflects the bytes the moment write returns. */
  #parse(data: string): void {
    if (this.disposed) return;
    const core = this.core;
    if (core === null) {
      if (this.#backlog.reduce((n, part) => n + part.length, 0) + data.length > 1024 * 1024) { this.events.exit(this.sid); return; }
      this.#backlog.push(data);
      return;
    }
    core.writeString(data);
    // Programs ask the terminal questions — what are you, where is the
    // cursor, what colours do you use — and wait for the answer. The core
    // composes the replies; nobody but us can put them back on the PTY.
    for (let guard = 0; guard < 16; guard += 1) {
      const response = core.getResponse();
      if (response === null || response === "") break;
      this.pty.write(response);
    }
    this.refreshTitle();
    this.events.output();
  }

  /**
   * What the tab says. A program that sets a window title means it, so that
   * wins; otherwise the tab shows what is actually running in the session —
   * the thing a multiplexer's tabs are for, and the answer the PTY's
   * foreground process group gives directly.
   *
   * The core deliberately ignores OSC 1, the icon name, which is all many
   * prompts set. Reading the process is both more accurate and independent
   * of whether the shell announces anything at all.
   */
  refreshTitle(): void {
    const explicit = this.core?.getTitle();
    const label =
      explicit !== null && explicit !== undefined && explicit.trim() !== ""
        ? explicit.trim()
        : (this.pty.process || this.options.shell.split("/").pop() || "shell");
    const next = `${label.slice(0, 24)} #${this.sid}`;
    if (next === this.title) return;
    this.title = next;
    this.events.titles();
  }

  resize(cols: number, rows: number) {
    if (this.cols === cols && this.rows === rows) return;
    this.cols = cols;
    this.rows = rows;
    this.core?.resize(cols, rows);
    this.pty.resize(cols, rows);
    this.events.output();
  }

  write(data: string) {
    if (data.length > 0) this.pty.write(data);
  }

  /** Paste as one bracketed block when the program asked for it, so an editor
   *  inserts text instead of interpreting every character as a command. */
  paste(text: string) {
    if (text.length === 0) return;
    if (this.core?.bracketedPaste()) this.pty.write(`\x1b[200~${text}\x1b[201~`);
    else this.pty.write(text);
  }

  appCursor(): boolean {
    return this.core?.cursorKeysApp() ?? false;
  }

  cursorHidden(): boolean {
    return this.core ? !this.core.getCursor().visible : false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.#backlog = []; this.core = null;
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
  }
}

