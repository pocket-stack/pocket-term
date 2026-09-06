import type { Run } from "./protocol.ts";

/** Oldest-inclusive / newest-exclusive absolute row addresses. They are
 * independent of the current viewport and transport connection. */
export interface HistoryManifest { epoch: string; first: number; end: number; alternate: boolean }
export interface HistoryInput { sid: number; epoch: string; row: number }
export interface HistoryRequest extends HistoryInput { part: number }
export interface HistoryReply { epoch: string; row: number; part: number; parts: number; data: string }
export const HISTORY = { rows: 2000, entries: 192, demand: 144, fragmentChars: 600, rowChars: 16384, concurrent: 2 } as const;
export const historyKey = (i: HistoryInput) => `${i.sid}/${i.epoch}/${i.row}`;

export function validManifest(m: HistoryManifest): boolean {
  return !!m && typeof m.epoch === "string" && m.epoch.length > 0 && m.epoch.length <= 96 &&
    Number.isSafeInteger(m.first) && Number.isSafeInteger(m.end) && m.first >= 0 && m.end >= m.first &&
    m.end - m.first <= HISTORY.rows && typeof m.alternate === "boolean";
}

/** Bound resident row shape before it reaches the renderer. Empty arrays
 * mean a known blank row; missing values mean a cache miss. */
export function decodeHistoryRow(raw: string): Run[] {
  if (raw.length > HISTORY.rowChars) throw new Error("History row exceeds budget");
  const runs = JSON.parse(raw);
  if (!Array.isArray(runs) || runs.length > 80) throw new Error("Invalid history row");
  let end = 0;
  for (const r of runs) {
    if (!Array.isArray(r) || r.length < 4 || r.length > 6 || !Number.isInteger(r[0]) || r[0] < end ||
        typeof r[1] !== "string" || !r[1].length || r[1].length > 1024 ||
        ![r[2], r[3]].every(c => Number.isInteger(c) && c >= -1 && c <= 0xffffff) ||
        (r[4] !== undefined && r[4] !== null && (!Number.isInteger(r[4]) || r[4] < 19 || r[4] > 23))) throw new Error("Invalid history run");
    const width = r[5] ?? r[1].length;
    if (!Number.isInteger(width) || width < 1 || r[0] + width > 80) throw new Error("Invalid history span");
    end = r[0] + width;
  }
  return runs;
}

/** A row keeps its physical rendering slot until it leaves the window. */
export function slotRow(slot: number, first: number, slots: number): number {
  return first + ((slot - first) % slots + slots) % slots;
}
