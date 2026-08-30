// host/keys.ts — semantic input encoding, on the authority side
// (the zhongduan discipline: the client sends key names, the host turns them
// into PTY bytes in the same actor order as everything else it writes).

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
export function encodeKey(k: string, ctrl: boolean, alt: boolean, appCursor: boolean): string {
  let bytes: string;
  const named = NAMED[k];
  if (named !== undefined) {
    bytes = appCursor && named.app ? named.app : named.normal;
    if (ctrl) {
      if (bytes.length === 1) {
        // Space, Enter and Tab already ARE C0 bytes or map onto one, which is
        // how ctrl-space reaches a shell as NUL.
        bytes = controlByte(bytes);
      } else if (bytes.startsWith("\x1b[") && bytes.length === 3) {
        // Modified CSI arrows: ESC [ 1 ; 5 <letter>.
        bytes = `\x1b[1;5${bytes[2]}`;
      }
    }
  } else if (k.length === 1) {
    bytes = ctrl ? controlByte(k) : k;
  } else {
    return "";
  }
  return alt ? `\x1b${bytes}` : bytes;
}
