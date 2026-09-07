import { createRoot } from "solid-js";
import { createOffloadClient } from "@pocketjs/framework/offload";
import { HISTORY } from "../shared/history.ts";
import { historyBatchReply } from "../host/history-batch.ts";
import { createTermHistory } from "../app/history.ts";
import { createTermChannel } from "../app/offload.ts";

/** Actual guest offload pump: two sends, one take per frame, fixed RTT,
 * continuous idle output polls and a cold 26-row viewport. No wire-byte
 * throughput cap is simulated: this isolates protocol/scheduler limits. */
export function historyThroughput(factory: typeof createTermHistory = createTermHistory, fps = 60, colored = false) {
  let frame = 0, nextReply = 0, submitted = 0, replyBytes = 0, historyRequests = 0, firstMs = -1, fullMs = -1, maxPublished = 0, previousReady = 0;
  const perReplyRows: number[] = [];
  const pending: { at: number; order: number; raw: string }[] = [];
  const rowRaw = (row: number) => JSON.stringify(colored
    ? Array.from({ length: 80 }, (_, x) => [x, String.fromCharCode(33 + (x + row) % 90), x % 2 ? 0x123456 : 0xffffff, -1])
    : [[0, `${String(row).padStart(6, "0")}  ${"shell output ".repeat(7)}`.slice(0, 80), -1, -1]]);
  const io = createOffloadClient({ session: () => 1,
    submit(record) {
      if (submitted >= 2) return false; submitted++;
      const r = JSON.parse(record), p = JSON.parse(r.payload); let payload: unknown;
      if (r.method === "term.history") {
        historyRequests++; const raw = rowRaw(p.row);
        payload = { epoch: p.epoch, row: p.row, part: p.part, parts: Math.ceil(raw.length / HISTORY.fragmentChars), data: raw.slice(p.part * HISTORY.fragmentChars, (p.part + 1) * HISTORY.fragmentChars) };
        perReplyRows.push(p.part + 1 === Math.ceil(raw.length / HISTORY.fragmentChars) ? 1 : 0);
      } else if (r.method === "term.history.batch") {
        historyRequests++; const reply = historyBatchReply(p, rowRaw); payload = reply;
        perReplyRows.push(reply.chunks.filter(c => !c[3]).length);
      } else payload = { epoch: "fixture", ack: 0, sequence: 0 };
      const raw = JSON.stringify({ id: r.id, payload: JSON.stringify(payload) });
      replyBytes += new TextEncoder().encode(raw).length;
      pending.push({ at: frame + Math.ceil(fps * .1), order: nextReply++, raw }); return true;
    },
    take() { const next = pending.findIndex(p => p.at <= frame); return next < 0 ? undefined : pending.splice(next, 1)[0].raw; },
  });
  let history!: ReturnType<typeof createTermHistory>, dispose!: () => void;
  createRoot(close => { dispose = close; history = factory(io, y => () => [[0, `live-${y}`, -1, -1]], 24, 10); });
  const output = createTermChannel(io, "benchmark-output");
  history.adopt(1, { epoch: "benchmark-epoch", first: 0, end: 2000, alternate: false }); history.setOnline(true);
  history.beginDrag(); history.drag(-10000); history.endDrag(0);
  for (; frame < fps * 30; frame++) {
    submitted = 0; io.step(); history.frame(); output.poll();
    const ready = Array.from({ length: 26 }, (_, y) => history.row(1000 + y) !== undefined).filter(Boolean).length;
    maxPublished = Math.max(maxPublished, ready - previousReady); previousReady = ready;
    if (ready && firstMs < 0) firstMs = frame * 1000 / fps;
    if (ready === 26) { fullMs = frame * 1000 / fps; break; }
  }
  const result = { fps, rttMs: 100, colored, firstMs, fullMs, historyRequests, replyBytes, maxPublished,
    maxRowsPerReply: Math.max(...perReplyRows), readyRows: previousReady };
  dispose(); output.dispose?.(); io.dispose(); return result;
}
