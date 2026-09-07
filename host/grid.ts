// libghostty cells to bounded row runs; terminal colors and widths remain
// authoritative. The renderer applies the resolved colors and cell geometry.

import { LINE_BUDGET, THEME_BG, THEME_FG, type Run, type RowUpdate } from "../shared/protocol.ts";

/** The slice of libghostty's CellData this module reads (@wterm/core). The
 *  core resolves colour itself — palette lookup, bright-bold, the configured
 *  theme — and reports the result as 24-bit `fgRgb`/`bgRgb`, present only
 *  when the cell is not on the default. Everything left here is the part a
 *  renderer owns. */
export interface TerminalCell {
  char: number;
  chars?: string;
  flags: number;
  width?: number;
  fgRgb?: number;
  bgRgb?: number;
}

/** SGR attribute bits, as libghostty reports them through wterm. */
export const CELL_FLAG = {
  bold: 0x01,
  dim: 0x02,
  italic: 0x04,
  underline: 0x08,
  blink: 0x10,
  reverse: 0x20,
  invisible: 0x40,
  strikethrough: 0x80,
} as const;

/** One resolved cell: concrete 0xRRGGBB colors (or -1 = theme default).
 *
 *  `width` is the terminal's own column count for the character — 2 for the
 *  full-width forms, and 0 for the continuation cell that follows one. A
 *  continuation carries no ink and must not be treated as a blank column
 *  either: the wide glyph before it already covers that column, and inserting
 *  a space there would push the rest of the row off the grid.
 *
 *  `slot` names the runtime atlas that can draw a character the device has
 *  no baked glyph for (see host/glyphs.ts); undefined means the baked mono
 *  face. Runs never mix slots — a run is one <Text> with one font. */
export interface Cell {
  ch: string;
  fg: number;
  bg: number;
  width?: 0 | 1 | 2;
  slot?: number;
}

/** Unicode's other spaces. A terminal UI pads with them — Claude Code's
 *  input box is full of U+00A0 — and they must be treated as blanks, not as
 *  characters to find a font for: a space glyph has no outline, so the
 *  fallback chain would reject every face and fall through to a placeholder.
 *  A row of "?" where the padding belongs is exactly what that looked like. */
const SPACE_LIKE = new Set<number>([
  0x00a0, // no-break space
  0x1680, // ogham space mark
  0x202f, // narrow no-break space
  0x205f, // medium mathematical space
  0x3000, // ideographic space (two columns)
  0xfeff, // zero-width no-break space
]);
for (let cp = 0x2000; cp <= 0x200a; cp += 1) SPACE_LIKE.add(cp); // en/em quad..hair

export function isSpaceLike(cp: number): boolean {
  return cp === 0x20 || SPACE_LIKE.has(cp);
}

function halve(rgb: number): number {
  return (((rgb >> 16) & 0xff) >> 1 << 16) | ((((rgb >> 8) & 0xff) >> 1) << 8) | ((rgb & 0xff) >> 1);
}

/**
 * One core cell to one wire cell.
 *
 * Colour is the core's answer, not this file's: `fgRgb`/`bgRgb` arrive
 * already resolved through libghostty's palette and its bright-bold rule,
 * and their absence means "the theme's default", which the device draws.
 * What is left here are the three attributes that are a renderer's decision
 * rather than a colour lookup — faint, reverse and concealed — resolved on
 * the authority side so every replica paints the same thing.
 */
export function resolveCell(cell: TerminalCell): Cell {
  const width = (cell.width ?? 1) as 0 | 1 | 2;
  const raw = width === 0 ? "" : (cell.chars ?? String.fromCodePoint(cell.char || 32)).normalize("NFC");
  // Normalize the other spaces to the ordinary one here, so everything
  // downstream — run merging, glyph routing — sees a blank.
  const first = raw.codePointAt(0);
  const ch = raw.length > 0 && first !== undefined && isSpaceLike(first) ? " " : raw;

  let fg = cell.fgRgb ?? -1;
  let bg = cell.bgRgb ?? -1;
  if (cell.flags & CELL_FLAG.dim) fg = halve(fg < 0 ? THEME_FG : fg);
  if (cell.flags & CELL_FLAG.reverse) {
    const front = fg < 0 ? THEME_FG : fg;
    const back = bg < 0 ? THEME_BG : bg;
    fg = back;
    bg = front;
  }
  if (cell.flags & CELL_FLAG.invisible) fg = bg < 0 ? THEME_BG : bg;
  return { ch, fg, bg, width };
}

/** Merge a row of resolved cells into runs. Blank cells (spaces or wide-char
 *  continuations on the default background) become gaps; blanks inside a
 *  same-styled stretch are kept so `foo bar` stays one run. */
export function rowRuns(cells: readonly Cell[]): Run[] {
  const runs: Run[] = [];
  let run:
    | { col: number; text: string; fg: number; bg: number; slot?: number; span: number; columns: number }
    | null = null;
  let pendingBlanks = 0;
  const close = () => {
    if (run !== null) {
      const base: Run = [run.col, run.text, run.fg, run.bg];
      if (run.slot !== undefined) base[4] = run.slot;
      // The span is only worth sending when a glyph is wider than a column.
      if (run.span !== run.text.length) base[5] = run.span;
      runs.push(base);
    }
    run = null;
    pendingBlanks = 0;
  };
  for (let col = 0; col < cells.length; col += 1) {
    const cell = cells[col];
    // The trailing half of a wide character: already covered, never a gap.
    if (cell.width === 0) continue;
    const columns = cell.width === 2 ? 2 : 1;
    const blank = (cell.ch === " " || cell.ch === "") && cell.bg < 0;
    if (blank) {
      // A blank is worth its columns: the ideographic space is two wide, and
      // counting it as one would pull the rest of the row a column left.
      if (run !== null) pendingBlanks += columns;
      continue;
    }
    const ch = cell.ch === "" ? " " : cell.ch;
    // Blanks are only ever folded into a baked run: a runtime atlas holds
    // exactly the codepoints the companion was asked to bake, and a space is
    // not one of them — folding one in would leave a hole mid-run.
    if (
      run !== null &&
      run.fg === cell.fg &&
      run.bg === cell.bg &&
      run.slot === cell.slot &&
      (cell.slot === undefined || run.columns === columns) &&
      (pendingBlanks === 0 || (cell.slot === undefined && pendingBlanks <= 4))
    ) {
      run.text += " ".repeat(pendingBlanks) + ch;
      run.span += pendingBlanks + columns;
      pendingBlanks = 0;
      continue;
    }
    close();
    run = { col, text: ch, fg: cell.fg, bg: cell.bg, slot: cell.slot, span: columns, columns };
  }
  close();
  return runs;
}

/** Stable cache key for a serialized row. */
export function rowKey(runs: Run[]): string {
  return JSON.stringify(runs);
}

/** Greedy-pack row updates so each emitted line stays under the svc poll
 *  budget (the JSON wrapper around `rows` is what the margin absorbs). */
export function chunkRows(updates: RowUpdate[], budget = LINE_BUDGET): RowUpdate[][] {
  const chunks: RowUpdate[][] = [];
  let chunk: RowUpdate[] = [];
  let size = 0;
  for (const update of updates) {
    const updateSize = JSON.stringify(update).length + 1;
    if (chunk.length > 0 && size + updateSize > budget - 200) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(update);
    size += updateSize;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.length === 0 ? [[]] : chunks;
}
