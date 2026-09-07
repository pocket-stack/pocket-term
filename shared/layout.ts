/** The entire 400 x 240 primary display is the standard 80 x 24 grid.
 * Connection status and session controls belong on the touch display. */
export const TERM_LAYOUT = { cols: 80, rows: 24, cellW: 5, cellH: 10, track: 0, statusH: 0 } as const;
export const TERM_FONT_SLOT = 16;
export const TABS_PER_PAGE = 4;
export function tabPage(index: number) { return Math.floor(Math.max(0, index) / TABS_PER_PAGE); }
