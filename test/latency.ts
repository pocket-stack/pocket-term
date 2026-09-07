import { Mailbox } from "../host/exchange.ts";
import type { TermChannel } from "../app/channel.ts";

/** Deterministic 60 Hz native boundary: 100 ms RTT, two submissions and one
 * reply delivery per frame. Samples input arrival at the PTY capability,
 * not a network callback or an optimistic pixel. */
export function latencyScenario(factory: (io: any, replica: string) => TermChannel) {
  const mailbox = new Mailbox(), sent = new Map<number, number>(), latency: number[] = [];
  let frame = 0, requestId = 0, generation = 0, submitted = 0, peakQueue = 0;
  const pending: { id: number; method: string; request: any; sentAt: number; reply?: any; done: any; cancelled?: boolean }[] = [];
  const inputKeys: number[] = [];
  const channel = factory({ connected: () => true, session: () => 1, cancel(id: number) { const p = pending.find(p => p.id === id); if (p) p.cancelled = true; },
    request(method: string, payload: string, done: any) {
      const id = ++requestId; pending.push({ id, method, request: JSON.parse(payload), sentAt: -1, done }); return id;
    },
  }, "latency-replica");
  for (; frame < 700; frame++) {
    submitted = 0;
    for (const p of pending) {
      if (p.cancelled) continue;
      if (p.sentAt < 0 && submitted < 2) { p.sentAt = frame; submitted++; }
      if (p.sentAt < 0 || frame !== p.sentAt + 3) continue;
      const apply = (line: any) => {
        if (line.t !== "key") return;
        const n = Number(line.k); latency.push((frame - sent.get(n)!) * 1000 / 60); inputKeys.push(n);
        mailbox.push({ t: "grid", sid: 1, gen: 1, seq: generation++, rows: [], cur: [n % 80, 0, 1] });
      };
      p.reply = p.method === "term.input" ? mailbox.input(p.request, "mac", apply) : mailbox.exchange(p.request, "mac", apply);
    }
    const ready = pending.find(p => !p.cancelled && p.reply && frame >= p.sentAt + 6);
    if (ready) { ready.cancelled = true; ready.done({ ok: true, value: JSON.stringify(ready.reply) }); }
    channel.poll();
    if (frame >= 20 && frame < 200 && (frame - 20) % 3 === 0) {
      const n = (frame - 20) / 3; sent.set(n, frame); channel.send({ t: "key", k: String(n) });
    }
    peakQueue = Math.max(peakQueue, sent.size - inputKeys.length);
  }
  channel.dispose?.();
  const sorted = latency.slice().sort((a, b) => a - b);
  return { inputs: inputKeys.length, unique: new Set(inputKeys).size, ordered: inputKeys.every((n, i) => n === i), p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1), peakQueue };
}
