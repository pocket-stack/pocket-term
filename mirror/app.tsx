// mirror/app.tsx — the read-only window the term companion opens
// on the desktop beside each session.
//
// It is the console's top screen and nothing else: the same grid component,
// the same store, the same protocol, drawn by PocketJS through the gpui
// backend instead of the PICA200. That is the whole point of the split in
// app/grid.tsx — a mirror is not a second implementation of the
// terminal, it is the same one on another machine, which is also why it
// follows the console to Linux (`hosts/desktop` is the stock host of both
// `macos-app` and `linux-app`).
//
// It types, like any replica. The keyboard arrives as svc lines from the
// host this window runs on (see HostInputLine) and the store relays them to
// the companion, which owns the PTY — so the console and the window are
// typing into the same shell and see the same echo. What `role: "mirror"`
// still forbids is changing what this window is: it cannot resize the PTY,
// nor re-point itself at another session.

import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps } from "@pocketjs/framework";
import { TermGrid } from "../app/grid.tsx";
import { connectSvc } from "../app/svc.ts";
import { createTermStore } from "../app/store.ts";

/** Matched to the console app: the same viewport, font slot and cell box, so the
 *  mirror's grid is column-for-column what the console shows. */
const MONO_SLOT = 16;
const STATUS_H = 14;
const CELL_H = 13;

export default function TermMirror() {
  const ops = getOps();
  const advance = ops.measureText("M", MONO_SLOT);
  const CELL_W = advance > 0 ? Math.max(6, Math.round(advance)) : 7;
  const TRACK = advance > 0 ? CELL_W - advance : 0;
  const COLS = Math.floor(400 / CELL_W);
  const ROWS = Math.floor((240 - STATUS_H) / CELL_H);

  const store = createTermStore(
    { cols: COLS, rows: ROWS, cell: [CELL_W, CELL_H], role: "mirror" },
    connectSvc(),
  );
  onFrame(() => store.frame());

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
