// test/host.test.ts — the pure halves of the term companion daemon
// (app/host): PKNT framing against the spec constants, SGR resolution
// and run building, chunk budgets, and key encoding. The daemon's PTY/xterm
// wiring itself is runtime-only (node-pty) and stays out of the unit stage.

import { describe, expect, test } from "bun:test";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
  SVC_POLL_BUF,
  WIRE_HEADER_SIZE,
  WIRE_MAGIC,
  WIRE_MSG,
  WIRE_VERSION,
} from "../vendor/pocketjs/contracts/spec/spec.ts";
import { readFileSync } from "node:fs";
import opentype from "opentype.js";
import {
  LINE_BUDGET,
  TERM_GLYPHS,
  THEME_BG,
  THEME_FG,
  type RowUpdate,
} from "../shared/protocol.ts";
import {
  FrameParser,
  encodeBeacon,
  encodeCtrl,
  encodeFrame,
  encodeHelloAck,
  parseHello,
} from "../host/wire.ts";
import {
  CELL_FLAG,
  chunkRows,
  resolveCell,
  rowRuns,
  type Cell,
  type TerminalCell,
} from "../host/grid.ts";
import { encodeKey } from "../host/keys.ts";
import {
  DynamicAtlasSet,
  extractFromCollection,
  forceAdvances,
  isBakedCodepoint,
} from "../host/glyphs.ts";
import { DYNAMIC_SLOTS } from "../shared/protocol.ts";

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

describe("PKNT wire (host side)", () => {
  test("frame header layout matches the spec", () => {
    const frame = encodeFrame(WIRE_MSG.ctrl, new TextEncoder().encode("{}"));
    expect(frame.length).toBe(WIRE_HEADER_SIZE + 2);
    expect(frame[0]).toBe(WIRE_MSG.ctrl);
    expect(frame[1]).toBe(0);
    expect(new DataView(frame.buffer).getUint32(4, true)).toBe(2);
  });

  test("hello ack carries the wire magic + version", () => {
    const ack = encodeHelloAck();
    expect(new DataView(ack.buffer).getUint32(0, true)).toBe(WIRE_MAGIC);
    expect(ack[4]).toBe(WIRE_VERSION);
  });

  test("device hello roundtrip, incremental and with trailing bytes", () => {
    const app = "term";
    const hello = new Uint8Array(7 + app.length + 3);
    new DataView(hello.buffer).setUint32(0, WIRE_MAGIC, true);
    hello[4] = WIRE_VERSION;
    hello[6] = app.length;
    hello.set(new TextEncoder().encode(app), 7);
    expect(parseHello(hello.subarray(0, 5))).toBeNull(); // still short
    const parsed = parseHello(hello);
    expect(parsed).toEqual({ app: "term", consumed: 7 + app.length });
    expect(() => parseHello(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toThrow("magic");
  });

  test("beacon layout: magic, version, port, app, name", () => {
    const beacon = encodeBeacon("term", "Mac", 8622);
    const view = new DataView(beacon.buffer);
    expect(view.getUint32(0, true)).toBe(0x42444b50);
    expect(beacon[4]).toBe(WIRE_VERSION);
    expect(view.getUint16(6, true)).toBe(8622);
    expect(beacon[8]).toBe(4);
    expect(new TextDecoder().decode(beacon.subarray(9, 13))).toBe("term");
    expect(beacon[13]).toBe(3);
  });

  test("FrameParser reassembles split and coalesced frames", () => {
    const a = encodeCtrl('{"t":"hello"}');
    const b = encodeFrame(WIRE_MSG.ping, new Uint8Array([1, 2, 3, 4]));
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a);
    stream.set(b, a.length);
    const parser = new FrameParser();
    expect(parser.push(stream.subarray(0, 3))).toEqual([]);
    const frames = [...parser.push(stream.subarray(3, a.length + 5)), ...parser.push(stream.subarray(a.length + 5))];
    expect(frames.length).toBe(2);
    expect(frames[0].type).toBe(WIRE_MSG.ctrl);
    expect(new TextDecoder().decode(frames[0].payload)).toBe('{"t":"hello"}');
    expect(frames[1].type).toBe(WIRE_MSG.ping);
    expect([...frames[1].payload]).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------

function fakeCell(over: Partial<TerminalCell> = {}): TerminalCell {
  return { char: "x".codePointAt(0)!, flags: 0, width: 1, ...over };
}

describe("cell resolution (renderer-side attributes)", () => {
  test("a cell on the theme default reports -1, not a colour", () => {
    // The core resolves palette and bright-bold itself and only reports a
    // colour when the cell has one; absence means the device's theme.
    expect(resolveCell(fakeCell())).toEqual({ ch: "x", fg: -1, bg: -1, width: 1 });
  });

  test("resolved colours pass through untouched", () => {
    expect(resolveCell(fakeCell({ fgRgb: 0x81a2be, bgRgb: 0x123456 }))).toEqual({
      ch: "x",
      fg: 0x81a2be,
      bg: 0x123456,
      width: 1,
    });
  });

  test("reverse swaps, falling back through the theme", () => {
    const cell = fakeCell({ flags: CELL_FLAG.reverse });
    expect(resolveCell(cell)).toEqual({ ch: "x", fg: THEME_BG, bg: THEME_FG, width: 1 });
  });

  test("concealed text paints in its own background", () => {
    const cell = fakeCell({ flags: CELL_FLAG.invisible, bgRgb: 0x445566 });
    expect(resolveCell(cell).fg).toBe(0x445566);
  });

  test("a grapheme cluster survives as one cell", () => {
    expect(resolveCell(fakeCell({ char: 0x1f1e8, chars: "🇨🇳", width: 2 })).ch).toBe("🇨🇳");
  });

  test("the other Unicode spaces resolve to a plain blank", () => {
    // A terminal UI pads with U+00A0 (Claude Code's input box is full of
    // them). A space glyph has no outline, so routing one through the font
    // chain rejects every face and lands on a placeholder — which is how a
    // row of padding turned into a row of "?".
    expect(resolveCell(fakeCell({ char: 0x20 })).ch).toBe(" ");
    expect(resolveCell(fakeCell({ char: 0x00a0 })).ch).toBe(" ");
    expect(resolveCell(fakeCell({ char: 0x3000, width: 2 })).ch).toBe(" ");
    expect(resolveCell(fakeCell({ char: "你".codePointAt(0)! })).ch).toBe("你");
  });

  test("carries the terminal's column width", () => {
    expect(resolveCell(fakeCell({ width: 2, char: "你".codePointAt(0)! })).width).toBe(2);
    expect(resolveCell(fakeCell({ width: 0 })).width).toBe(0);
  });

  test("a wide character's continuation cell carries no ink", () => {
    expect(resolveCell(fakeCell({ width: 0 })).ch).toBe("");
  });
});

describe("run building", () => {
  const cell = (ch: string, fg = -1, bg = -1): Cell => ({ ch, fg, bg });

  test("merges same-styled cells and interior blanks, drops the margins", () => {
    const cells = [
      cell(" "),
      cell("f", 1),
      cell("o", 1),
      cell(" "),
      cell("o", 1),
      cell(" "),
      cell(" "),
    ];
    expect(rowRuns(cells)).toEqual([[1, "fo o", 1, -1]]);
  });

  test("style changes split runs; background spaces stay runs", () => {
    const cells = [cell("a", 1), cell("b", 2), cell(" ", -1, 3)];
    expect(rowRuns(cells)).toEqual([
      [0, "a", 1, -1],
      [1, "b", 2, -1],
      [2, " ", -1, 3],
    ]);
  });

  test("an all-blank row is an empty update", () => {
    expect(rowRuns([cell(""), cell(" "), cell("")])).toEqual([]);
  });

  test("a wide character's continuation column is skipped, not spaced", () => {
    // 你好 occupies four columns: two glyph cells, each followed by the
    // terminal's zero-width continuation. Treating a continuation as a blank
    // would splice a space between the two characters and push the rest of
    // the row one column right.
    const wide = (ch: string): Cell => ({ ch, fg: -1, bg: -1, width: 2, slot: 20 });
    const cont = (): Cell => ({ ch: "", fg: -1, bg: -1, width: 0 });
    const runs = rowRuns([wide("你"), cont(), wide("好"), cont(), cell("!")]);
    expect(runs).toEqual([
      [0, "你好", -1, -1, 20, 4],
      [4, "!", -1, -1],
    ]);
  });

  test("dynamic and baked text never share a run", () => {
    const dyn = (ch: string): Cell => ({ ch, fg: -1, bg: -1, width: 2, slot: 20 });
    const runs = rowRuns([cell("a"), dyn("文"), { ch: "", fg: -1, bg: -1, width: 0 }, cell("b")]);
    expect(runs).toEqual([
      [0, "a", -1, -1],
      [1, "文", -1, -1, 20, 2],
      [3, "b", -1, -1],
    ]);
  });

  test("blanks are never folded into a dynamic run", () => {
    // The dynamic atlas holds only the codepoints the companion baked; a
    // space folded into such a run would be a glyph the device cannot draw.
    const dyn = (ch: string): Cell => ({ ch, fg: -1, bg: -1, width: 2, slot: 20 });
    const runs = rowRuns([dyn("文"), { ch: "", fg: -1, bg: -1, width: 0 }, cell(" "), dyn("字")]);
    expect(runs).toEqual([
      [0, "文", -1, -1, 20, 2],
      [3, "字", -1, -1, 20, 2],
    ]);
  });
});

describe("chunking", () => {
  test("keeps every emitted line under the svc poll buffer", () => {
    const updates: RowUpdate[] = Array.from({ length: 40 }, (_, y) => [
      y,
      [0, "x".repeat(120), 0x123456, 0x654321],
      [130, "y".repeat(120), 0xabcdef, -1],
    ]);
    const chunks = chunkRows(updates);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(updates);
    for (const chunk of chunks) {
      const line = JSON.stringify({ t: "grid", sid: 1, gen: 2, seq: 3, rows: chunk, cur: [0, 0, 1], sb: 0 });
      expect(line.length).toBeLessThan(LINE_BUDGET);
      expect(line.length).toBeLessThan(SVC_POLL_BUF);
    }
  });
});

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

describe("key encoding", () => {
  test("named keys", () => {
    expect(encodeKey("Enter", false, false, false)).toBe("\r");
    expect(encodeKey("Backspace", false, false, false)).toBe("\x7f");
    expect(encodeKey("PageUp", false, false, false)).toBe("\x1b[5~");
  });

  test("DECCKM flips the arrows", () => {
    expect(encodeKey("Up", false, false, false)).toBe("\x1b[A");
    expect(encodeKey("Up", false, false, true)).toBe("\x1bOA");
  });

  test("control characters", () => {
    expect(encodeKey("c", true, false, false)).toBe("\x03");
    expect(encodeKey("d", true, false, false)).toBe("\x04");
    expect(encodeKey(" ", true, false, false)).toBe("\x00");
  });

  test("alt prefixes ESC; ctrl-modified arrows use CSI 1;5", () => {
    expect(encodeKey("b", false, true, false)).toBe("\x1bb");
    expect(encodeKey("Right", true, false, false)).toBe("\x1b[1;5C");
  });

  test("unknown multi-char names encode to nothing", () => {
    expect(encodeKey("F13", false, false, false)).toBe("");
  });

  test("ctrl reaches named keys that are single bytes", () => {
    // The console sends Y as the named Space key, so a held Ctrl has to turn
    // it into NUL exactly as ctrl+space from a real keyboard would.
    expect(encodeKey("Space", true, false, false)).toBe("\x00");
    expect(encodeKey("Space", false, false, false)).toBe(" ");
  });

  test("function keys, shift-tab and combined navigation modifiers", () => {
    expect(encodeKey("F1", false, false, false)).toBe("\x1bOP");
    expect(encodeKey("F12", true, true, false, true)).toBe("\x1b[24;8~");
    expect(encodeKey("Tab", false, false, false, true)).toBe("\x1b[Z");
    expect(encodeKey("Home", true, false, true)).toBe("\x1b[1;5H");
    expect(encodeKey("Right", true, true, true)).toBe("\x1b[1;7C");
  });
});

// ---------------------------------------------------------------------------
// runtime glyphs
// ---------------------------------------------------------------------------

describe("runtime glyph atlas", () => {
  test("baked coverage is ASCII plus the app's box-drawing literal", () => {
    expect(isBakedCodepoint("A".codePointAt(0)!)).toBe(true);
    expect(isBakedCodepoint("│".codePointAt(0)!)).toBe(true);
    expect(isBakedCodepoint("你".codePointAt(0)!)).toBe(false);
  });

  test("a font collection yields a standalone sfnt", () => {
    // Every CJK face macOS ships is a .ttc and opentype.js rejects the
    // signature outright, so the companion lifts one member out itself.
    const tables = [
      { tag: 0x676c7966, data: new Uint8Array([1, 2, 3]) }, // 'glyf'
      { tag: 0x6c6f6361, data: new Uint8Array([4, 5]) }, // 'loca'
    ];
    // Build a one-face collection by hand.
    const faceDirectory = 12 + tables.length * 16;
    const header = 12 + 4;
    const body: number[] = [];
    const bytes = new Uint8Array(header + faceDirectory + 16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x74746366); // 'ttcf'
    view.setUint32(4, 0x00010000);
    view.setUint32(8, 1);
    view.setUint32(12, header);
    view.setUint32(header, 0x00010000); // sfntVersion
    view.setUint16(header + 4, tables.length);
    let at = header + faceDirectory;
    for (let i = 0; i < tables.length; i += 1) {
      const entry = header + 12 + i * 16;
      view.setUint32(entry, tables[i].tag);
      view.setUint32(entry + 4, 0);
      view.setUint32(entry + 8, at);
      view.setUint32(entry + 12, tables[i].data.length);
      bytes.set(tables[i].data, at);
      at += (tables[i].data.length + 3) & ~3;
      body.push(at);
    }

    const out = extractFromCollection(bytes);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(outView.getUint32(0)).toBe(0x00010000);
    expect(outView.getUint16(4)).toBe(2);
    for (let i = 0; i < tables.length; i += 1) {
      const entry = 12 + i * 16;
      expect(outView.getUint32(entry)).toBe(tables[i].tag);
      const offset = outView.getUint32(entry + 8);
      const length = outView.getUint32(entry + 12);
      expect([...out.subarray(offset, offset + length)]).toEqual([...tables[i].data]);
    }
  });

  test("every glyph the app declares baked is one the mono face really has", () => {
    // TERM_GLYPHS is two things at once: the literal the compiler collects
    // into the app's atlases, and the companion's idea of what the device
    // can already draw. A codepoint the mono face does not map is dropped at
    // bake time and then never routed to the fallback chain either — it just
    // becomes tofu. Whatever goes in that literal has to exist in the face.
    const mono = opentype.parse(
      readFileSync(new URL("../vendor/pocketjs/assets/fonts/JetBrainsMono-Regular.ttf", import.meta.url))
        .buffer as ArrayBuffer,
    );
    const missing = [...TERM_GLYPHS].filter((ch) => mono.charToGlyphIndex(ch) === 0);
    expect(missing).toEqual([]);
  });

  test("the fallback chain spreads a terminal's glyphs across faces", () => {
    // No single face covers a terminal: a CJK face has neither ⏺ nor ⎿, and
    // ⏺ has outlines only in a math face — which is the whole reason there is
    // a chain rather than one font. This asserts the routing actually lands
    // on different faces, not merely that it answers.
    const atlas = new DynamicAtlasSet();
    const slots = [..."你⎿⏺"].map((ch) => atlas.slotFor(ch.codePointAt(0)!));
    for (const slot of slots) {
      expect(DYNAMIC_SLOTS).toContain(slot as (typeof DYNAMIC_SLOTS)[number]);
    }
    expect(new Set(slots).size).toBeGreaterThan(1);
    // Baked codepoints never route: ASCII, and the box-drawing set the app
    // spells out as a literal (which is why ❯ is the device's own glyph).
    expect(atlas.slotFor("A".codePointAt(0)!)).toBe(-1);
    expect(atlas.slotFor("❯".codePointAt(0)!)).toBe(-1);
    // A face is chosen once and stays chosen.
    expect(atlas.slotFor("你".codePointAt(0)!)).toBe(slots[0]);
  });

  test("advances are rewritten to whole cells", () => {
    // A terminal owns its grid: the font's natural advance would drift a run
    // of CJK off the columns the companion placed it on.
    const glyphs = [
      { cp: 0x41, columns: 1 },
      { cp: 0x4f60, columns: 2 },
    ];
    const blob = new Uint8Array(FONT_HEADER_SIZE + glyphs.length * FONT_CMAP_ENTRY_SIZE);
    const view = new DataView(blob.buffer);
    view.setUint16(6, glyphs.length, true);
    glyphs.forEach((glyph, i) => {
      const at = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
      view.setUint32(at, glyph.cp, true);
      view.setUint16(at + 4, i, true);
      view.setUint8(at + 6, 99); // whatever the face said
    });

    forceAdvances(blob, new Map(glyphs.map((g) => [g.cp, g.columns])), 7);

    expect(view.getUint8(FONT_HEADER_SIZE + 6)).toBe(7);
    expect(view.getUint8(FONT_HEADER_SIZE + FONT_CMAP_ENTRY_SIZE + 6)).toBe(14);
  });
});
