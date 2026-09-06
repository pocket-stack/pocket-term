/** BDF decoding used by the build and the Mac rasterizer, never by the guest. */
export interface BitmapGlyph { advance: number; width: number; height: number; x: number; y: number; pixels: Uint8Array }
export interface BitmapFont { ascent: number; height: number; glyphs: Map<number, BitmapGlyph> }
export function parseBdf(text: string): BitmapFont {
  const lines = text.split(/\r?\n/), glyphs = new Map<number, BitmapGlyph>();
  let ascent = 0, height = 0, cp = -1, advance = 0, width = 0, h = 0, x = 0, y = 0;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at], [name, ...parts] = line.split(" ");
    if (name === "FONT_ASCENT") ascent = Number(parts[0]);
    else if (name === "PIXEL_SIZE") height = Number(parts[0]);
    else if (name === "ENCODING") cp = Number(parts[0]);
    else if (name === "DWIDTH") advance = Number(parts[0]);
    else if (name === "BBX") [width, h, x, y] = parts.map(Number);
    else if (name === "BITMAP") {
      if (width > 32 || h > 32 || advance > 32) { at += h; continue; }
      const pixels = new Uint8Array(width * h);
      for (let row = 0; row < h; row++) {
        const bits = parseInt(lines[++at], 16), padded = Math.ceil(width / 8) * 8;
        for (let col = 0; col < width; col++) pixels[row * width + col] = bits & (1 << (padded - col - 1)) ? 255 : 0;
      }
      if (cp >= 0) glyphs.set(cp, { advance, width, height: h, x, y, pixels });
    }
  }
  return { ascent, height, glyphs };
}

/** Preserve each source pixel at 1:1. The two spare rows of a 5x8 face
 * are padding inside the terminal's 5x10 cell, not a vertical stretch. */
export function bitmapCell(font: BitmapFont, cp: number, cellW = 5, cellH = 10): Uint8Array | undefined {
  const g = font.glyphs.get(cp);
  if (!g || g.advance > cellW) return;
  const pixels = new Uint8Array(cellW * cellH), top = Math.floor((cellH - font.height) / 2) + font.ascent - g.height - g.y;
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
    const dx = g.x + x, dy = top + y;
    if (dx >= 0 && dx < cellW && dy >= 0 && dy < cellH) pixels[dy * cellW + dx] = g.pixels[y * g.width + x];
  }
  return pixels;
}
