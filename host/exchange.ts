import { randomUUID } from "node:crypto";
import { LIMITS, fitsRecord, type ExchangeReply, type ExchangeRequest, type InputRequest, type InputReply } from "../shared/exchange.ts";
import type { ClientLine, HostLine } from "../shared/protocol.ts";

// A held fragment can be retried after input advances the ack or reports
// an error. Reserve their largest encoding without changing held data.
const ERROR_RESERVE = "\u0000".repeat(120);

/** A connection-independent replica. Replies remain until acknowledged;
 * command ids are consumed once, including rejected commands. PTYs belong
 * to the terminal worker, never to the reconnecting provider worker. */
export class Mailbox {
  identity = randomUUID();
  ack = 0;
  sequence = 0;
  touched = Date.now();
  private queue: string[] = [];
  private chars = 0;
  private head = 0;
  private held?: { data: string; more: boolean };
  private error?: string;
  private overflowed = false;
  get busy() { return this.queue.length > 0 || this.held !== undefined; }

  push(line: HostLine) {
    if (this.overflowed) return;
    const text = JSON.stringify(line);
    if (text.length > LIMITS.lineChars || this.chars + text.length > LIMITS.outputChars) {
      // Retire only this delivery epoch. An inactive replica cannot exhaust
      // the terminal process or terminate other users' PTYs.
      this.identity = randomUUID(); this.ack = 0; this.sequence = 0;
      this.queue = []; this.chars = 0; this.head = 0; this.held = undefined;
      this.overflowed = true; return;
    }
    this.queue.push(text); this.chars += text.length;
  }

  input(request: InputRequest, epoch: string, apply: (line: ClientLine) => void): InputReply {
    this.touched = Date.now();
    if (request.epoch !== epoch) return { epoch, ack: this.ack };
    if (!Array.isArray(request.commands) || request.commands.length > LIMITS.inputBatch) throw new Error("Invalid input batch");
    let previous = 0, next = this.ack + 1;
    for (const command of request.commands) {
      if (!Number.isSafeInteger(command.id) || command.id < 1 || command.id <= previous || command.id > next) throw new Error("Command sequence gap");
      previous = command.id; if (command.id === next) next++;
    }
    let applying = false;
    for (const command of request.commands) if (command.id === this.ack + 1) {
      if (this.overflowed && command.line.t !== "hello") throw new Error("Replica hello required after overflow");
      if (!applying) { this.error = undefined; applying = true; }
      this.overflowed = false; this.ack = command.id;
      try { apply(command.line); } catch (error) { this.error ??= String(error).slice(0, 120); }
    }
    return { epoch, ack: this.ack, ...(this.error ? { error: this.error } : {}) };
  }

  exchange(request: ExchangeRequest, epoch: string, apply: (line: ClientLine) => void): ExchangeReply {
    this.touched = Date.now();
    // A fresh handshake learns the daemon epoch before sending any input.
    if (request.epoch !== epoch) return { epoch, ack: this.ack, sequence: this.sequence };
    if (!Number.isSafeInteger(request.received) || request.received < 0 || request.received > this.sequence) throw new Error("Invalid delivery acknowledgement");
    if (this.held && request.received === this.sequence) this.held = undefined;
    if (request.command) this.input({ replica: request.replica, epoch: request.epoch, commands: [request.command] }, epoch, apply);
    if (!this.held && this.queue.length) {
      const text = this.queue[0];
      let low = 1, high = Math.min(text.length - this.head, LIMITS.fragmentChars), length = 1;
      while (low <= high) {
        const n = (low + high) >> 1;
        if (fitsRecord(JSON.stringify({ epoch, ack: Number.MAX_SAFE_INTEGER, sequence: Number.MAX_SAFE_INTEGER,
          data: text.slice(this.head, this.head + n), more: false, error: ERROR_RESERVE }), "term.exchange", true)) { length = n; low = n + 1; }
        else high = n - 1;
      }
      let end = this.head + length;
      // Do not cut a Unicode surrogate pair across JSON records.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      this.held = { data: text.slice(this.head, end), more: end < text.length };
      this.sequence++;
      this.head = end;
      if (end === text.length) { this.queue.shift(); this.chars -= text.length; this.head = 0; }
    }
    return { epoch, ack: this.ack, sequence: this.sequence, ...this.held, ...(this.error ? { error: this.error } : {}) };
  }
}
