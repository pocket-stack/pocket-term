import type { ResourceLoad, ResourceResult } from "@pocketjs/framework/resource-cache";
import { HISTORY, HISTORY_BATCH, type HistoryBatchReply, type HistoryInput } from "../shared/history.ts";
import type { HistoryIO } from "./history.ts";

interface RowTask { input: HistoryInput; complete(result: ResourceResult<string>): void; live: boolean; raw: string; batch?: RowBatch }
interface RowBatch { tasks: RowTask[]; id: number }

/** The scheduler retains per-row ownership. Only the wire groups reads, so
 * cancellation, pruning and partial tails never alias a page identity. */
export function createHistoryBatchLoader(io: HistoryIO) {
  let queued: RowTask[] = [];
  let completed: RowTask[] = [];
  const batches = new Set<RowBatch>();
  const counters = { requests: 0, replies: 0, replyChars: 0, completedRows: 0, cancelledRows: 0 };
  const retire = (b: RowBatch) => { if (b.id) io.cancel(b.id); b.id = 0; batches.delete(b); };
  const fail = (b: RowBatch, error: unknown) => {
    retire(b);
    for (const t of b.tasks) if (t.live) { t.live = false; t.complete({ ok: false, error }); }
  };
  const request = (b: RowBatch): boolean => {
    b.tasks = b.tasks.filter(t => t.live);
    if (!b.tasks.length) { retire(b); return true; }
    const first = b.tasks[0];
    b.id = io.request("term.history.batch", JSON.stringify({ sid: first.input.sid, epoch: first.input.epoch,
      rows: b.tasks.map(t => t.input.row), offset: first.raw.length }), result => {
      b.id = 0;
      if (!batches.has(b)) return;
      if (!result.ok) { fail(b, result.error); return; }
      try {
        const p = JSON.parse(result.value) as HistoryBatchReply;
        if (p.epoch !== first.input.epoch || !Array.isArray(p.chunks) || !p.chunks.length || p.chunks.length > b.tasks.length) throw new Error("Invalid history batch reply");
        // Validate the whole envelope before publishing any row completion.
        for (let i = 0; i < p.chunks.length; i++) {
          const c = p.chunks[i], t = b.tasks[i];
          if (!Array.isArray(c) || c.length !== 4 || c[0] !== t.input.row || c[1] !== t.raw.length ||
              typeof c[2] !== "string" || !c[2].length || t.raw.length + c[2].length > HISTORY.rowChars ||
              typeof c[3] !== "boolean" || c[3] && i !== p.chunks.length - 1) throw new Error("Invalid history batch chunk");
        }
        counters.replies++; counters.replyChars += result.value.length;
        const finished = new Set<RowTask>();
        for (let i = 0; i < p.chunks.length; i++) {
          const [,,data,more] = p.chunks[i], t = b.tasks[i];
          if (t.live) {
            t.raw += data;
            if (!more) { completed.push(t); finished.add(t); }
          } else finished.add(t);
        }
        b.tasks = b.tasks.filter(t => !finished.has(t) && t.live);
        if (!b.tasks.length) retire(b);
        // Continuations wait for step(), after demand cancellation and the
        // input-priority check. No transport callback starts hidden work.
      } catch (error) { fail(b, error); }
    });
    if (b.id) counters.requests++;
    return b.id !== 0;
  };
  const load: ResourceLoad<HistoryInput, string> = (input, complete) => {
    const task: RowTask = { input, complete, live: true, raw: "" }; queued.push(task);
    return { cancel() { if (!task.live) return; task.live = false; counters.cancelledRows++;
      const b = task.batch; if (b && b.tasks.every(t => !t.live)) retire(b);
    } };
  };
  return {
    load,
    /** Feed the public materialization scheduler by both row and text cost.
     * Dense ANSI rows do not turn one network reply into 640 new text nodes
     * in one frame. One oversized row is allowed so progress cannot stall. */
    publish() {
      completed = completed.filter(t => t.live);
      let rows = 0, chars = 0;
      while (completed.length && rows < HISTORY_BATCH.materializeRows) {
        const t = completed[0];
        if (rows && chars + t.raw.length > HISTORY_BATCH.materializeChars) break;
        completed.shift(); rows++; chars += t.raw.length; t.live = false;
        counters.completedRows++; t.complete({ ok: true, value: t.raw });
      }
    },
    step(available: boolean) {
      queued = queued.filter(t => t.live);
      if (!available) return;
      for (const b of batches) if (!b.id && !request(b)) return;
      while (queued.length && batches.size < HISTORY_BATCH.concurrent) {
        const first = queued[0], selected: RowTask[] = [];
        queued = queued.filter(t => {
          if (selected.length < HISTORY_BATCH.rows && t.input.sid === first.input.sid && t.input.epoch === first.input.epoch) { selected.push(t); return false; }
          return true;
        });
        const b: RowBatch = { tasks: selected, id: 0 }; for (const t of selected) t.batch = b;
        batches.add(b); if (!request(b)) return;
      }
    },
    stats: () => ({ ...counters, batches: batches.size, queuedRows: queued.filter(t => t.live).length, completedRowsPending: completed.filter(t => t.live).length }),
  };
}
