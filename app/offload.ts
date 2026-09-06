import { offload } from "@pocketjs/framework/offload";
import { LIMITS, type ExchangeReply, type ExchangeRequest } from "../shared/exchange.ts";
import type { ClientLine, HostInputLine, HostLine } from "../shared/protocol.ts";
import type { TermChannel } from "./channel.ts";

type IO = Pick<ReturnType<typeof offload>, "connected" | "session" | "request" | "cancel">;

/** One bounded request in flight. Retry retains the command id, so losing
 * its reply cannot type twice or create a second shell. */
export function createTermChannel(io: IO, replica = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`): TermChannel {
  let epoch: string | undefined, received = 0, nextId = 1, pending = 0;
  let partial = "", retry = 0, lastHello: ClientLine | undefined;
  let error = "";
  const commands: { id: number; line: ClientLine }[] = [];
  const incoming: (HostLine | HostInputLine)[] = [];
  const sendBatch = (lines: ClientLine[]) => {
    if (commands.length + lines.length > LIMITS.commands) { error = "Input queue full; wait for the Mac"; return false; }
    for (const line of lines) {
      if (line.t === "hello") lastHello = line;
      commands.push({ id: nextId++, line });
    }
    return true;
  };
  const send = (line: ClientLine) => { sendBatch([line]); };
  return {
    historyIO: io,
    open: () => io.connected(),
    status: () => error,
    send,
    sendBatch,
    dispose() { if (pending) io.cancel(pending); commands.length = 0; incoming.length = 0; partial = ""; },
    poll() {
      const lines = incoming.splice(0);
      if (retry > 0) retry--;
      if (!pending && !retry && io.connected()) {
        const request: ExchangeRequest = { replica, epoch, received, ...(epoch && commands[0] ? { command: commands[0] } : {}) };
        pending = io.request("term.exchange", JSON.stringify(request), result => {
          pending = 0;
          if (!result.ok) { error = result.error; retry = 30; return; }
          try {
            const reply = JSON.parse(result.value) as ExchangeReply;
            if (typeof reply.epoch !== "string" || !Number.isSafeInteger(reply.ack) || !Number.isSafeInteger(reply.sequence)) throw new Error("Invalid terminal reply");
            if (epoch && reply.epoch !== epoch) {
              // A restarted daemon has no deduplication history. Never replay
              // an uncertain command against a new terminal process.
              commands.length = 0; nextId = 1; received = 0; partial = "";
              incoming.length = 0;
              incoming.push({ t: "transport-reset" });
              error = "Mac restarted; pending input discarded";
              if (lastHello) send(lastHello);
            } else error = reply.error ?? "";
            epoch = reply.epoch;
            while (commands[0] && commands[0].id <= reply.ack) commands.shift();
            if (reply.data !== undefined && reply.sequence > received) {
              if (reply.sequence !== received + 1 || typeof reply.data !== "string" || partial.length + reply.data.length > LIMITS.lineChars) throw new Error("Invalid terminal delivery");
              partial += reply.data; received = reply.sequence;
              if (!reply.more) { incoming.push(JSON.parse(partial)); partial = ""; }
            }
          } catch (cause) { error = String(cause).slice(0, 120); retry = 30; }
        });
      }
      return lines;
    },
  };
}

export function connectTermOffload(): TermChannel | null {
  if (!(globalThis as { offload?: unknown }).offload) return null;
  return createTermChannel(offload());
}
