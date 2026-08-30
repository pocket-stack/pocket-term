// app/app.tsx — a remote terminal multiplexer for the 3ds-dev host.
//
// The Mac companion (host/serve.ts) owns the PTYs and an authoritative
// terminal state machine per session; this app is a passive replica in the
// zhongduan sense: attach delivers a full cell-grid snapshot, then ordered
// row diffs. The two screens split the terminal the way the contacts demo
// split the phone app: the top screen is the grid (grid.tsx, shared with the
// desktop mirror window) and the touch screen holds the session tabs and the
// keyboard.
//
// Physical controls: D-pad = arrow keys (with repeat), A = Enter,
// B = Backspace, X = Tab, Y = Space, START = Ctrl-C, SELECT = new session,
// circle pad = scrollback.
//
// ZL is Ctrl: hold it and every key that follows carries the control
// modifier, with the on-screen keyboard lighting its Ctrl cap so the state is
// visible where the operator is already looking. ZL is New-3DS-only and
// reaches the guest through ir:rst rather than the ordinary HID pad
// (hosts/3ds/src/input.c); a console without it uses the keyboard's own Ctrl
// cap, which arms for one key.
//
// L and R step between sessions, and that is all they do. They briefly
// doubled as the modifier, which meant discriminating a tap from a hold —
// and a shoulder that only switches when released is a shoulder that feels
// broken. One button, one job.

import { createSignal, For, Show } from "solid-js";
import { AuxiliarySurface, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework";
import { TermGrid } from "./grid.tsx";
import { KB_H, Keyboard } from "./keyboard.tsx";
import { connectSvc } from "./svc.ts";
import { createTermStore } from "./store.ts";

/* Grid geometry. The 12 px mono atlas is slot 16 (spec MONO_FONT_PX);
 * `font-mono text-xs` in grid.tsx is what makes the build bake it. The
 * natural advance (~7.2 px) is snapped down to a 7 px integer cell with
 * negative tracking so every column lands on a pixel. */
const MONO_SLOT = 16;
const STATUS_H = 14;
const CELL_H = 13;

const TAB_H = 26;
const TAB_W = 72;
/** The trailing "open a session" cell. Narrow, so it reads as sitting beside
 *  the last tab rather than as an empty tab of its own. */
const TAB_NEW_W = 30;
const KB_TOP = 240 - KB_H;

/* Closing a session is a hold, then a slide, then a release — not a tap on a
 * small ×. The panel is resistive and single-contact: an 18 px target inside
 * a 72 px tab was a coin flip, and getting it wrong killed a shell. Holding a
 * tab slides a full-width bar out from under the strip; releasing on the bar
 * closes, releasing anywhere else does not. Nothing about it needs precision
 * in x, and the arming is deliberate. */
const CLOSE_BAR_H = 44;
const CLOSE_HOLD_SECONDS = 0.35;
/** Frames the bar takes to slide in or out. */
const CLOSE_ANIM_FRAMES = 6;

const DPAD_KEYS: readonly [number, "Up" | "Down" | "Left" | "Right"][] = [
  [BTN.UP, "Up"],
  [BTN.DOWN, "Down"],
  [BTN.LEFT, "Left"],
  [BTN.RIGHT, "Right"],
];
const DPAD_DELAY = 18;
const DPAD_REPEAT = 4;

export default function TermApp() {
  const ops = getOps();
  const advance = ops.measureText("M", MONO_SLOT);
  const CELL_W = advance > 0 ? Math.max(6, Math.round(advance)) : 7;
  const TRACK = advance > 0 ? CELL_W - advance : 0;
  const COLS = Math.floor(400 / CELL_W);
  const ROWS = Math.floor((240 - STATUS_H) / CELL_H);

  const svc = connectSvc();
  const store = createTermStore({ cols: COLS, rows: ROWS, cell: [CELL_W, CELL_H] }, svc);
  /** The touch keyboard's one-shot Ctrl: armed by its cap, spent by the next
   *  key. Holding L is the other way in, and the cap lights for both. */
  const [ctrlArmed, setCtrlArmed] = createSignal(false);
  const [ctrlHeld, setCtrlHeld] = createSignal(false);
  const ctrlActive = () => ctrlArmed() || ctrlHeld();

  const dpadHeld = new Map<number, number>();
  let scrollCarry = 0;

  let prevButtons = 0;

  onFrame((buttons) => {
    store.frame();

    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    setCtrlHeld((buttons & BTN.ZL) !== 0);

    let sentThisFrame = false;
    const send = (key: string, ctrl: boolean) => {
      store.sendKey(key, ctrl);
      sentThisFrame = true;
    };

    // The d-pad repeats; everything else fires on its press edge. All of it
    // is level-tested here rather than through onButtonPress so a key can
    // read the modifier held on the same frame.
    for (const [mask, keyName] of DPAD_KEYS) {
      if (buttons & mask) {
        const held = (dpadHeld.get(mask) ?? 0) + 1;
        dpadHeld.set(mask, held);
        if (held === 1 || (held > DPAD_DELAY && (held - DPAD_DELAY) % DPAD_REPEAT === 0)) {
          send(keyName, ctrlActive());
        }
      } else {
        dpadHeld.set(mask, 0);
      }
    }
    for (const [mask, key] of FACE_KEYS) {
      if (pressed & mask) send(key, ctrlActive());
    }
    if (pressed & BTN.START) send("c", true);
    if (pressed & BTN.SELECT) store.newSession();

    if (sentThisFrame && ctrlArmed()) setCtrlArmed(false);

    if (pressed & BTN.LTRIGGER) store.attachSibling(-1);
    if (pressed & BTN.RTRIGGER) store.attachSibling(1);

    // Circle pad Y scrubs scrollback: up = into history (positive delta).
    const pad = analogY();
    if (Math.abs(pad) > 0.25) {
      scrollCarry += -pad * 0.5;
      const lines = Math.trunc(scrollCarry);
      if (lines !== 0) {
        scrollCarry -= lines;
        store.scroll(lines);
      }
    } else {
      scrollCarry = 0;
    }
  });

  // Session tab strip on the touch screen: tap a tab to attach, hold one to
  // arm closing it, the trailing + to open one.
  let tabsNode: NodeMirror | undefined;
  /** The session the close bar is armed for, and how far the bar has slid. */
  const [closingSid, setClosingSid] = createSignal(-1);
  const [closeAnim, setCloseAnim] = createSignal(0);
  const [overClose, setOverClose] = createSignal(false);
  const inCloseBar = (y: number) => y >= TAB_H && y < TAB_H + CLOSE_BAR_H;
  const sessionAt = (x: number) => {
    const list = store.sessions();
    const index = Math.floor(x / TAB_W);
    return index >= 0 && index < list.length ? list[index] : undefined;
  };

  onFrame(() => {
    // The bar slides both ways, so a cancelled hold retracts rather than
    // vanishing.
    const target = closingSid() >= 0 ? 1 : 0;
    const current = closeAnim();
    if (current === target) return;
    const step = 1 / CLOSE_ANIM_FRAMES;
    setCloseAnim(target > current ? Math.min(1, current + step) : Math.max(0, current - step));
  });

  createGesture({
    surface: "auxiliary",
    region: { node: () => tabsNode },
    longPressSeconds: CLOSE_HOLD_SECONDS,
    onLongPress: (contact) => {
      const session = sessionAt(contact.x);
      if (session) setClosingSid(session.sid);
    },
    onPanMove: (contact) => {
      if (closingSid() >= 0) setOverClose(inCloseBar(contact.y));
    },
    onUp: (contact) => {
      const armed = closingSid();
      if (armed >= 0) {
        if (inCloseBar(contact.y)) store.kill(armed);
        setClosingSid(-1);
        setOverClose(false);
        return;
      }
      // A plain tap: the tabs, then the trailing cell that opens one.
      const list = store.sessions();
      const session = sessionAt(contact.x);
      if (session) {
        store.attach(session.sid);
        return;
      }
      const trailing = list.length * TAB_W;
      if (contact.x >= trailing && contact.x < trailing + TAB_NEW_W) store.newSession();
    },
    onCancel: () => {
      setClosingSid(-1);
      setOverClose(false);
    },
  });

  const closingTitle = () =>
    store.sessions().find((s) => s.sid === closingSid())?.title ?? "";

  return (
    <>
      <TermGrid
        store={store}
        metrics={{ cols: COLS, rows: ROWS, cellW: CELL_W, cellH: CELL_H, track: TRACK, statusH: STATUS_H }}
        badge={`${COLS}×${ROWS}`}
        hint="on the Mac: node host/serve.ts"
        emptyHint="SELECT opens one · or tap + on the touch screen"
        title="POCKET TERM"
      />

      {/* Touch screen: tabs, status, keyboard. */}
      <AuxiliarySurface>
        <View debugName="TermAux" class="relative w-full h-full bg-[#0d1117] overflow-hidden">
          <View
            debugName="TermTabs"
            ref={(node) => (tabsNode = node)}
            class="absolute left-0 right-0 top-0 flex-row bg-[#141a24]"
            style={{ height: TAB_H }}
          >
            <For each={store.sessions()}>
              {(session) => (
                <View
                  class={
                    session.sid === store.activeSid()
                      ? "relative h-full items-center justify-center overflow-hidden bg-[#31394a]"
                      : "relative h-full items-center justify-center overflow-hidden"
                  }
                  style={{ width: TAB_W }}
                >
                  <Text
                    class={
                      session.sid === store.activeSid()
                        ? "text-xs text-[#dfe6f2]"
                        : "text-xs text-[#5d708c]"
                    }
                  >
                    {session.title}
                  </Text>
                  <Show when={session.sid === store.activeSid()}>
                    <View class="absolute left-0 right-0 bottom-0 h-[2] bg-[#4c9bf5]" />
                  </Show>
                  {/* The tab being held reads as the source of the bar. */}
                  <Show when={session.sid === closingSid()}>
                    <View class="absolute left-0 right-0 top-0 bottom-0 bg-[#7a2c2c66]" />
                  </Show>
                </View>
              )}
            </For>
            <View class="h-full items-center justify-center" style={{ width: TAB_NEW_W }}>
              <Text class="text-sm text-[#5d708c]">+</Text>
            </View>
          </View>

          {/* Slides out from under the strip while a tab is held. */}
          <Show when={closeAnim() > 0}>
            <View
              debugName="TabCloseBar"
              class={
                overClose()
                  ? "absolute left-0 right-0 flex-row items-center justify-center gap-[6] bg-[#a33a3a]"
                  : "absolute left-0 right-0 flex-row items-center justify-center gap-[6] bg-[#5c2626]"
              }
              style={{
                insetT: TAB_H,
                height: CLOSE_BAR_H,
                translateY: -(1 - closeAnim()) * CLOSE_BAR_H,
                opacity: closeAnim(),
              }}
            >
              <Text class="text-sm text-[#ffdede] font-bold">×</Text>
              <Text class="text-xs text-[#ffdede]">
                {overClose() ? "release to close" : "slide here to close"}
              </Text>
              <Text class="text-xs text-[#e0a0a0]">{closingTitle()}</Text>
            </View>
          </Show>

          <View
            class="absolute left-0 right-0 flex-row items-center px-[8] gap-[10]"
            style={{ insetT: TAB_H, height: KB_TOP - TAB_H }}
          >
            <View class="flex-col gap-[2]">
              <Text class={store.conn() === "live" ? "text-xs text-[#61c16d]" : "text-xs text-[#c95c5c]"}>
                {store.conn() === "live" ? "connected" : store.conn()}
              </Text>
              <Text class="text-xs text-[#5d708c]">{store.hostName() || "—"}</Text>
            </View>
            <View class="grow" />
            <View class="flex-col gap-[2] items-end">
              <Text class="text-xs text-[#3d4c63]">SELECT new · L/R switch · hold ZL = ctrl</Text>
              <Text class="text-xs text-[#3d4c63]">
                {store.dynamicGlyphs() > 0
                  ? `pad scrolls · ${store.dynamicGlyphs()} runtime glyphs`
                  : "pad scrolls history · A ⏎ · B ⌫"}
              </Text>
            </View>
          </View>

          <Keyboard
            top={KB_TOP}
            onChar={(ch) => {
              store.sendText(ch);
              setCtrlArmed(false);
            }}
            onKey={(name, ctrl) => store.sendKey(name, ctrl || ctrlHeld())}
            ctrlArmed={ctrlActive}
            setCtrlArmed={setCtrlArmed}
          />
        </View>
      </AuxiliarySurface>
    </>
  );
}

/** Face buttons that send a key, level-tested so a held Ctrl applies. */
const FACE_KEYS: readonly [number, string][] = [
  [BTN.CIRCLE, "Enter"],
  [BTN.CROSS, "Backspace"],
  [BTN.TRIANGLE, "Tab"],
  [BTN.SQUARE, "Space"],
];
