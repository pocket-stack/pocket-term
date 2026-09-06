// Desktop replica bound to one session. It shares the 80x24 grid, accepts
// window input through svc and never resizes or switches the underlying PTY.

import { onFrame } from "@pocketjs/framework/lifecycle";
import { onCleanup } from "solid-js";
import { loadTerminalFont } from "../app/font.ts";
import { TERM_LAYOUT } from "../shared/layout.ts";
import { TermGrid } from "../app/grid.tsx";
import { connectSvc } from "../app/svc.ts";
import { createTermStore } from "../app/store.ts";

export default function TermMirror() {
  loadTerminalFont();
  const { cols: COLS, rows: ROWS, cellW: CELL_W, cellH: CELL_H, track: TRACK, statusH: STATUS_H } = TERM_LAYOUT;

  const store = createTermStore(
    { cols: COLS, rows: ROWS, cell: [CELL_W, CELL_H], role: "mirror" },
    connectSvc(),
  );
  onFrame(() => store.frame());
  onCleanup(() => store.dispose());

  return (
    <TermGrid
      store={store}
      metrics={{ cols: COLS, rows: ROWS, cellW: CELL_W, cellH: CELL_H, track: TRACK, statusH: STATUS_H }}
      badge={`${COLS}×${ROWS}`}
      hint="this window is opened by the term companion"
      emptyHint="its session has ended"
      title="MIRROR"
    />
  );
}
