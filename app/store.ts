// app/store.ts — the device-side replica state. The companion daemon
// owns terminal truth; this store only applies ordered grid updates onto
// per-row signals and turns UI intents into protocol lines. gen/seq guard the
// one lossy hop (the svc line queue drops oldest under backlog): a gap asks
// the host for a fresh snapshot instead of rendering from a hole.

import { createSignal, type Accessor } from "solid-js";
import { getOps } from "@pocketjs/framework";
import {
  TERM_PROTO,
  type Cursor,
  type HostInputLine,
  type HostLine,
  type KeyName,
  type Role,
  type Run,
  type SessionInfo,
} from "./protocol.ts";
import type { Svc } from "./svc.ts";

export type ConnState = "no-svc" | "search" | "link" | "live";

/** 0xRRGGBB -> the ABGR u32 the engine's color props carry. */
export function rgbToAbgr(rgb: number): number {
  return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff)) >>> 0;
}

const RESYNC_COOLDOWN_FRAMES = 30;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Decode base64 into bytes. The engine's own codec lives in an internal
 *  module (framework/src/bytes.ts, no published subpath), and a font atlas is
 *  the only binary this app carries, so it brings its own. */
function base64ToBytes(text: string): Uint8Array {
  let length = text.length;
  while (length > 0 && text.charCodeAt(length - 1) === 61) length -= 1; // '='
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let at = 0;
  let bits = 0;
  let width = 0;
  for (let i = 0; i < length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? BASE64_VALUES[code] : -1;
    if (value < 0) continue;
    bits = (bits << 6) | value;
    width += 6;
    if (width >= 8) {
      width -= 8;
      out[at++] = (bits >> width) & 0xff;
    }
  }
  return at === out.length ? out : out.subarray(0, at);
}

export interface TermStore {
  conn: Accessor<ConnState>;
  hostName: Accessor<string>;
  sessions: Accessor<SessionInfo[]>;
  activeSid: Accessor<number>;
  row(y: number): Accessor<Run[]>;
  cursor: Accessor<Cursor | null>;
  scrollback: Accessor<number>;
  bell: Accessor<boolean>;
  /** Glyphs delivered at runtime for codepoints the build never baked; the
   *  count is what the status bar reports. */
  dynamicGlyphs: Accessor<number>;
  /** Pump the channel — call exactly once per frame. */
  frame(): void;
  sendText(s: string): void;
  sendKey(k: KeyName | string, ctrl?: boolean, alt?: boolean): void;
  scroll(lines: number): void;
  newSession(): void;
  kill(sid: number): void;
  attach(sid: number): void;
  attachSibling(step: 1 | -1): void;
}

export interface TermStoreOptions {
  cols: number;
  rows: number;
  /** The measured cell box [w, h] in px — the companion bakes dynamic glyph
   *  advances and cell heights against it. */
  cell: [number, number];
  role?: Role;
}

export function createTermStore(options: TermStoreOptions, svc: Svc | null): TermStore {
  const { cols, rows, cell } = options;
  const role: Role = options.role ?? "device";
  const [conn, setConn] = createSignal<ConnState>(svc === null ? "no-svc" : "search");
  const [hostName, setHostName] = createSignal("");
  const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
  const [activeSid, setActiveSid] = createSignal(-1);
  const [cursor, setCursor] = createSignal<Cursor | null>(null);
  const [scrollback, setScrollback] = createSignal(0);
  const [bell, setBell] = createSignal(false);
  const [dynamicGlyphs, setDynamicGlyphs] = createSignal(0);
  const rowSignals = Array.from({ length: rows }, () => createSignal<Run[]>([]));

  let wasOpen = false;
  let gen = -1;
  let seq = -1;
  let sawGrid = false;
  let resyncCooldown = 0;
  let bellFrames = 0;
  /** Survives a reconnect so the console comes back to the session it was
   *  looking at rather than to whichever one the host lists last. */
  let lastWanted = -1;

  // Atlas reassembly, per slot: the companion bakes one atlas per face in
  // its fallback chain. A bake arrives as ordered chunks; a device that
  // joins mid-bake has no use for the tail and waits for the next one.
  interface AtlasRx {
    gen: number;
    seq: number;
    parts: string[];
  }
  const atlasRx = new Map<number, AtlasRx>();
  const glyphCounts = new Map<number, number>();

  const clearGrid = () => {
    for (const [, set] of rowSignals) set([]);
    setCursor(null);
    setScrollback(0);
  };

  const requestResync = () => {
    if (resyncCooldown > 0) return;
    resyncCooldown = RESYNC_COOLDOWN_FRAMES;
    svc?.send({ t: "resync" });
  };

  const applyAtlas = (line: Extract<HostLine, { t: "atlas" }>) => {
    let rx = atlasRx.get(line.slot);
    if (rx === undefined || line.gen !== rx.gen) {
      if (line.seq !== 0) return; // joined mid-bake; the next one starts clean
      rx = { gen: line.gen, seq: -1, parts: [] };
      atlasRx.set(line.slot, rx);
    }
    if (line.seq !== rx.seq + 1) {
      atlasRx.delete(line.slot); // a gap; drop the bake and wait for the next
      return;
    }
    rx.seq = line.seq;
    rx.parts.push(line.b64);
    if (line.more === 1) return;
    const blob = base64ToBytes(rx.parts.join(""));
    rx.parts = [];
    const load = getOps().loadFontAtlas;
    if (!load || blob.length < 16) return;
    load(blob);
    // Each blob's header carries its own glyph count (spec FONT ATLAS v3);
    // the status line reports the whole chain's.
    glyphCounts.set(line.slot, blob[6] | (blob[7] << 8));
    let total = 0;
    for (const count of glyphCounts.values()) total += count;
    setDynamicGlyphs(total);
  };

  const applyGrid = (line: Extract<HostLine, { t: "grid" }>) => {
    if (line.sid !== activeSid() && activeSid() !== -1) return;
    if (line.gen < gen) return;
    if (line.gen > gen) {
      // A gen opens with a full snapshot at seq 0; joining later means the
      // head was dropped somewhere and only a fresh snapshot can help.
      if (line.seq !== 0 || !line.full) {
        gen = line.gen; // remember it so the resync's higher gen adopts
        requestResync();
        return;
      }
      gen = line.gen;
      seq = -1;
      clearGrid();
    }
    if (line.seq !== seq + 1) {
      if (line.seq <= seq) return; // duplicate; TCP makes this a host bug
      requestResync();
      return;
    }
    seq = line.seq;
    for (const update of line.rows) {
      const [y, ...runs] = update;
      if (y >= 0 && y < rows) rowSignals[y][1](runs);
    }
    if (line.cur) setCursor(line.cur);
    if (line.sb !== undefined) setScrollback(line.sb);
    sawGrid = true;
    setConn("live");
  };

  const sendText = (s: string) => {
    if (s.length > 0) svc?.send({ t: "ch", s });
  };
  const sendKey = (k: KeyName | string, ctrl?: boolean, alt?: boolean) => {
    svc?.send({
      t: "key",
      k,
      ...(ctrl ? { ctrl: 1 as const } : {}),
      ...(alt ? { alt: 1 as const } : {}),
    });
  };
  const scroll = (lines: number) => {
    if (lines !== 0) svc?.send({ t: "scroll", d: lines });
  };

  const apply = (line: HostLine | HostInputLine) => {
    switch (line.t) {
      case "hello":
        // The local host says hello too, with a viewport and no proto. Only
        // the companion's introduces the session.
        if (!("proto" in line)) break;
        setHostName(line.name);
        if (line.sid !== undefined) {
          setActiveSid(line.sid);
          lastWanted = line.sid;
        }
        break;

      // Input from the machine this replica runs on (hosts/desktop forwards
      // the window's keystrokes). The companion owns the PTY, so a window
      // types by relaying, not by echoing anything locally.
      case "ch":
        sendText(line.s);
        break;
      case "key":
        sendKey(line.k, line.ctl === true, line.alt === true);
        break;
      case "paste":
        sendText(line.text);
        break;
      case "scroll":
        // A wheel notch is worth a line of history.
        scroll(-Math.sign(line.dy) * Math.max(1, Math.round(Math.abs(line.dy) / 20)));
        break;
      case "resize":
      case "load":
      case "mouse":
      case "ime":
        // Not part of a terminal replica's contract: the grid is sized by
        // the console, and a commit arrives as its own "ch" line.
        break;
      case "sessions":
        setSessions(line.list);
        if (line.active !== activeSid()) {
          setActiveSid(line.active);
          if (line.active >= 0) lastWanted = line.active;
        }
        if (line.list.length === 0) {
          // Nothing is attached any more: drop the last session's screen
          // rather than leave a dead one on display, and forget the
          // generation so the next session's snapshot is adopted cleanly.
          clearGrid();
          gen = -1;
          seq = -1;
          sawGrid = false;
          lastWanted = -1;
        }
        break;
      case "grid":
        applyGrid(line);
        break;
      case "atlas":
        applyAtlas(line);
        break;
      case "exit":
        // The host follows with a sessions line; nothing to do locally.
        break;
      case "bell":
        bellFrames = 8;
        setBell(true);
        break;
    }
  };

  const attach = (sid: number) => {
    if (sid === activeSid()) return;
    lastWanted = sid;
    svc?.send({ t: "attach", sid });
  };

  return {
    conn,
    hostName,
    sessions,
    activeSid,
    row: (y) => rowSignals[y][0],
    cursor,
    scrollback,
    bell,
    dynamicGlyphs,
    frame() {
      if (svc === null) return;
      if (resyncCooldown > 0) resyncCooldown -= 1;
      if (bellFrames > 0 && --bellFrames === 0) setBell(false);
      const open = svc.open();
      if (open && !wasOpen) {
        // Fresh transport (first frame or reconnect): re-introduce ourselves,
        // naming the session we were on so a reconnect is invisible.
        gen = -1;
        seq = -1;
        sawGrid = false;
        atlasRx.clear();
        glyphCounts.clear();
        svc.send({
          t: "hello",
          proto: TERM_PROTO,
          cols,
          rows,
          cell,
          role,
          ...(lastWanted >= 0 ? { want: lastWanted } : {}),
        });
      }
      wasOpen = open;
      if (!open) {
        setConn("search");
        return;
      }
      if (conn() !== "live" || !sawGrid) setConn(sawGrid ? "live" : "link");
      for (const line of svc.poll()) apply(line);
    },
    sendText,
    sendKey,
    scroll,
    newSession() {
      svc?.send({ t: "new" });
    },
    kill(sid) {
      if (sid >= 0) svc?.send({ t: "kill", sid });
    },
    attach,
    attachSibling(step) {
      const list = sessions();
      if (list.length < 2) return;
      const at = list.findIndex((s) => s.sid === activeSid());
      const next = list[(at + step + list.length) % list.length];
      if (next) attach(next.sid);
    },
  };
}
