import { fitsRecord } from "../shared/exchange.ts";
import { HISTORY, HISTORY_BATCH, type HistoryBatchReply, type HistoryBatchRequest } from "../shared/history.ts";

export function validateHistoryBatch(input: HistoryBatchRequest) {
  if (!input || !Number.isSafeInteger(input.sid) || input.sid < 1 || typeof input.epoch !== "string" ||
      !input.epoch.length || input.epoch.length > 96 || !Array.isArray(input.rows) || !input.rows.length ||
      input.rows.length > HISTORY_BATCH.rows || new Set(input.rows).size !== input.rows.length ||
      input.rows.some(row => !Number.isSafeInteger(row) || row < 0) ||
      !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= HISTORY.rowChars) throw new Error("Invalid history batch");
}

/** Fill the actual nested JSON budget. Rows remain individually addressed;
 * neither a short tail nor pruning can change the meaning of a cached row. */
export function historyBatchReply(input: HistoryBatchRequest, read: (row: number) => string): HistoryBatchReply {
  validateHistoryBatch(input);
  const reply: HistoryBatchReply = { epoch: input.epoch, chunks: [] };
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i], offset = i ? 0 : input.offset, raw = read(row);
    if (!raw.length || raw.length > HISTORY.rowChars || offset >= raw.length) throw new Error("Invalid history row offset");
    const chunk: HistoryBatchReply["chunks"][number] = [row, offset, raw.slice(offset), false];
    reply.chunks.push(chunk);
    if (fitsRecord(JSON.stringify(reply), "term.history.batch", true)) continue;
    // Avoid making a small row wait for another RTT merely to use the last
    // few bytes of this reply. Large rows alone use exact-offset fragments.
    if (reply.chunks.length > 1) { reply.chunks.pop(); break; }
    let low = 1, high = Math.min(raw.length - offset, HISTORY_BATCH.fragmentChars), length = 0;
    while (low <= high) {
      const n = (low + high) >> 1;
      // Reserve the longer boolean spelling even if this becomes a tail.
      chunk[2] = raw.slice(offset, offset + n); chunk[3] = false;
      if (fitsRecord(JSON.stringify(reply), "term.history.batch", true)) { length = n; low = n + 1; }
      else high = n - 1;
    }
    if (length && /[\uD800-\uDBFF]/.test(raw[offset + length - 1]) && offset + length < raw.length) length--;
    if (!length) throw new Error("History fragment exceeds budget");
    chunk[2] = raw.slice(offset, offset + length); chunk[3] = offset + length < raw.length;
    break;
  }
  return reply;
}
