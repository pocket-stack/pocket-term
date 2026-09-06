// host/keys.ts — semantic input encoding, on the authority side
// The guest sends key names; encoding runs beside the PTY terminal modes.

const NAMED: Record<string, { normal: string; app?: string }> = {
  Enter: { normal: "\r" },
  Backspace: { normal: "\x7f" },
  Tab: { normal: "\t" },
  Escape: { normal: "\x1b" },
  Space: { normal: " " },
  Up: { normal: "\x1b[A", app: "\x1bOA" },
  Down: { normal: "\x1b[B", app: "\x1bOB" },
  Right: { normal: "\x1b[C", app: "\x1bOC" },
  Left: { normal: "\x1b[D", app: "\x1bOD" },
  Home: { normal: "\x1b[H", app: "\x1bOH" },
  End: { normal: "\x1b[F", app: "\x1bOF" },
  PageUp: { normal: "\x1b[5~" },
  PageDown: { normal: "\x1b[6~" },
  Delete: { normal: "\x1b[3~" },
};

/** ^A..^Z plus ^@ ^[ ^\ ^] ^^ ^_ — mask a character into the C0 range. */
function controlByte(ch: string): string {
  const code = ch === " " ? 64 : ch.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : ch;
}

/** A named key, or a single character carrying ctrl/alt, to PTY bytes.
 *  `appCursor` = DECCKM (vim and friends flip the arrow encoding). */
export function encodeKey(k: string, ctrl: boolean, alt: boolean, appCursor: boolean, shift = false): string {
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const finals: Record<string, string> = { Up: "A", Down: "B", Right: "C", Left: "D", Home: "H", End: "F" };
  if (finals[k]) return modifier > 1 ? `\x1b[1;${modifier}${finals[k]}` : `${appCursor ? "\x1bO" : "\x1b["}${finals[k]}`;
  const tilde: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
  if (tilde[k]) return `\x1b[${tilde[k]}${modifier > 1 ? `;${modifier}` : ""}~`;
  const fn: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };
  if (fn[k]) return modifier > 1 ? `\x1b[1;${modifier}${fn[k]}` : `\x1bO${fn[k]}`;
  if (k === "Tab" && shift) return "\x1b[Z";
  const bytes = NAMED[k]?.normal ?? ([...k].length === 1 ? k : "");
  if (!bytes) return "";
  return (alt ? "\x1b" : "") + (ctrl ? controlByte(bytes) : bytes);
}
