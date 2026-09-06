// host/glyphs.ts — runtime glyph coverage for the device.
//
// The console's atlases are baked at build time from the app's own string
// literals, so a session that prints 你好 — or the ⏺ and ⎿ a coding agent
// draws its transcript with — has nothing to draw. This is the problem the
// note widget solves in its `cjk.rs` (docs/WIDGET.md): rasterize the unseen
// codepoints from a system font, put them in a FONT ATLAS, and reload the
// slot through the spec `loadFontAtlas` op. The difference here is that the
// rasterizer lives on the companion, because the console has neither a font
// file nor a rasterizer.
//
// It takes a CHAIN of faces, not one. No single font on a Mac covers what a
// terminal shows: JetBrains Mono has ❯ and the box drawing but no CJK, a CJK
// face has neither ⏺ nor ⎿, and ⏺ turns out to live in a math font. Each
// face gets its own atlas in its own spare slot (0..18 are the app's baked
// sizes, MAX_FONT_SLOTS is 24), and a codepoint goes to the first face that
// has it — the same fallback a desktop text stack would do, done explicitly
// because the wire has to say which slot each run selects.
//
// Two things are rewritten after baking, both in the cmap (spec.ts FONT
// ATLAS v3):
//
//   * advance := columns * cellW — a terminal owns its grid, and a font's
//     natural advance would drift a run off the cell boundaries.
//   * the px size is searched down until a cell fits BOTH one terminal row
//     and the narrowest column span in the atlas. A proportional face's ⏺ is
//     as wide as it is tall; dropped into a one-column cell at row height it
//     would paint over its neighbour.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Default import: opentype.js exposes its ESM build only through the
// bundler-only `module` field (see framework/compiler/bake-font.ts).
import opentype, { type Font } from "opentype.js";
import { bakeSlot } from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE, FONT_MAGIC, FONT_VERSION } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { DYNAMIC_SLOTS, TERM_GLYPHS } from "../shared/protocol.ts";
import { bitmapCell, parseBdf, type BitmapFont } from "../shared/bitmap-font.ts";

const ROOT = fileURLToPath(new URL("../vendor/pocketjs/", import.meta.url));

/**
 * The fallback chain, best face first. Each entry takes one atlas slot, so
 * the list is capped by DYNAMIC_SLOTS; entries that are missing on this
 * machine are skipped and the rest shift up.
 *
 * The order is a coverage argument, not a preference:
 *   1. the terminal's own face, so a symbol it has looks like the text
 *      around it (❯ ✓ ✗ and the arrows);
 *   2. a real CJK face, which is what a Chinese session actually needs;
 *   3. Apple Symbols for the box-adjacent technical glyphs (⎿);
 *   4. a math face, the only place ⏺ and ⏵ have outlines rather than a
 *      colour bitmap;
 *   5. a broad pan-Unicode face as the last stop before a placeholder.
 */
const FONT_CHAIN: readonly { label: string; paths: readonly string[] }[] = [
  { label: "mono", paths: [join(ROOT, "assets/fonts/JetBrainsMono-Regular.ttf")] },
  {
    label: "cjk",
    paths: [
      process.env.POCKET_TERM_CJK_FONT ?? "",
      "/System/Library/Fonts/Hiragino Sans GB.ttc",
      "/System/Library/Fonts/STHeiti Light.ttc",
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    ],
  },
  { label: "symbols", paths: ["/System/Library/Fonts/Apple Symbols.ttf"] },
  { label: "math", paths: ["/System/Library/Fonts/Supplemental/STIXTwoMath.otf"] },
  {
    label: "unicode",
    paths: [
      "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ],
  },
];

/** Codepoints the device can already draw from its baked mono atlas: ASCII
 *  plus the box-drawing set the app spells out as a literal. A codepoint
 *  that is in fact baked but sent dynamically still renders — it just comes
 *  from another face — so this set may be conservative, never wrong. */
const BAKED = new Set<number>();
for (let cp = 0x20; cp <= 0x7e; cp += 1) BAKED.add(cp);
for (const ch of TERM_GLYPHS) BAKED.add(ch.codePointAt(0)!);

export function isBakedCodepoint(cp: number): boolean {
  return BAKED.has(cp);
}

// ---------------------------------------------------------------------------
// TrueType Collections
// ---------------------------------------------------------------------------

/** Every CJK face macOS ships is a .ttc, and opentype.js rejects the `ttcf`
 *  signature outright. Lifting one member out is a table copy: the collection
 *  header points at sfnt headers whose table records carry file-absolute
 *  offsets, so a standalone font is those tables rewritten against a fresh
 *  record table. */
export function extractFromCollection(bytes: Uint8Array, index = 0): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x74746366) return bytes; // not 'ttcf'
  const count = view.getUint32(8);
  if (index >= count) throw new Error(`font collection has ${count} faces, wanted #${index}`);
  const sfnt = view.getUint32(12 + index * 4);

  const numTables = view.getUint16(sfnt + 4);
  const records: { tag: number; checksum: number; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const at = sfnt + 12 + i * 16;
    records.push({
      tag: view.getUint32(at),
      checksum: view.getUint32(at + 4),
      offset: view.getUint32(at + 8),
      length: view.getUint32(at + 12),
    });
  }

  const directory = 12 + numTables * 16;
  let total = directory;
  for (const record of records) total += (record.length + 3) & ~3;
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, view.getUint32(sfnt)); // sfntVersion
  outView.setUint16(4, numTables);
  outView.setUint16(6, view.getUint16(sfnt + 6));
  outView.setUint16(8, view.getUint16(sfnt + 8));
  outView.setUint16(10, view.getUint16(sfnt + 10));

  let at = directory;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const entry = 12 + i * 16;
    outView.setUint32(entry, record.tag);
    outView.setUint32(entry + 4, record.checksum);
    outView.setUint32(entry + 8, at);
    outView.setUint32(entry + 12, record.length);
    out.set(bytes.subarray(record.offset, record.offset + record.length), at);
    at += (record.length + 3) & ~3;
  }
  return out;
}

function loadFont(paths: readonly string[]): { font: Font; path: string } | null {
  for (const path of paths) {
    if (path === "") continue;
    try {
      const raw = new Uint8Array(readFileSync(path));
      const sfnt = extractFromCollection(raw);
      const buffer = sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength);
      return { font: opentype.parse(buffer as ArrayBuffer), path };
    } catch {
      // Missing or unparseable: try the next candidate for this rung.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// one face's atlas
// ---------------------------------------------------------------------------

/** Glyphs kept per face. This bounds the bake, the transfer, and device
 *  memory — the PICA200 expands atlas coverage to RGBA8, so the glyph grid's
 *  power-of-two envelope costs 4 bytes per sample. */
const MAX_GLYPHS = 1024;
/** Nothing below this is legible; a too-small glyph still beats one that
 *  paints over the column beside it. */
const MIN_PX = 4;

export interface BakedDynamicAtlas {
  slot: number;
  gen: number;
  bytes: Uint8Array;
  glyphCount: number;
  px: number;
}

class FaceAtlas {
  readonly slot: number;
  readonly label: string;
  readonly font: Font | BitmapFont;
  readonly path: string;
  /** codepoint -> cell columns, in last-seen order (the eviction order). */
  #wanted = new Map<number, number>();
  #dirty = false;
  #gen = 0;
  #baked: BakedDynamicAtlas | null = null;

  constructor(slot: number, label: string, font: Font | BitmapFont, path: string) {
    this.slot = slot;
    this.label = label;
    this.font = font;
    this.path = path;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get current(): BakedDynamicAtlas | null {
    return this.#baked;
  }

  covers(cp: number, columns: number): boolean {
    if ("ascent" in this.font) { const glyph = this.font.glyphs.get(cp); return !!glyph && glyph.advance <= columns * 5 && glyph.pixels.some(p => p !== 0); }
    const text = String.fromCodePoint(cp);
    return this.font.charToGlyphIndex(text) !== 0 && this.font.charToGlyph(text).getPath(0, 0, 16).commands.length > 0;
  }

  want(cp: number, columns: number): void {
    const known = this.#wanted.get(cp);
    this.#wanted.delete(cp);
    this.#wanted.set(cp, columns);
    if (known !== columns) this.#dirty = true;
  }

  bake(cellW: number, cellH: number): BakedDynamicAtlas | null {
    if (this.#wanted.size === 0) return null;
    while (this.#wanted.size > MAX_GLYPHS) {
      const oldest = this.#wanted.keys().next();
      if (oldest.done) break;
      this.#wanted.delete(oldest.value);
    }
    const chars = [...this.#wanted.keys()].sort((a, b) => a - b);
    if ("ascent" in this.font) {
      const bytes = bakeBitmapAtlas(this.font, this.slot, this.#wanted, cellW, cellH);
      this.#dirty = false;
      return this.#baked = { slot: this.slot, gen: ++this.#gen, bytes, glyphCount: chars.length + 1, px: 10 };
    }
    // The cell has to fit the narrowest span in this atlas: one atlas has one
    // cell size, and a two-column glyph's box would clip a one-column one's
    // neighbour.
    let narrowest = 2;
    for (const columns of this.#wanted.values()) narrowest = Math.min(narrowest, columns);
    const maxW = narrowest * cellW;

    let atlas = bakeSlot(this.font, this.slot, cellH, false, chars, 1);
    for (let px = cellH - 1; (atlas.cellH > cellH || atlas.cellW > maxW) && px >= MIN_PX; px -= 1) {
      atlas = bakeSlot(this.font, this.slot, px, false, chars, 1);
    }

    const bytes = atlas.bytes.slice();
    forceAdvances(bytes, this.#wanted, cellW);
    this.#gen += 1;
    this.#dirty = false;
    this.#baked = {
      slot: this.slot,
      gen: this.#gen,
      bytes,
      glyphCount: atlas.glyphCount,
      px: atlas.px,
    };
    return this.#baked;
  }
}

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------

export class DynamicAtlasSet {
  #faces: FaceAtlas[] | null = null;
  /** Resolved routing, so a repeat codepoint costs a map read. */
  #route = new Map<string, number>();

  #ensure(): FaceAtlas[] {
    if (this.#faces !== null) return this.#faces;
    const path = fileURLToPath(new URL("../assets/fonts/fusion-pixel/fusion-pixel-10px-monospaced-zh_hans.bdf", import.meta.url));
    const faces: FaceAtlas[] = [new FaceAtlas(DYNAMIC_SLOTS[0], "fusion-pixel", parseBdf(readFileSync(path, "utf8")), path)];
    for (const rung of FONT_CHAIN) {
      if (faces.length >= DYNAMIC_SLOTS.length) break;
      const found = loadFont(rung.paths);
      if (found === null) continue;
      faces.push(new FaceAtlas(DYNAMIC_SLOTS[faces.length], rung.label, found.font, found.path));
    }
    this.#faces = faces;
    return faces;
  }

  /** The faces that loaded, for the startup log. */
  describe(): string {
    return this.#ensure()
      .map((face) => `${face.label}@${face.slot}=${face.path.split("/").pop()}`)
      .join(" ");
  }

  /** The slot that can draw this codepoint, or -1 for nobody. Unbaked and
   *  uncovered means the caller must keep the grid honest itself. */
  slotFor(cp: number, columns = 2): number {
    if (isBakedCodepoint(cp)) return -1;
    const key = `${cp}/${columns}`, known = this.#route.get(key);
    if (known !== undefined) return known;
    for (const face of this.#ensure()) {
      // A cmap hit with no outline (a colour-bitmap emoji face) would bake a
      // blank cell, which reads as a dropped character rather than a missing
      // one.
      if (!face.covers(cp, columns)) continue;
      this.#route.set(key, face.slot);
      return face.slot;
    }
    this.#route.set(key, -1);
    return -1;
  }

  /** Record a codepoint the device needs at the column width the terminal
   *  gives it. `slot` comes from slotFor(). */
  want(cp: number, columns: number, slot: number): void {
    for (const face of this.#ensure()) {
      if (face.slot === slot) {
        face.want(cp, columns);
        return;
      }
    }
  }

  get dirty(): boolean {
    return this.#ensure().some((face) => face.dirty);
  }

  /** Re-bake every face whose charset moved. */
  bake(cellW: number, cellH: number): BakedDynamicAtlas[] {
    const out: BakedDynamicAtlas[] = [];
    for (const face of this.#ensure()) {
      if (!face.dirty) continue;
      const baked = face.bake(cellW, cellH);
      if (baked) out.push(baked);
    }
    return out;
  }

  /** Every atlas that currently has content, for delivery to a new replica. */
  current(): BakedDynamicAtlas[] {
    const out: BakedDynamicAtlas[] = [];
    for (const face of this.#ensure()) {
      if (face.current) out.push(face.current);
    }
    return out;
  }
}

export function bakeBitmapAtlas(font: BitmapFont, slot: number, wanted: ReadonlyMap<number, number>, cellW: number, cellH: number): Uint8Array {
  const chars = [...new Set([...wanted.keys(), 0xfffd])].sort((a, b) => a - b);
  const width = cellW * 2, size = width * cellH, start = 16 + chars.length * 8;
  const bytes = new Uint8Array(start + chars.length * size), view = new DataView(bytes.buffer);
  view.setUint32(0, FONT_MAGIC, true); view.setUint16(4, FONT_VERSION, true); view.setUint16(6, chars.length, true);
  bytes.set([width, cellH, 9, cellH, slot, 0, 1, 0], 8);
  let next = 1;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i], gid = cp === 0xfffd ? 0 : next++, at = 16 + i * 8;
    view.setUint32(at, cp, true); view.setUint16(at + 4, gid, true); bytes[at + 6] = (wanted.get(cp) ?? 1) * cellW;
    const pixels = bitmapCell(font, cp, width, cellH);
    if (cp !== 0xfffd && pixels) bytes.set(pixels, start + gid * size);
  }
  for (let y = 1; y < cellH - 1; y++) for (let x = 0; x < cellW - 1; x++) if (x === 0 || x === cellW - 2 || y === 1 || y === cellH - 2) bytes[start + y * width + x] = 255;
  return bytes;
}

/** Rewrite every cmap entry's advance to `columns * cellW` (spec.ts FONT
 *  ATLAS v3 cmap: u32 codepoint, u16 gid, u8 advance, u8 xoff). */
export function forceAdvances(
  blob: Uint8Array,
  columnsFor: ReadonlyMap<number, number>,
  cellW: number,
): void {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const glyphCount = view.getUint16(6, true);
  for (let i = 0; i < glyphCount; i += 1) {
    const at = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    if (at + FONT_CMAP_ENTRY_SIZE > blob.length) break;
    const cp = view.getUint32(at, true);
    const columns = columnsFor.get(cp) ?? 1;
    view.setUint8(at + 6, Math.min(255, columns * cellW));
  }
}
