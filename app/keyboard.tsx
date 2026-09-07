// app/keyboard.tsx — the bottom-screen touch keyboard. The framework
// Osk renders through Portal, which sizes itself from the PRIMARY viewport,
// so a touch keyboard on the 3DS bottom screen is laid out by hand instead:
// a fixed grid of 26 px rows on a 32 px column unit (10 units = the 320 px
// panel), hit by one auxiliary-surface gesture on the keyboard root.
//
// Row 0 is the terminal action strip (Esc/Tab/Ctrl/Alt/paging/settings); rows
// 1..4 are the character layers. Shift and Ctrl are one-shot: they arm, the
// next key consumes them — the classic touch-phone convention, and the only
// one that works with a single resistive contact.

import { createMemo, createSignal, For } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { KeyName } from "../shared/protocol.ts";

export const KEY_H = 26;
export const KB_ROWS = 5;
export const KB_H = KEY_H * KB_ROWS;
/** 10 column units of 32 px = the 320 px auxiliary panel. */
const UNIT = 32;

export type KeyAction =
  | { ch: string; ctrl?: boolean }
  | { key: KeyName }
  | { layer: LayerName }
  | { mod: "shift" | "ctrl" | "alt" }
  | { settings: true };

export type LayerName = "lower" | "upper" | "sym" | "sym2" | "fn";

interface KeyDef {
  label: string;
  w: number;
  act: KeyAction;
  /** Painted darker, like the classic keyboard's function keys. */
  dark?: boolean;
}

const k = (label: string, w = 1): KeyDef => ({ label, w, act: { ch: label } });
const key = (label: string, name: KeyName, w = 1): KeyDef => ({
  label,
  w,
  act: { key: name },
  dark: true,
});
const layer = (label: string, target: LayerName, w = 1): KeyDef => ({
  label,
  w,
  act: { layer: target },
  dark: true,
});

/** The action strip is layer-independent. ^C rides the key path with the
 *  ctrl flag so the daemon encodes the control byte. */
const ACTION_ROW: KeyDef[] = [
  key("esc", "Escape", 1.25), key("tab", "Tab", 1.25),
  { label: "ctl", w: 1.25, act: { mod: "ctrl" }, dark: true },
  { label: "alt", w: 1.25, act: { mod: "alt" }, dark: true },
  key("pgu", "PageUp", 1.25), key("pgd", "PageDown", 1.25),
  { label: "settings", w: 2.5, act: { settings: true }, dark: true },
];

function charRow(chars: string): KeyDef[] {
  return [...chars].map((ch) => k(ch));
}

const LAYERS: Record<LayerName, KeyDef[][]> = {
  fn: [
    [key("F1", "F1", 2), key("F2", "F2", 2), key("F3", "F3", 2), key("F4", "F4", 2), key("F5", "F5", 2)],
    [key("F6", "F6", 2), key("F7", "F7", 2), key("F8", "F8", 2), key("F9", "F9", 2), key("F10", "F10", 2)],
    [key("F11", "F11", 2), key("F12", "F12", 2), key("ins", "Insert", 2), key("del", "Delete", 2), key("home", "Home", 2)],
    [layer("abc", "lower", 2), layer("?123", "sym", 2), key("end", "End", 2), key("tab", "Tab", 2), key("enter", "Enter", 2)],
  ],
  lower: [
    charRow("qwertyuiop"),
    charRow("asdfghjkl'"),
    [{ label: "⇧", w: 1.5, act: { mod: "shift" }, dark: true }, ...charRow("zxcvbnm"), key("⌫", "Backspace", 1.5)],
    [layer("?123", "sym", 1.5), k("-"), { label: "space", w: 4, act: { ch: " " } }, k("/"), k("."), key("⏎", "Enter", 1.5)],
  ],
  upper: [
    charRow("QWERTYUIOP"),
    charRow("ASDFGHJKL\""),
    [{ label: "⬆", w: 1.5, act: { mod: "shift" }, dark: true }, ...charRow("ZXCVBNM"), key("⌫", "Backspace", 1.5)],
    [layer("?123", "sym", 1.5), k("_"), { label: "space", w: 4, act: { ch: " " } }, k("?"), k("!"), key("⏎", "Enter", 1.5)],
  ],
  sym: [
    charRow("1234567890"),
    charRow("!@#$%^&*()"),
    [layer("#{~", "sym2", 1.5), ...charRow("-_=+[];"), key("⌫", "Backspace", 1.5)],
    [layer("abc", "lower", 1.5), k(":"), { label: "space", w: 4, act: { ch: " " } }, k(","), k("."), key("⏎", "Enter", 1.5)],
  ],
  sym2: [
    charRow("~`|\\{}<>\"'"),
    [layer("F1+", "fn", 2), ...charRow("*+-=%$#@")],
    [layer("?123", "sym", 1.5), ...charRow("&^!.,;"), k(":"), key("⌫", "Backspace", 1.5)],
    [layer("abc", "lower", 1.5), k("("), { label: "space", w: 4, act: { ch: " " } }, k(")"), k("."), key("⏎", "Enter", 1.5)],
  ],
};

interface KeyHit {
  row: number;
  index: number;
  def: KeyDef;
}

function rowsFor(name: LayerName): KeyDef[][] {
  return [ACTION_ROW, ...LAYERS[name]];
}

/** Key under a point in keyboard-local coordinates, or null in a gap. */
export function keyAt(layerName: LayerName, x: number, y: number): KeyHit | null {
  const row = Math.floor(y / KEY_H);
  const rows = rowsFor(layerName);
  if (row < 0 || row >= rows.length) return null;
  let at = 0;
  for (let index = 0; index < rows[row].length; index += 1) {
    const def = rows[row][index];
    const width = def.w * UNIT;
    if (x >= at && x < at + width) return { row, index, def };
    at += width;
  }
  return null;
}

export interface KeyboardProps {
  top: number;
  onSettings: () => void;
  onChar: (ch: string) => void;
  /** `name` is a KeyName, or a single character when ctrl is held. */
  onKey: (name: string, ctrl: boolean, alt: boolean, shift: boolean) => void;
  /** One-shot Ctrl arms here; the next character key consumes it. */
  ctrlArmed: () => boolean;
  setCtrlArmed: (on: boolean) => void;
}

export function Keyboard(props: KeyboardProps) {
  const [layerName, setLayerName] = createSignal<LayerName>("lower");
  const [altArmed, setAltArmed] = createSignal(false);
  const [pressed, setPressed] = createSignal<string | null>(null);
  let rootNode: NodeMirror | undefined;
  let releaseTimer = 0;

  const press = (hit: KeyHit) => {
    setPressed(`${hit.row}:${hit.index}`);
    releaseTimer = 4;
    const act = hit.def.act;
    if ("settings" in act) { props.onSettings();
    } else if ("ch" in act) {
      if (act.ctrl || props.ctrlArmed() || altArmed()) {
        props.onKey(act.ch, !!act.ctrl || props.ctrlArmed(), altArmed(), false);
        setAltArmed(false);
        props.setCtrlArmed(false);
      } else {
        props.onChar(act.ch);
      }
      if (layerName() === "upper") setLayerName("lower"); // one-shot shift
    } else if ("key" in act) {
      props.onKey(act.key, props.ctrlArmed(), altArmed(), layerName() === "upper");
      setAltArmed(false);
      if (layerName() === "upper") setLayerName("lower");
      props.setCtrlArmed(false);
    } else if ("layer" in act) {
      setLayerName(act.layer);
    } else if ("mod" in act) {
      if (act.mod === "shift") setLayerName(layerName() === "upper" ? "lower" : "upper");
      else if (act.mod === "alt") setAltArmed(!altArmed());
      else props.setCtrlArmed(!props.ctrlArmed());
    }
  };

  createGesture({
    surface: "auxiliary",
    region: { node: () => rootNode },
    onDown: (contact) => {
      const hit = keyAt(layerName(), contact.x, contact.y - props.top);
      if (hit) press(hit);
    },
    onUp: () => {},
  });

  // The pressed flash decays on a frame budget.
  onFrame(() => {
    if (releaseTimer > 0 && --releaseTimer === 0) setPressed(null);
  });

  return (
    <View
      ref={(node) => (rootNode = node)}
      // The plate the keys are set into, lit from the same direction they
      // are: a hairline along the top edge and a shallow fall to the bottom.
      class="absolute left-0 right-0 bg-gradient-to-b from-[#2a323e] via-[#161c26] to-[#10151d]"
      style={{ insetT: props.top, height: KB_H, gradViaPos: 0.06 }}
      debugName="TermKeyboard"
    >
      {/* The rows have no container of their own: every key is placed
          absolutely in the plate, so a row is an offset rather than a node.
          Mount depth is what the JS stack is spent on (hosts/3ds/src/qjs.c
          POCKETJS_JS_STACK_SIZE), and a wrapper that only holds a y offset is
          the kind of level worth not spending it on. */}
      <For each={[0, 1, 2, 3, 4]}>
        {(row) => (
          <KeyboardRow
            row={row}
            layer={layerName()}
            pressed={pressed()}
            ctrlArmed={props.ctrlArmed()}
            altArmed={altArmed()}
          />
        )}
      </For>
    </View>
  );
}

/** How far the cap travels into its socket, and the lip it leaves showing. */
const KEY_LIP = 2;

/**
 * The cap's face: a vertical three-stop gradient standing in for a lit,
 * slightly domed surface. Resting, the top stop is the specular edge, the
 * middle is the body and the bottom is where the cap turns away from the
 * light. Pressed, the whole face darkens — a cap sunk into its socket is in
 * shadow — and the stops run the other way, leaving the only light along the
 * bottom edge. Darkening alone reads as "disabled" and flipping alone reads as
 * "highlighted"; together they read as pushed in.
 */
function capClass(down: boolean, dark: boolean, armed: boolean): string {
  // Every branch is a whole literal. The compiler collects class strings from
  // the source at build time and the device looks them up in a baked table, so
  // a string assembled at runtime — a template, a join — is one the table has
  // never seen, and the node ends up with no style at all.
  if (armed) {
    return "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#8cc2ff] via-[#4c9bf5] to-[#2f6fbe]";
  }
  if (down) {
    return dark
      ? "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#0d1118] via-[#141922] to-[#28303b]"
      : "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#151a22] via-[#1d242e] to-[#343d4a]";
  }
  return dark
    ? "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#4b5768] via-[#2a323d] to-[#1c222b]"
    : "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#5f6c7f] via-[#3a4351] to-[#2a323e]";
}

function KeyboardRow(props: {
  row: number;
  layer: LayerName;
  pressed: string | null;
  ctrlArmed: boolean;
  altArmed: boolean;
}) {
  const defs = () => rowsFor(props.layer)[props.row];
  return (
    <For each={defs()}>
      {(def, index) => {
        const left = () =>
          defs()
            .slice(0, index())
            .reduce((x, d) => x + d.w * UNIT, 0);
        const isPressed = createMemo(() => props.pressed === `${props.row}:${index()}`);
        const isArmedCtrl = () => "mod" in def.act && (def.act.mod === "ctrl" && props.ctrlArmed || def.act.mod === "alt" && props.altArmed);
        const down = createMemo(() => isPressed() || isArmedCtrl());
        return (
          // The socket: a dark recess the cap sits in. Unpressed, the cap
          // covers all but the bottom lip, and that sliver of shadow is what
          // makes the key look like it stands above the plate.
          <View
            class="absolute rounded-[4] bg-[#080b11]"
            style={{
              insetL: left() + 2,
              width: def.w * UNIT - 4,
              height: KEY_H - 4,
              insetT: props.row * KEY_H + 2,
            }}
          >
            <View
              class={capClass(down(), def.dark === true, isArmedCtrl())}
              // Pressing moves the cap down into the socket, so the lip of
              // shadow appears above it instead of below. The middle stop sits
              // near whichever edge the light is on, which keeps the specular
              // band thin instead of letting it wash over half the face.
              style={{
                insetT: down() ? KEY_LIP : 0,
                height: KEY_H - 4 - KEY_LIP,
                gradViaPos: down() ? 0.82 : 0.18,
              }}
            >
              <Text class={down() ? "text-xs text-[#c3d0e2]" : "text-xs text-[#dfe6f2]"}>
                {def.label}
              </Text>
            </View>
          </View>
        );
      }}
    </For>
  );
}

/** All key labels, spelled once as literals for the atlas scan. */
export const KEYBOARD_GLYPHS =
  "qwertyuiopasdfghjkl'zxcvbnm-/.QWERTYUIOPASDFGHJKL\"ZXCVBNM_?!1234567890@#$%^&*()=+[];~`|\\{}<>,:esctabctl^Cpgupgdspaceabc⇧⬆⌫⏎←↑→↓";
