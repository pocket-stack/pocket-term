import { offload } from "@pocketjs/framework/offload";
import { LIMITS, fitsRecord, type ExchangeReply, type ExchangeRequest, type InputCommand, type InputReply } from "../shared/exchange.ts";
import type { ClientLine, HostInputLine, HostLine } from "../shared/protocol.ts";
import type { TermChannel } from "./channel.ts";

type IO = Pick<ReturnType<typeof offload>, "connected" | "session" | "request" | "cancel">;

/** Input and output have independent tickets. One ordered input batch stays
 * in flight; its ids survive uncertain replies. Output keeps its own cursor
 * and cannot hold a key behind a large grid or atlas fragment. */
export function createTermChannel(io: IO, replica = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`): TermChannel {
  let epoch: string | undefined, received = 0, nextId = 1, output = 0, input = 0, generation = 0;
  let partial = "", outputRetry = 0, inputRetry = 0, lastHello: ClientLine | undefined, error = "";
  const commands: InputCommand[] = [], incoming: (HostLine | HostInputLine)[] = [];
  const enqueue = (lines: ClientLine[]) => {
    if (commands.length + lines.length > LIMITS.commands) { error = "Input queue full; wait for the Mac"; return false; }
    for (const line of lines) { if (line.t === "hello") lastHello = line; commands.push({ id: nextId++, line }); }
    return true;
  };
  function adopt(reply: InputReply): boolean {
    if (typeof reply.epoch !== "string" || !Number.isSafeInteger(reply.ack) || reply.ack < 0) throw new Error("Invalid terminal reply");
    if (epoch && reply.epoch !== epoch) {
      generation++;
      if (input) io.cancel(input); if (output) io.cancel(output); input = output = 0;
      commands.length = 0; nextId = 1; received = 0; partial = ""; incoming.length = 0;
      incoming.push({ t: "transport-reset" });
      error = "Mac restarted; pending input discarded";
      epoch = reply.epoch;
      if (lastHello) enqueue([lastHello]);
      return false;
    }
    epoch = reply.epoch; error = reply.error ?? "";
    while (commands[0] && commands[0].id <= reply.ack) commands.shift();
    return true;
  }
  function pumpInput() {
    if (input || inputRetry || !epoch || !io.connected() || !commands.length) return;
    let payload = "";
    for (let n = 1; n <= Math.min(LIMITS.inputBatch, commands.length); n++) {
      const candidate = JSON.stringify({ replica, epoch, commands: commands.slice(0, n) });
      if (!fitsRecord(candidate, "term.input")) break;
      payload = candidate;
    }
    if (!payload) { error = "Input record exceeds budget"; return; }
    const ticketGeneration = generation;
    input = io.request("term.input", payload, result => {
      if (ticketGeneration !== generation) return;
      input = 0;
      if (!result.ok) { error = result.error; inputRetry = 2; return; }
      try { adopt(JSON.parse(result.value)); }
      catch (cause) { error = String(cause).slice(0, 120); inputRetry = 2; }
    });
  }
  return {
    historyIO: io,
    open: () => io.connected(), status: () => error,
    inputPending: () => commands.length > 0 || input !== 0,
    send(line) { const id = nextId; if (!enqueue([line])) return 0; pumpInput(); return id; },
    sendBatch(lines) { const accepted = enqueue(lines); if (accepted) pumpInput(); return accepted; },
    dispose() { generation++; if (input) io.cancel(input); if (output) io.cancel(output); commands.length = incoming.length = 0; partial = ""; },
    poll() {
      if (outputRetry > 0) outputRetry--; if (inputRetry > 0) inputRetry--;
      pumpInput();
      if (!output && !outputRetry && io.connected()) {
        const request: ExchangeRequest = { replica, epoch, received }, ticketGeneration = generation;
        output = io.request("term.exchange", JSON.stringify(request), result => {
          if (ticketGeneration !== generation) return;
          output = 0;
          if (!result.ok) { error = result.error; outputRetry = 2; return; }
          try {
            const reply = JSON.parse(result.value) as ExchangeReply;
            if (!adopt(reply)) return;
            if (!Number.isSafeInteger(reply.sequence) || reply.sequence < 0) throw new Error("Invalid terminal delivery");
            if (reply.data !== undefined && reply.sequence > received) {
              if (reply.sequence !== received + 1 || typeof reply.data !== "string" || partial.length + reply.data.length > LIMITS.lineChars) throw new Error("Invalid terminal delivery");
              partial += reply.data; received = reply.sequence;
              if (!reply.more) { incoming.push(JSON.parse(partial)); partial = ""; }
            }
          } catch (cause) { error = String(cause).slice(0, 120); outputRetry = 2; }
        });
      }
      return incoming.splice(0);
    },
  };
}

export function connectTermOffload(): TermChannel | null {
  if (!(globalThis as { offload?: unknown }).offload) return null;
  return createTermChannel(offload());
}
