// app/grid.tsx — the terminal surface itself, shared by every replica.
//
// The console app puts this on the top screen and keeps the tabs and the
// keyboard on the touch screen; the desktop mirror window is this and nothing
// else. Both draw the same cell grid from the same store, which is the point:
// one renderer, one set of metrics, whatever machine is showing it.
//
// A row is a list of runs, and a run is one <Text> placed at its column. Runs
// marked dynamic select the runtime-baked atlas (DYNAMIC_FONT_SLOT) whose
// advances the companion pinned to the grid, so mixed CJK and ASCII lines
// stay on their columns without the app measuring anything.

import { createMemo, For, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import * as hot from "@pocketjs/framework/hot";
import { slotRow } from "../shared/history.ts";
import { getOps } from "@pocketjs/framework/host";
import { THEME_CURSOR, THEME_FG, isDynamicSlot, runColumns, type Run } from "../shared/protocol.ts";
import { rgbToAbgr, type TermStore } from "./store.ts";

export interface GridMetrics {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Per-glyph advance correction for the baked mono atlas. */
  track: number;
  statusH: number;
}

export interface GridProps {
  store: TermStore;
  metrics: GridMetrics;
  /** Small right-aligned status text: the grid size, or "read-only". */
  badge: string;
  /** What the connect overlay tells the operator to do. */
  hint: string;
  /** What to say once the companion is there and no session is. */
  emptyHint: string;
  title: string;
}

/** Nothing attached, and the companion is present to say so — the state
 *  after closing the last session, as opposed to still looking for a
 *  companion. */
function isEmpty(store: TermStore): boolean {
  return store.conn() === "link" && store.sessions().length === 0;
}

function connectionLabel(store: TermStore): string {
  if (isEmpty(store)) return "no sessions open";
  switch (store.conn()) {
    case "no-svc":
      return "this host has no companion channel";
    case "search":
      return "waiting for the paired Mac…";
    case "link":
      return "companion linked — waiting for a session…";
    case "live":
      return "";
  }
}

/** 12 px bold — slot 7, per the pinned table in framework/compiler/tailwind.ts
 *  (FONT_PX index 0 is 12 px; bold slots start at 7). It is what the status
 *  bar's title is drawn in, so it is what the title has to be measured in. */
const STATUS_BOLD_SLOT = 7;
const STATUS_PAD = 6;
const STATUS_GAP = 8;
/** Room the right-hand side keeps for the scrollback marker, the grid size
 *  and the connection dot. */
const STATUS_RIGHT = 74;

export function TermGrid(props: GridProps) {
  const m = props.metrics;
  const store = props.store;
  // The title is a prop — "POCKET TERM" on the console, "MIRROR" in a desktop
  // window — so where the host name starts is measured, not assumed. A
  // guessed column was how the title came to sit on top of the host name.
  const hostLeft = STATUS_PAD + Math.ceil(getOps().measureText(props.title, STATUS_BOLD_SLOT)) + STATUS_GAP;
  const cursorLeft = () => (store.cursor()?.[0] ?? 0) * m.cellW;
  const cursorTop = () => m.statusH + (store.cursor()?.[1] ?? 0) * m.cellH;
  const cursorOn = () => store.cursor()?.[2] === 1 && store.conn() === "live" && store.scrollback() === 0;
  const first = () => store.history?.first() ?? 0;
  // Rebase before large absolute row ids lose pixel precision in native floats.
  const origin = createMemo(() => Math.floor(first() / 512) * 512);
  let canvas: NodeMirror | undefined;
  onFrame(() => hot.prop(canvas, "translateY", store.history?.translation(origin()) ?? 0));

  const rowCanvas = <View ref={canvas} debugName="TerminalRows" class="absolute left-0 right-0 top-0" style={{ height: m.rows * m.cellH }}>
        {Array.from({ length: m.rows + 2 }, (_, slot) => {
          const row = createMemo(() => store.history ? slotRow(slot, first(), m.rows + 2) : slot);
          const runs = () => store.history ? store.history.row(row()) : slot < m.rows ? store.row(slot)() : [];
          return <View debugName="TerminalRow" class="absolute left-0 right-0" style={{ insetT: m.statusH + (row() - origin()) * m.cellH, height: m.cellH }}>
            <Show when={runs() !== undefined} fallback={<View debugName="HistorySkeleton" class="absolute left-[5] top-[3] h-[4]" style={{ width: 65 + row() % 7 * 35, bgColor: store.history?.rowError(row()) ? 0xff35416b : 0xff30251d }} />}>
          <For each={runs()}>
            {(run: Run) => (
              <>
                <Show when={run[3] >= 0}>
                  <View
                    class="absolute top-0"
                    style={{
                      insetL: run[0] * m.cellW,
                      width: runColumns(run) * m.cellW,
                      height: m.cellH,
                      bgColor: rgbToAbgr(run[3]),
                    }}
                  />
                </Show>
                <Text
                  class="absolute top-0 font-mono text-xs"
                  style={
                    isDynamicSlot(run[4])
                      ? {
                          // The companion baked this atlas's advances to the
                          // grid, so it needs no tracking correction.
                          insetL: run[0] * m.cellW,
                          lineHeight: m.cellH,
                          fontSlot: run[4],
                          textColor: rgbToAbgr(run[2] >= 0 ? run[2] : THEME_FG),
                        }
                      : {
                          insetL: run[0] * m.cellW,
                          lineHeight: m.cellH,
                          tracking: m.track,
                          textColor: rgbToAbgr(run[2] >= 0 ? run[2] : THEME_FG),
                        }
                  }
                >
                  {run[1]}
                </Text>
              </>
            )}
          </For>
            </Show>
          </View>;
        })}
      </View>;

  return (
    <View debugName="TermScreen" class="relative w-full h-full bg-[#10151c] overflow-hidden">
      <Show when={m.statusH > 0}><View
        debugName="TermStatus"
        class={
          store.bell()
            ? "absolute left-0 right-0 top-0 overflow-hidden bg-[#7a4a1d]"
            : "absolute left-0 right-0 top-0 overflow-hidden bg-[#1a2230]"
        }
        style={{ height: m.statusH }}
      >
        <Text class="absolute left-[6] top-0 text-xs text-[#9fb6d8] font-bold">{props.title}</Text>
        <Text
          class="absolute top-0 text-xs text-[#5d708c]"
          style={{ insetL: hostLeft, insetR: STATUS_RIGHT }}
        >
          {store.hostName()}
        </Text>
        <Show when={store.scrollback() > 0}>
          <Text class="absolute right-[62] top-0 text-xs text-[#e0b060]">{`↟${store.scrollback()}`}</Text>
        </Show>
        <Text class="absolute right-[18] top-0 text-xs text-[#5d708c]">{props.badge}</Text>
        <Text
          class={
            store.conn() === "live"
              ? "absolute right-[6] top-0 text-xs text-[#61c16d]"
              : "absolute right-[6] top-0 text-xs text-[#c95c5c]"
          }
        >
          ●
        </Text>
      </View></Show>

      <Show when={cursorOn()}>
        <View
          class="absolute"
          style={{
            insetL: cursorLeft(),
            insetT: cursorTop(),
            width: m.cellW,
            height: m.cellH,
            // Translucent block under the glyphs (rows paint after this).
            bgColor: ((0x66 << 24) | (rgbToAbgr(THEME_CURSOR) & 0xffffff)) >>> 0,
          }}
        />
      </Show>

      {rowCanvas}

      <Show when={store.conn() !== "live" && !store.history?.manifest()}>
        <View class="absolute left-0 right-0 top-0 bottom-0 flex-col items-center justify-center gap-[6] bg-[#10151cf0]">
          <Text class="text-lg text-[#9fb6d8] font-bold">pocket term</Text>
          <Text class="text-xs text-[#5d708c]">{connectionLabel(store)}</Text>
          <Text class="text-xs text-[#3d4c63]">{isEmpty(store) ? props.emptyHint : props.hint}</Text>
        </View>
      </Show>
    </View>
  );
}
