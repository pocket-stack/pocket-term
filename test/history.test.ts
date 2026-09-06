import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { runFrameHooks, resetFrameHooks } from "../vendor/pocketjs/framework/src/frame.ts";
import { createTermHistory, historyDemand, historyLoader, type HistoryIO, type TermHistory } from "../app/history.ts";
import { createCursorStick } from "../app/stick.ts";
import { HISTORY, decodeHistoryRow, slotRow, type HistoryManifest, type HistoryRequest } from "../shared/history.ts";
import { HistoryBoundary, SessionHistory } from "../host/history.ts";
import type { Run } from "../shared/protocol.ts";

test("history identities survive append and trimming, but fence clear/reset/alternate screens", () => {
  const h = new SessionHistory(); let count = 30, discarded = 10, alt = false;
  const core = { getScrollbackCount: () => count, getScrollbackDiscardedCount: () => discarded, usingAltScreen: () => alt };
  const first = h.update(core); expect(first).toMatchObject({ first: 10, end: 40, alternate: false });
  expect(h.offset(10, first.epoch)).toBe(29); expect(h.offset(39, first.epoch)).toBe(0);
  count += 5; const append = h.update(core); expect(append.epoch).toBe(first.epoch); expect(h.offset(39, first.epoch)).toBe(5);
  discarded += 5; count -= 5; expect(h.update(core).first).toBe(15); expect(() => h.offset(10, first.epoch)).toThrow("expired");
  h.observe("\x1b[3"); h.observe("J"); count = 100; const clear = h.update(core);
  expect(clear.epoch).not.toBe(first.epoch); expect(() => h.offset(39, first.epoch)).toThrow("expired");
  alt = true; const alternate = h.update(core); expect(alternate.epoch).not.toBe(clear.epoch); expect(alternate.first).toBe(alternate.end);
  alt = false; expect(h.update(core).epoch).not.toBe(alternate.epoch);
  h.invalidate(); expect(h.update(core).epoch).not.toBe(clear.epoch);
});

test("boundary observer handles split VT sequences without treating OSC/DCS data as terminal commands", () => {
  const observer = new HistoryBoundary();
  expect(observer.feed("\x1b]2;literal \x1b[3J title\x07")).toBe(false);
  expect(observer.feed("\x1bPignored \x1b[3J\x1b\\")).toBe(false);
  expect(observer.feed("\x1b[2Jprogress\r50%")).toBe(false);
  expect(observer.feed("\x1b[?104")).toBe(false); expect(observer.feed("9h\x1b[?1049l")).toBe(true);
  expect(observer.feed("\x1b")).toBe(false); expect(observer.feed("c")).toBe(true);
  expect(observer.feed("\x1b]4;1;?\x07\x1b]10;?\x1b\\")).toBe(false);
  expect(observer.feed("\x1b]4;1;#123")).toBe(false); expect(observer.feed("456\x07")).toBe(true);
  expect(observer.feed("\x1b]104\x1b\\")).toBe(true);
  expect(observer.feed("\x1b]4;" + "1;?;".repeat(100) + "1;#abcdef\x07")).toBe(true);
});

test("viewport demand prioritizes visible rows, stays bounded, and recycles only one slot per row crossed", () => {
  const m = { epoch: "a", first: 20, end: 2000, alternate: false };
  const demand = historyDemand(1, m, 500, -1);
  expect(demand).toHaveLength(HISTORY.demand);
  expect(demand.slice(0, 26).map(d => d.input.row)).toEqual(Array.from({ length: 26 }, (_, i) => 500 + i));
  expect(demand.slice(0, 26).every(d => d.pin)).toBe(true);
  expect(historyDemand(1, m, m.end, -1)[0].input.row).toBe(1999);
  expect(historyDemand(1, { ...m, alternate: true }, 500, -1)).toEqual([]);
  for (const first of [0, 25, 26, 511, 2000000]) {
    const before = Array.from({ length: 26 }, (_, slot) => slotRow(slot, first, 26));
    const after = Array.from({ length: 26 }, (_, slot) => slotRow(slot, first + 1, 26));
    expect(before.filter((row, i) => row !== after[i])).toHaveLength(1);
    expect(new Set(before).size).toBe(26);
  }
});

function transport() {
  let nextId = 0;
  const requests: { id: number; input: HistoryRequest; done: Parameters<HistoryIO["request"]>[2]; cancelled: boolean; answered: boolean }[] = [];
  const io: HistoryIO = {
    request(method, payload, done) { expect(method).toBe("term.history"); const id = ++nextId; requests.push({ id, input: JSON.parse(payload), done, cancelled: false, answered: false }); return id; },
    cancel(id) { const r = requests.find(r => r.id === id); if (r) r.cancelled = true; },
  };
  const answer = (r: typeof requests[number], raw = JSON.stringify([[0, `history-${r.input.epoch}-${r.input.row}`, -1, -1]])) => {
    r.answered = true;
    r.done({ ok: true, value: JSON.stringify({ epoch: r.input.epoch, row: r.input.row, part: r.input.part,
      parts: Math.ceil(raw.length / HISTORY.fragmentChars), data: raw.slice(r.input.part * HISTORY.fragmentChars, (r.input.part + 1) * HISTORY.fragmentChars) }) });
  };
  return { io, requests, answer };
}

test("fragmented history reads assemble exact rows and cancellation fences late data", () => {
  const t = transport(), result: unknown[] = [], load = historyLoader(t.io);
  const runs: Run[] = Array.from({ length: 80 }, (_, x) => [x, x % 2 ? "\\" : "字", x % 2 ? 0xffffff : 0x800000, -1]);
  const raw = JSON.stringify(runs), handle = load({ sid: 1, epoch: "generation", row: 10 }, r => result.push(r));
  for (let n = 0; n < t.requests.length; n++) t.answer(t.requests[n], raw);
  expect(result).toEqual([{ ok: true, value: raw }]); expect(t.requests.length).toBeGreaterThan(1);
  expect(decodeHistoryRow(raw)).toEqual(runs);
  const late = load({ sid: 1, epoch: "old", row: 20 }, r => result.push(r));
  if (late) late.cancel(); t.answer(t.requests.at(-1)!); expect(result).toHaveLength(1);
  expect(() => decodeHistoryRow('[[79,"ab",-1,-1]]')).toThrow("span");
  expect(() => decodeHistoryRow('[[0,"x",-1,-1],[0,"y",-1,-1]]')).toThrow("run");
  if (handle) handle.cancel();
});

test("local history glides while IO is delayed; cached reading survives disconnect and append preserves its anchor", () => {
  resetFrameHooks(); const t = transport(); let h!: TermHistory, dispose!: () => void;
  createRoot(close => { dispose = close; h = createTermHistory(t.io, y => () => [[0, `live-${y}`, -1, -1]], 24, 10); });
  const m: HistoryManifest = { epoch: "session-a", first: 0, end: 100, alternate: false };
  h.adopt(1, m); h.setOnline(true);
  const frame = (reply = true) => { h.frame(); runFrameHooks(0); if (reply) for (const r of [...t.requests]) if (!r.answered && !r.cancelled) t.answer(r); };
  for (let i = 0; i < 30; i++) frame();
  expect(h.stats().ready).toBeGreaterThan(20);
  const plans = h.stats().plans;
  for (let i = 0; i < 60; i++) frame(false);
  expect(h.stats().plans).toBe(plans); // idle frames do not rebuild demand maps
  h.beginDrag(); h.drag(-100); h.endDrag(-120);
  const before = h.scroller.offset(); for (let i = 0; i < 10; i++) frame(false);
  expect(h.scroller.offset()).toBeLessThan(before); // no network reply needed to move
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) { frame(false); positions.push(h.translation(0)); }
  expect(new Set(positions.map(p => Math.abs(p) % 10)).size).toBeGreaterThan(2); // sub-row paint positions
  h.stop(); const anchored = h.first(); expect(h.row(anchored)).toBeDefined();
  h.adopt(1, { ...m, end: 110 }); expect(h.first()).toBe(anchored);
  h.adopt(1, { ...m, first: 10, end: 110 }); expect(h.first()).toBe(anchored);
  h.setOnline(false); const count = t.requests.length; for (let i = 0; i < 20; i++) frame(false);
  expect(t.requests.length).toBe(count); expect(h.row(anchored)).toBeDefined();
  h.beginDrag(); h.drag(-600); h.endDrag(0); frame(false); expect(h.row(h.first())).toBeUndefined(); // skeleton, not a fabricated blank row
  const old = t.requests.find(r => !r.answered)!;
  h.adopt(1, { ...m, epoch: "session-b" }); h.setOnline(true);
  if (old) t.answer(old); frame(false); expect(h.first()).toBe(100); expect(h.row(0)).toBeUndefined();
  h.adopt(1, { epoch: "alternate", first: 0, end: 0, alternate: true }); h.nudge(-100); h.drag(-100); frame(false);
  expect(h.first()).toBe(0); expect(h.row(0)?.[0][1]).toBe("live-0");
  expect(h.stats().entries).toBeLessThanOrEqual(HISTORY.entries); dispose(); resetFrameHooks();
});

test("right stick repeats cardinal cursor keys, rejects drift and stabilizes diagonal motion", () => {
  const stick = createCursorStick();
  expect(stick.step(0.1, -0.1)).toBeUndefined(); expect(stick.step(0, -0.8)).toBe("Up");
  for (let i = 0; i < 15; i++) expect(stick.step(0, -0.8)).toBeUndefined();
  expect(stick.step(0, -0.8)).toBe("Up"); expect(stick.step(0.8, -0.75)).toBeUndefined();
  expect(stick.step(0.9, -0.3)).toBe("Right"); stick.step(0, 0); expect(stick.step(-0.4, 0)).toBe("Left");
});
