import type { ClientLine, Cursor, Run } from "../shared/protocol.ts";

export interface TypingPreview { cursor: Cursor; text?: { x: number; y: number; value: string } }
interface Picture { cursor: Cursor; rows: Map<number, string> }
interface Guess { id: number; kind: string; at: number; picture: Picture; ch?: { x: number; y: number; value: string } }
const sameCursor = (a: Cursor | null, b: Cursor) => !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** A display-only hypothesis. It never edits the authoritative grid or
 * history, never invents an input command, and requires two observed echoes
 * before showing that kind of action. Unknown input resets that confidence. */
export function createTypingPrediction(readRow: (y: number) => Run[], readCursor: () => Cursor | null,
  publish: (preview: TypingPreview | undefined) => void, cols = 80, rows = 24) {
  const confidence = new Map<string, number>();
  let enabled = true, base: Picture | undefined, guesses: Guess[] = [], confirmedAt = 0;
  const rowText = (y: number) => {
    const cells = Array<string>(cols).fill(" ");
    for (const run of readRow(y)) {
      if (run[4] !== undefined || (run[5] ?? run[1].length) !== run[1].length || /[^\x20-\x7e]/.test(run[1])) return;
      for (let x = 0; x < run[1].length && run[0] + x < cols; x++) cells[run[0] + x] = run[1][x];
    }
    return cells.join("");
  };
  const matches = (picture: Picture) => sameCursor(readCursor(), picture.cursor) && [...picture.rows].every(([y, text]) => rowText(y) === text);
  const reset = () => { base = undefined; guesses = []; confidence.clear(); publish(undefined); };
  const show = (now: number) => {
    if (!enabled || !guesses.length || now - confirmedAt > 2000 || guesses.some(g => (confidence.get(g.kind) ?? 0) < 2)) { publish(undefined); return; }
    const chars = guesses.filter(g => g.ch).map(g => g.ch!);
    publish({ cursor: guesses.at(-1)!.picture.cursor, ...(chars.length ? { text: { x: chars[0].x, y: chars[0].y, value: chars.map(c => c.value).join("") } } : {}) });
  };
  return {
    reset,
    enabled(on: boolean) { enabled = on; reset(); },
    input(line: ClientLine, id: number, now: number) {
      if (!enabled || !id || guesses.length >= 16) { reset(); return; }
      const cursor = guesses.at(-1)?.picture.cursor ?? readCursor();
      if (!cursor || !cursor[2]) { reset(); return; }
      const [x, y] = cursor;
      const previous = guesses.at(-1)?.picture ?? { cursor, rows: new Map<number, string>() };
      const picture: Picture = { cursor: [...cursor], rows: new Map(previous.rows) };
      const read = (row: number) => { const text = picture.rows.get(row) ?? rowText(row); if (text !== undefined) picture.rows.set(row, text); return text; };
      const text = read(y); if (text === undefined) { reset(); return; }
      let kind: string, ch: Guess["ch"];
      if (line.t === "ch" && /^[\x20-\x7e]$/.test(line.s) && x < cols - 1 && text.slice(x).trim() === "") {
        kind = "text"; ch = { x, y, value: line.s };
        picture.rows.set(y, text.slice(0, x) + line.s + text.slice(x + 1)); picture.cursor = [x + 1, y, 1];
      } else if (line.t === "key" && !line.ctrl && !line.alt && !line.shift && ["Left", "Right", "Up", "Down"].includes(line.k)) {
        kind = line.k;
        const nx = x + (kind === "Right" ? 1 : kind === "Left" ? -1 : 0), ny = y + (kind === "Down" ? 1 : kind === "Up" ? -1 : 0);
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) { reset(); return; }
        const target = read(ny);
        if (target === undefined || kind !== "Left" && target[nx] === " " && (ny !== y || text[x] === " ")) { reset(); return; }
        picture.cursor = [nx, ny, 1];
      } else { reset(); return; }
      if (guesses.length && guesses.at(-1)!.kind !== kind) { reset(); return; }
      if (!base) base = { cursor: [...cursor], rows: new Map(picture.rows) };
      // The base contains pre-input cells, including any target row inspected.
      for (const row of picture.rows.keys()) if (!base.rows.has(row) || !guesses.length) {
        const before = rowText(row); if (before !== undefined) base.rows.set(row, before);
      }
      guesses.push({ id, kind, at: now, picture, ch }); show(now);
    },
    authoritative(ack: number | undefined, now: number) {
      if (!guesses.length) return;
      if (ack === undefined) { reset(); return; }
      let match = -1;
      for (let i = 0; i < guesses.length; i++) if (guesses[i].id <= ack && matches(guesses[i].picture)) match = i;
      if (match >= 0) {
        for (let i = 0; i <= match; i++) confidence.set(guesses[i].kind, Math.min(2, (confidence.get(guesses[i].kind) ?? 0) + 1));
        confirmedAt = now; base = guesses[match].picture; guesses.splice(0, match + 1);
        if (!guesses.length) base = undefined;
        show(now);
      } else if (base && !matches(base)) reset();
      // An accepted write is not proof that the PTY application has echoed
      // it. An unchanged base waits briefly; it never confirms a hypothesis.
    },
    frame(now: number) { if (guesses.length && now - guesses[0].at > 350) reset(); },
  };
}
