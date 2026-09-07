import { getOps } from "@pocketjs/framework/host";
import { TERM_FONTS } from "./font.generated.ts";
export type TerminalFontName = keyof typeof TERM_FONTS;
export const FONT_NAMES: TerminalFontName[] = ["spleentt", "spleen", "fusion"];
export const FONT_LABELS = { spleentt: "Spleentt", spleen: "Spleen", fusion: "Fusion Pixel" };
export function loadTerminalFont(name: TerminalFontName = "spleentt") {
  const TERM_FONT = TERM_FONTS[name];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(Math.floor(TERM_FONT.replace(/=+$/, "").length * 3 / 4));
  let bits = 0, count = 0, at = 0;
  for (let i = 0; i < TERM_FONT.length; i++) {
    const value = alphabet.indexOf(TERM_FONT[i]);
    if (value < 0) break;
    bits = (bits << 6) | value; count += 6;
    if (count >= 8) { count -= 8; bytes[at++] = (bits >>> count) & 255; }
  }
  getOps().loadFontAtlas?.(bytes);
}
