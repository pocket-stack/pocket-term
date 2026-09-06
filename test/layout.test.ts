import { expect, test } from "bun:test";
import { TERM_FONT, TERM_FONTS } from "../app/font.generated.ts";
import { TERM_LAYOUT } from "../shared/layout.ts";
import { keyAt, type LayerName } from "../app/keyboard.tsx";
import { FONT_SOURCES, terminalFont, type TerminalFontName } from "../scripts/font.ts";
import { readFileSync } from "node:fs";
import { bitmapCell, parseBdf } from "../shared/bitmap-font.ts";
import { bakeBitmapAtlas } from "../host/glyphs.ts";

test("the shipped atlas and 80 x 24 grid reach all four screen edges", () => {
  const bytes = Buffer.from(TERM_FONT, "base64"), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes).toEqual(Buffer.from(terminalFont()));
  expect([bytes[8], bytes[9], bytes[11], bytes[12]]).toEqual([5, 10, 10, 16]);
  expect(TERM_LAYOUT.cols * bytes[8]).toBe(400); expect(TERM_LAYOUT.rows * bytes[9]).toBe(240);
  for (let i = 0; i < view.getUint16(6, true); i++) expect(bytes[16 + i * 8 + 6]).toBe(5);
});

test("all keyboard layers cover the touch panel, with reachable function and modifier keys", () => {
  for (const layer of ["lower", "upper", "sym", "sym2", "fn"] as LayerName[]) {
    for (let row = 0; row < 5; row++) for (let x = 0; x < 320; x += 16) expect(keyAt(layer, x + 1, row * 26 + 13)).not.toBeNull();
  }
  expect(keyAt("fn", 1, 39)!.def.act).toEqual({ key: "F1" });
  expect(keyAt("fn", 65, 91)!.def.act).toEqual({ key: "F12" });
  expect(keyAt("lower", 97, 13)!.def.act).toEqual({ mod: "alt" });
});

test("box and block ink reaches adjacent cells without font-metric gaps", () => {
  const bytes = terminalFont(), view = new DataView(bytes.buffer), n = view.getUint16(6, true);
  const glyph = (ch: string) => {
    for (let i = 0; i < n; i++) if (view.getUint32(16 + i * 8, true) === ch.codePointAt(0)) {
      const offset = 16 + n * 8 + view.getUint16(20 + i * 8, true) * 50; return bytes.slice(offset, offset + 50);
    }
    throw new Error(`Missing ${ch}`);
  };
  expect([...glyph("█")].every(a => a === 255)).toBe(true);
  expect([...glyph("─").slice(20, 25)]).toEqual([255, 255, 255, 255, 255]);
  expect(Array.from({ length: 10 }, (_, y) => glyph("│")[y * 5 + 2])).toEqual(Array(10).fill(255));
});

test("all three terminal faces preserve the source's ASCII bitmap and have no antialiasing samples", () => {
  for (const name of Object.keys(TERM_FONTS) as TerminalFontName[]) {
    const b = Buffer.from(TERM_FONTS[name], "base64"), v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint16(6, true);
    const source = parseBdf(readFileSync(new URL(`../assets/fonts/${FONT_SOURCES[name]}`, import.meta.url), "utf8"));
    expect(b).toEqual(Buffer.from(terminalFont(name)));
    expect([...b.subarray(16 + n * 8)].every(a => a === 0 || a === 255)).toBe(true);
    for (let i = 0; i < n; i++) {
      const cp = v.getUint32(16 + i * 8, true), gid = v.getUint16(20 + i * 8, true);
      if (cp >= 32 && cp <= 126) expect(b.subarray(16 + n * 8 + gid * 50, 16 + n * 8 + (gid + 1) * 50)).toEqual(Buffer.from(bitmapCell(source, cp)!));
    }
  }
});

test("Fusion Pixel CJK keeps its complete 10x10 cell next to a narrow dynamic glyph", () => {
  const source = parseBdf(readFileSync(new URL(`../assets/fonts/${FONT_SOURCES.fusion}`, import.meta.url), "utf8"));
  const b = bakeBitmapAtlas(source, 19, new Map([["你".codePointAt(0)!, 2], ["é".codePointAt(0)!, 1]]), 5, 10);
  const v = new DataView(b.buffer), n = v.getUint16(6, true);
  expect([b[8], b[9]]).toEqual([10, 10]);
  for (let i = 0; i < n; i++) {
    const cp = v.getUint32(16 + i * 8, true), gid = v.getUint16(20 + i * 8, true);
    if (cp === "你".codePointAt(0)) { expect(b[22 + i * 8]).toBe(10); expect([...b.slice(16 + n * 8 + gid * 100, 16 + n * 8 + (gid + 1) * 100)]).toEqual([...bitmapCell(source, cp, 10, 10)!]); }
  }
});
