import { getOps } from "@pocketjs/framework/host";
import { TERM_FONT } from "./font.generated.ts";
export function loadTerminalFont() {
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
