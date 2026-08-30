// host/serve.ts — the Mac companion daemon for Pocket Term.
//
//   bun install    (once, in this directory — node-pty + @wterm/ghostty)
//   node serve.ts  [--port 8622] [--beacon-port 8621] [--name <picker name>]
//                  [--shell /bin/zsh] [--unicast <device-ip>] [--no-beacon]
//
// Node (>= 23.6, for native type stripping), NOT bun: under Bun this
// machine's node-pty never execs the child — its spawn-helper blocks forever
// in the slave-reattach open() — while the same call under Node works. The
// PTY is the one dependency that dictates the runtime; everything else here
// is runtime-neutral.
//
// Architecture (the zhongduan shape, collapsed to one process): this daemon
// holds the real PTYs and one authoritative libghostty core per session
// — the role Ghostty WASM plays there — and 3DS clients attach as passive
// replicas over the SVC WIRE (PKNT) TCP transport. A UDP beacon on the LAN
// makes discovery zero-config; grid state flows as a full snapshot on attach
// plus ordered row diffs after, all inside gen/seq fences so a lossy device
// queue degrades into a resync, never into a wrong screen.

import { createServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { hostname } from "node:os";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import pty from "node-pty";
import { GhosttyCore } from "@wterm/ghostty";
import {
  LINE_BUDGET,
  TERM_APP,
  TERM_PROTO,
  type ClientLine,
  type Cursor,
  type HostLine,
  type Role,
  type RowUpdate,
  type Run,
  type SessionInfo,
} from "../app/protocol.ts";
import { chunkRows, resolveCell, rowKey, rowRuns, type Cell } from "./grid.ts";
import { DynamicAtlasSet, isBakedCodepoint } from "./glyphs.ts";
import { encodeKey } from "./keys.ts";
import {
  FrameParser,
  WIRE_BEACON_PORT,
  WIRE_MSG,
  WIRE_PORT,
  encodeBeacon,
  encodeCtrl,
  encodeFrame,
  encodeHelloAck,
  parseHello,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
/** The desktop host binary, which is also the `linux-app` one. */
const MIRROR_BIN = join(ROOT, "vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host");
const MIRROR_APP = "pocketterm-mirror-main";

const options = {
  port: WIRE_PORT,
  beaconPort: WIRE_BEACON_PORT,
  name: hostname().replace(/\.local$/, ""),
  shell: process.env.SHELL ?? "/bin/zsh",
  cwd: process.env.HOME ?? process.cwd(),
  unicast: [] as string[],
  beacon: true,
  /** Open a read-only desktop window per session. */
  mirror: true,
};

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") options.port = Number(argv[++i]);
    else if (a === "--beacon-port") options.beaconPort = Number(argv[++i]);
    else if (a === "--name") options.name = argv[++i];
    else if (a === "--shell") options.shell = argv[++i];
    else if (a === "--cwd") options.cwd = argv[++i];
    else if (a === "--unicast") options.unicast.push(argv[++i]);
    else if (a === "--no-beacon") options.beacon = false;
    else if (a === "--no-mirror") options.mirror = false;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
}

// Bun's installer drops the executable bit on prebuilt binaries; node-pty's
// posix_spawn of its helper then fails with a bare "posix_spawnp failed".
for (const helper of [
  join(
    dirname(fileURLToPath(import.meta.url)),
    "node_modules/node-pty/prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  ),
]) {
  if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
}

// ---------------------------------------------------------------------------
// sessions — PTY + authoritative terminal core
// ---------------------------------------------------------------------------

const SCROLLBACK = 2000;

/** The core loads its WASM by fetching a URL, and Node's fetch has no `file:`
 *  scheme — so the module is read once at startup and handed over as a data
 *  URL. Reading it here also fails loudly at boot rather than on the first
 *  session. */
const ghosttyWasmUrl = (() => {
  const path = createRequire(import.meta.url).resolve("@wterm/ghostty/ghostty-vt.wasm");
  return `data:application/wasm;base64,${readFileSync(path).toString("base64")}`;
})();

class Session {
  readonly sid: number;
  title: string;
  readonly pty: pty.IPty;
  /** The authority. Null only for the moment between spawning the shell and
   *  the core's WASM finishing instantiation; bytes wait in `backlog`. */
  core: GhosttyCore | null = null;
  #backlog: string[] = [];
  cols: number;
  rows: number;
  disposed = false;

  constructor(sid: number, cols: number, rows: number) {
    this.sid = sid;
    this.cols = cols;
    this.rows = rows;
    this.title = `${options.shell.split("/").pop()} #${sid}`;
    this.pty = pty.spawn(options.shell, ["-il"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    this.pty.onData((data) => this.#parse(data));
    this.pty.onExit(() => hub.sessionExited(this.sid));

    void GhosttyCore.load({ wasmPath: ghosttyWasmUrl, scrollbackLimit: SCROLLBACK })
      .then((core) => {
        if (this.disposed) return;
        core.init(this.cols, this.rows);
        this.core = core;
        const waiting = this.#backlog;
        this.#backlog = [];
        for (const chunk of waiting) this.#parse(chunk);
        scheduleFlush();
      })
      .catch((error: unknown) => {
        console.error(`[term] session #${sid}: terminal core failed to load: ${String(error)}`);
      });
  }

  /** Feed the core, then let it answer. libghostty parses synchronously, so
   *  the buffer this serializes reflects the bytes the moment write returns. */
  #parse(data: string): void {
    const core = this.core;
    if (core === null) {
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
    scheduleFlush();
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
        : (this.pty.process || options.shell.split("/").pop() || "shell");
    const next = `${label.slice(0, 24)} #${this.sid}`;
    if (next === this.title) return;
    this.title = next;
    hub.sessionsChanged();
  }

  resize(cols: number, rows: number) {
    if (this.cols === cols && this.rows === rows) return;
    this.cols = cols;
    this.rows = rows;
    this.core?.resize(cols, rows);
    this.pty.resize(cols, rows);
    scheduleFlush();
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
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// connections — one attached replica each
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 2000;
const SILENCE_TIMEOUT_MS = 10_000;
/** Coalescing delay after a session produces output. A terminal's echo is a
 *  round trip through here, so this sits directly in the gap between a
 *  keystroke and the character appearing: it is a batching window, not a
 *  polling rate. A byte-at-a-time echo pays 2 ms; a screenful of output
 *  still collapses into one pass. */
const FLUSH_COALESCE_MS = 2;
/** Backstop for the changes no PTY byte announces — a scrollback scrub, a
 *  cursor that moved because a replica attached. */
const FLUSH_IDLE_MS = 100;

/** Base64 per atlas chunk. The device's svc transport discards any ctrl
 *  frame over SVC_POLL_BUF (8192) bytes outright, so a chunk plus its JSON
 *  wrapper has to stay well inside the line budget. */
const ATLAS_CHUNK = 5600;

class Conn {
  readonly socket: Socket;
  readonly parser = new FrameParser();
  hello: Uint8Array | null = new Uint8Array(0);
  role: Role = "device";
  cols = 80;
  rows = 24;
  cell: [number, number] = [7, 13];
  attachedSid = -1;
  /** Atlas generation this replica holds per slot, and the chunks still owed
   *  to it for the slot in flight. One chunk goes out per flush tick: the
   *  device's line queue is 32 KiB and drops its oldest entries when full,
   *  so a whole atlas dumped at once would take the grid updates with it. */
  atlasSent = new Map<number, number>();
  atlasSlot = 0;
  atlasGen = -1;
  atlasQueue: string[] = [];
  atlasSeq = 0;
  gen = 0;
  seq = 0;
  scrollback = 0;
  rowCache: string[] = [];
  lastCursor = "";
  lastRx = Date.now();
  sawClientHello = false;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  sendLine(line: HostLine) {
    this.socket.write(encodeCtrl(JSON.stringify(line)));
  }

  /** Emit rows (+cursor/scrollback trailer) as ordered, chunked grid lines. */
  sendGrid(updates: RowUpdate[], cursor: Cursor, full: boolean) {
    const chunks = chunkRows(updates, LINE_BUDGET);
    for (let i = 0; i < chunks.length; i += 1) {
      const last = i === chunks.length - 1;
      this.sendLine({
        t: "grid",
        sid: this.attachedSid,
        gen: this.gen,
        seq: this.seq++,
        ...(full ? { full: 1 as const } : {}),
        ...(last ? {} : { more: 1 as const }),
        rows: chunks[i],
        ...(last ? { cur: cursor, sb: this.scrollback } : {}),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// the hub
// ---------------------------------------------------------------------------

class Hub {
  readonly sessions = new Map<number, Session>();
  readonly conns = new Set<Conn>();
  private nextSid = 1;
  /** Sessions whose mirror window has been opened but has not connected back
   *  yet. A mirror binds to the head of this queue, so windows and sessions
   *  pair up in the order they were created. */
  private pendingMirrors: number[] = [];
  /** Set by the mirror supervisor; called once per new session. */
  onSessionCreated: ((sid: number) => void) | null = null;

  create(cols: number, rows: number): Session {
    const session = new Session(this.nextSid++, cols, rows);
    this.sessions.set(session.sid, session);
    this.sessionsChanged();
    // A replica left with nothing attached — the empty state after the last
    // session closed — shows the first session that appears, whoever opened
    // it. Without this it would sit at the empty state while sessions exist,
    // which is the empty state lying. Mirrors are bound through the pending
    // queue instead and are left alone here.
    for (const conn of this.conns) {
      if (conn.role === "device" && conn.sawClientHello && conn.attachedSid < 0) {
        attach(conn, session.sid);
      }
    }
    if (this.onSessionCreated) {
      this.pendingMirrors.push(session.sid);
      this.onSessionCreated(session.sid);
    }
    return session;
  }

  /** Claim the session a connecting mirror belongs to: the one it names if
   *  it still exists, else the oldest window still waiting for its session,
   *  else the newest session.
   *
   *  The last fallback matters for a window that outlived the companion —
   *  its own reconnect loop brings it back, and refusing it would leave it
   *  reconnecting forever against a window showing nothing. */
  takePendingMirror(want?: number): number | undefined {
    if (want !== undefined && this.sessions.has(want)) {
      const at = this.pendingMirrors.indexOf(want);
      if (at >= 0) this.pendingMirrors.splice(at, 1);
      return want;
    }
    while (this.pendingMirrors.length > 0) {
      const sid = this.pendingMirrors.shift();
      if (sid !== undefined && this.sessions.has(sid)) return sid;
    }
    return [...this.sessions.keys()].at(-1);
  }

  kill(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    closeMirror(sid);
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  sessionExited(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    closeMirror(sid);
    for (const conn of this.conns) {
      if (conn.sawClientHello) conn.sendLine({ t: "exit", sid });
    }
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  private reattachOrphans(gone: number) {
    for (const conn of this.conns) {
      if (conn.attachedSid !== gone) continue;
      if (conn.role === "mirror") {
        // A mirror exists to show one session. When that session is over so
        // is the window: it is closed rather than pointed at someone else's
        // shell.
        conn.socket.destroy();
        this.conns.delete(conn);
        continue;
      }
      const fallback = [...this.sessions.values()].at(-1);
      if (fallback === undefined) {
        // Closing the last session leaves the replica with nothing attached,
        // not with a shell it did not ask for. Opening one is a decision,
        // and the operator just made the opposite one.
        conn.attachedSid = -1;
        conn.rowCache = [];
        conn.lastCursor = "";
        continue;
      }
      attach(conn, fallback.sid);
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ sid: s.sid, title: s.title }));
  }

  sessionsChanged() {
    for (const conn of this.conns) {
      if (conn.sawClientHello) {
        conn.sendLine({ t: "sessions", list: this.list(), active: conn.attachedSid });
      }
    }
  }
}

const hub = new Hub();

// ---------------------------------------------------------------------------
// the replica view: serialize, diff, flush
// ---------------------------------------------------------------------------

/** Codepoints the device cannot draw from its baked atlas, noted as the grid
 *  is serialized so the next bake covers exactly what is on screen. */
const atlas = new DynamicAtlasSet();

/** Classify a resolved cell against the device's glyph coverage: baked text
 *  passes through, a character some face in the chain can draw is routed to
 *  that face's slot, and one nobody can draw becomes a placeholder of the
 *  same column width — an unrenderable glyph must not also shift the rest of
 *  the row, which is what dropping it or leaving it to a missing atlas would
 *  do. */
const uncovered = new Set<number>();

function classify(cell: Cell): void {
  if (cell.width === 0 || cell.ch === "" || cell.ch === " ") return;
  const cp = cell.ch.codePointAt(0);
  if (cp === undefined || isBakedCodepoint(cp)) return;
  const columns = cell.width === 2 ? 2 : 1;
  const slot = atlas.slotFor(cp);
  if (slot >= 0) {
    atlas.want(cp, columns, slot);
    cell.slot = slot;
    return;
  }
  // A placeholder is the last resort, and the operator should be able to
  // find out which character it stood for rather than guess from a "?".
  if (!uncovered.has(cp)) {
    uncovered.add(cp);
    console.log(
      `[term] no face draws U+${cp.toString(16).toUpperCase().padStart(4, "0")} ` +
        `(${cell.ch}) — showing a placeholder`,
    );
  }
  cell.ch = "?".repeat(columns);
}

/** Resolve the connection's visible window of the session buffer to runs. */
function viewRows(session: Session, conn: Conn): Run[][] {
  const core = session.core;
  const rows: Run[][] = [];
  if (core === null) {
    for (let y = 0; y < conn.rows; y += 1) rows.push([]);
    return rows;
  }
  // Scrolled back, the top of the view comes out of history: the core
  // indexes that directly, oldest line first, so the offset is arithmetic on
  // its own count rather than on a viewport's base row.
  const history = core.getScrollbackCount();
  const back = Math.max(0, Math.min(history, conn.scrollback));
  for (let y = 0; y < conn.rows; y += 1) {
    const fromHistory = y < back;
    const offset = history - back + y;
    const cells: Cell[] = [];
    for (let x = 0; x < conn.cols; x += 1) {
      const cell = fromHistory ? core.getScrollbackCell(offset, x) : core.getCell(y - back, x);
      const resolved = resolveCell(cell);
      classify(resolved);
      cells.push(resolved);
    }
    rows.push(rowRuns(cells));
  }
  return rows;
}

/** Re-bake when the screen has shown codepoints the current atlas lacks. The
 *  bake is debounced: a session that dumps a page of Chinese should cost one
 *  bake, not one per row. */
let atlasDebounce = 0;
function pumpAtlasBake(): void {
  if (!atlas.dirty) {
    atlasDebounce = 0;
    return;
  }
  atlasDebounce += 1;
  if (atlasDebounce < 8) return; // ~250 ms at the flush interval
  atlasDebounce = 0;
  const conn = [...hub.conns].find((c) => c.sawClientHello);
  const [cellW, cellH] = conn?.cell ?? [7, 13];
  for (const baked of atlas.bake(cellW, cellH)) {
    console.log(
      `[term] baked ${baked.glyphCount} glyphs at ${baked.px}px into slot ${baked.slot} ` +
        `(${(baked.bytes.length / 1024).toFixed(1)} KiB)`,
    );
  }
}

/** Hand one atlas chunk to a replica per tick. Every face in the chain is
 *  delivered, one slot at a time. */
function pumpAtlasSend(conn: Conn): void {
  if (!conn.sawClientHello) return;
  if (conn.atlasQueue.length === 0) {
    for (const baked of atlas.current()) {
      if (conn.atlasSent.get(baked.slot) === baked.gen) continue;
      conn.atlasSent.set(baked.slot, baked.gen);
      conn.atlasSlot = baked.slot;
      conn.atlasGen = baked.gen;
      conn.atlasSeq = 0;
      const b64 = Buffer.from(baked.bytes).toString("base64");
      for (let at = 0; at < b64.length; at += ATLAS_CHUNK) {
        conn.atlasQueue.push(b64.slice(at, at + ATLAS_CHUNK));
      }
      break; // one atlas at a time; the next tick starts the next
    }
  }
  const chunk = conn.atlasQueue.shift();
  if (chunk === undefined) return;
  conn.sendLine({
    t: "atlas",
    slot: conn.atlasSlot,
    gen: conn.atlasGen,
    seq: conn.atlasSeq++,
    ...(conn.atlasQueue.length > 0 ? { more: 1 as const } : {}),
    b64: chunk,
  });
}

function cursorFor(session: Session, conn: Conn): Cursor {
  const cursor = session.core?.getCursor();
  if (cursor === undefined) return [0, 0, 0];
  const visible = conn.scrollback === 0 && cursor.visible;
  return [cursor.col, cursor.row, visible ? 1 : 0];
}

/** Full snapshot: a new gen, every row sent (blank rows included). */
function snapshot(conn: Conn) {
  const session = hub.sessions.get(conn.attachedSid);
  if (!session) return;
  conn.gen += 1;
  conn.seq = 0;
  const rows = viewRows(session, conn);
  conn.rowCache = rows.map(rowKey);
  const cursor = cursorFor(session, conn);
  conn.lastCursor = JSON.stringify([cursor, conn.scrollback]);
  const updates: RowUpdate[] = rows.map((runs, y) => [y, ...runs]);
  conn.sendGrid(updates, cursor, true);
}

function flush(conn: Conn) {
  pumpAtlasSend(conn);
  const session = hub.sessions.get(conn.attachedSid);
  if (!session || !conn.sawClientHello) return;
  const rows = viewRows(session, conn);
  const updates: RowUpdate[] = [];
  for (let y = 0; y < rows.length; y += 1) {
    const key = rowKey(rows[y]);
    if (conn.rowCache[y] !== key) {
      conn.rowCache[y] = key;
      updates.push([y, ...rows[y]]);
    }
  }
  const cursor = cursorFor(session, conn);
  const cursorKey = JSON.stringify([cursor, conn.scrollback]);
  if (updates.length === 0 && cursorKey === conn.lastCursor) return;
  conn.lastCursor = cursorKey;
  conn.sendGrid(updates, cursor, false);
}

function attach(conn: Conn, sid: number) {
  if (!hub.sessions.has(sid)) return;
  conn.attachedSid = sid;
  conn.scrollback = 0;
  conn.sendLine({ t: "sessions", list: hub.list(), active: sid });
  snapshot(conn);
}

// ---------------------------------------------------------------------------
// client line handling
// ---------------------------------------------------------------------------

function handleLine(conn: Conn, line: ClientLine) {
  // A mirror types into its own session, and nothing else: the window exists
  // for one session, so it may not re-point itself at another, open one, or
  // close one. That binding is enforced here rather than trusted to the
  // window's guest.
  if (conn.role === "mirror" && (line.t === "attach" || line.t === "new" || line.t === "kill")) {
    return;
  }
  switch (line.t) {
    case "hello": {
      if (line.proto !== TERM_PROTO) return;
      conn.role = line.role ?? "device";
      conn.cols = Math.max(20, Math.min(200, line.cols));
      conn.rows = Math.max(5, Math.min(80, line.rows));
      if (line.cell) conn.cell = [Math.max(1, line.cell[0]), Math.max(1, line.cell[1])];
      conn.sawClientHello = true;
      // A hello means a replica that has loaded nothing yet, which is not the
      // same as a new socket: the console's transport is native and survives
      // a guest reload, so the fresh guest arrives on the connection that
      // already had an atlas. Re-send it or its CJK renders as blanks.
      conn.atlasSent.clear();
      conn.atlasGen = -1;
      conn.atlasQueue = [];
      conn.atlasSeq = 0;

      if (conn.role === "mirror") {
        // A mirror shows one session and changes nothing about it: it takes
        // the session it was opened for, renders whatever size that session
        // already is, and never resizes a PTY.
        const sid = hub.takePendingMirror(line.want);
        const session = sid === undefined ? undefined : hub.sessions.get(sid);
        if (!session) {
          conn.socket.destroy();
          hub.conns.delete(conn);
          return;
        }
        conn.cols = session.cols;
        conn.rows = session.rows;
        conn.sendLine({ t: "hello", proto: TERM_PROTO, name: options.name, sid: session.sid });
        attach(conn, session.sid);
        break;
      }

      conn.sendLine({ t: "hello", proto: TERM_PROTO, name: options.name });
      // The demo convention: every session tracks the driving replica's grid
      // (the tmux attach model, one window size at a time). Other replicas
      // that were sized differently get a fresh snapshot at the new size.
      for (const session of hub.sessions.values()) session.resize(conn.cols, conn.rows);
      for (const other of hub.conns) {
        if (other === conn || !other.sawClientHello) continue;
        if (other.cols !== conn.cols || other.rows !== conn.rows) {
          other.cols = conn.cols;
          other.rows = conn.rows;
          snapshot(other);
        }
      }
      // A reconnecting console names the session it was on, so the window it
      // comes back to is the one it left rather than whichever is newest.
      const wanted = line.want !== undefined ? hub.sessions.get(line.want) : undefined;
      const target = wanted ?? [...hub.sessions.values()].at(-1) ?? hub.create(conn.cols, conn.rows);
      attach(conn, target.sid);
      break;
    }
    case "new": {
      const session = hub.create(conn.cols, conn.rows);
      attach(conn, session.sid);
      break;
    }
    case "kill":
      hub.kill(line.sid);
      break;
    case "attach":
      attach(conn, line.sid);
      break;
    case "ch": {
      const session = hub.sessions.get(conn.attachedSid);
      if (session && line.s.length <= 1024) {
        if (conn.scrollback !== 0) conn.scrollback = 0; // typing snaps to live
        // More than one character at a time is a paste, not typing, and a
        // program that asked for bracketed paste wants to be told which.
        if (line.s.length > 1) session.paste(line.s);
        else session.write(line.s);
      }
      break;
    }
    case "key": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      if (conn.scrollback !== 0) conn.scrollback = 0;
      session.write(encodeKey(line.k, line.ctrl === 1, line.alt === 1, session.appCursor()));
      break;
    }
    case "scroll": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      const max = session.core?.getScrollbackCount() ?? 0;
      conn.scrollback = Math.max(0, Math.min(max, conn.scrollback + line.d));
      // Scrolling changes this replica's view without any PTY byte to
      // announce it.
      scheduleFlush();
      break;
    }
    case "resync":
      snapshot(conn);
      break;
  }
}

// ---------------------------------------------------------------------------
// wire server + beacon
// ---------------------------------------------------------------------------

const server = createServer((socket) => {
  socket.setNoDelay(true);
  const conn = new Conn(socket);

  socket.on("data", (chunk: Buffer) => {
    conn.lastRx = Date.now();
    let bytes = new Uint8Array(chunk);
    try {
      if (conn.hello !== null) {
        const merged = new Uint8Array(conn.hello.length + bytes.length);
        merged.set(conn.hello);
        merged.set(bytes, conn.hello.length);
        const hello = parseHello(merged);
        if (hello === null) {
          conn.hello = merged;
          return;
        }
        if (hello.app !== TERM_APP) throw new Error(`unknown app "${hello.app}"`);
        conn.hello = null;
        socket.write(encodeHelloAck());
        hub.conns.add(conn);
        console.log(`[term] device connected (${socket.remoteAddress ?? "?"})`);
        bytes = merged.slice(hello.consumed);
        if (bytes.length === 0) return;
      }
      for (const frame of conn.parser.push(bytes)) {
        if (frame.type === WIRE_MSG.pong) continue;
        if (frame.type !== WIRE_MSG.ctrl) continue; // forward compatibility
        const text = new TextDecoder().decode(frame.payload);
        try {
          handleLine(conn, JSON.parse(text) as ClientLine);
        } catch {
          // A malformed device line is a device bug; skip it rather than drop.
        }
      }
    } catch (error) {
      console.log(`[term] dropping device: ${(error as Error).message}`);
      socket.destroy();
    }
  });

  const cleanup = () => {
    hub.conns.delete(conn);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

let pingToken = 1;
setInterval(() => {
  const now = Date.now();
  for (const conn of hub.conns) {
    if (now - conn.lastRx > SILENCE_TIMEOUT_MS) {
      console.log("[term] device silent, dropping");
      conn.socket.destroy();
      hub.conns.delete(conn);
      continue;
    }
    const token = new Uint8Array(4);
    new DataView(token.buffer).setUint32(0, pingToken++ >>> 0, true);
    conn.socket.write(encodeFrame(WIRE_MSG.ping, token));
  }
}, PING_INTERVAL_MS);

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushAll(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // What a session is running changes without any output to announce it —
  // launching an editor, or leaving one.
  for (const session of hub.sessions.values()) session.refreshTitle();
  for (const conn of hub.conns) flush(conn);
  pumpAtlasBake();
}

/** Ask for a pass shortly. Output is what makes a session worth serializing,
 *  so a session that just parsed some announces itself rather than waiting
 *  for a poll to come round. */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushAll, FLUSH_COALESCE_MS);
}

setInterval(flushAll, FLUSH_IDLE_MS);

// ---------------------------------------------------------------------------
// mirror windows
// ---------------------------------------------------------------------------

/** One desktop window per session, tracked so it closes with its session. */
const mirrors = new Map<number, ChildProcess>();

/** Open the read-only window for a session. The window is an ordinary
 *  PocketJS app (mirror/) on the stock desktop host, pointed at this
 *  daemon with --svc-connect; it binds to the session through the hello
 *  queue. Nothing here is macOS-specific — the same binary is the linux-app
 *  host. */
function openMirror(sid: number, tcpPort: number): void {
  if (!options.mirror) return;
  if (!existsSync(MIRROR_BIN)) {
    console.log(
      `[term] no mirror window: ${MIRROR_BIN} is not built ` +
        `(bun run macos term-mirror --build-only), continuing without one`,
    );
    options.mirror = false;
    return;
  }
  const child = spawn(
    MIRROR_BIN,
    [
      "--app", MIRROR_APP,
      "--title", `Pocket Term #${sid}`,
      "--viewport", "400x240",
      "--fixed",
      "--density", "2",
      "--companions", TERM_APP,
      "--svc-connect", `127.0.0.1:${tcpPort}`,
    ],
    {
      env: { ...process.env, POCKETJS_DIST: join(ROOT, "dist"), RUST_LOG: "warn" },
      stdio: "ignore",
      detached: false,
    },
  );
  mirrors.set(sid, child);
  child.on("exit", () => {
    if (mirrors.get(sid) === child) mirrors.delete(sid);
  });
  child.on("error", (error) => {
    console.log(`[term] mirror window for #${sid} failed: ${error.message}`);
    mirrors.delete(sid);
  });
}

function closeMirror(sid: number): void {
  const child = mirrors.get(sid);
  if (!child) return;
  mirrors.delete(sid);
  child.kill();
}

function closeAllMirrors(): void {
  for (const [, child] of mirrors) child.kill();
  mirrors.clear();
}

for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    closeAllMirrors();
    if (signal !== "exit") process.exit(0);
  });
}

function startBeacon(tcpPort: number) {
  const beacon = createSocket("udp4");
  beacon.bind(() => {
    beacon.setBroadcast(true);
    const datagram = Buffer.from(encodeBeacon(TERM_APP, options.name, tcpPort));
    const targets = ["255.255.255.255", "127.0.0.1", ...options.unicast];
    setInterval(() => {
      for (const target of targets) {
        beacon.send(datagram, options.beaconPort, target, () => {});
      }
    }, 1000);
    console.log(`[term] beacon on udp/${options.beaconPort} -> ${targets.join(", ")}`);
  });
}

const started = () => {
  const bound = (server.address() as { port: number }).port;
  console.log(`[term] PKNT listener on tcp/${bound} (app "${TERM_APP}")`);
  if (options.beacon) startBeacon(bound);
  if (options.mirror) {
    // Every session gets a window, including ones that already exist when
    // the mirror feature comes up.
    hub.onSessionCreated = (sid) => openMirror(sid, bound);
    for (const sid of hub.sessions.keys()) openMirror(sid, bound);
  }
};

// Several companions can share one machine (the pocket-youtube host also
// speaks PKNT): the beacon advertises the actual TCP port, so when the
// default is taken we fall back to an ephemeral one.
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.log(`[term] tcp/${options.port} is taken — falling back to an ephemeral port`);
  server.listen(0);
});
server.once("listening", started);
server.listen(options.port);

console.log(`[term] shell ${options.shell}, host name "${options.name}"`);
