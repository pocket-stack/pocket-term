/** Compressed upstream sources, read only by build tools and the Mac host. */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseBdf } from "./bitmap-font.ts";

export const FONT_SOURCES = {
  spleen: "spleen/spleen-5x8.bdf.gz",
  spleentt: "spleentt/spleentt-5x8.bdf.gz",
  fusion: "fusion-pixel/fusion-pixel-10px-monospaced-zh_hans.bdf.gz",
} as const;
export type TerminalFontName = keyof typeof FONT_SOURCES;

export const bitmapFontSource = (face: TerminalFontName): URL => new URL(`../assets/fonts/${FONT_SOURCES[face]}`, import.meta.url);
export const loadBitmapFont = (face: TerminalFontName) => parseBdf(gunzipSync(readFileSync(bitmapFontSource(face))).toString("utf8"));
