import type { ClientLine } from "./protocol.ts";
import { OFFLOAD } from "../vendor/pocketjs/contracts/spec/offload.ts";

/** Limits cover the guest, provider and durable terminal worker. */
export const LIMITS = { commands: 64, inputBatch: 8, sessions: 32, replicas: 8, outputChars: 262144, lineChars: 65536, fragmentChars: 1800 } as const;
export interface InputCommand { id: number; line: ClientLine }
export interface InputRequest { replica: string; epoch?: string; commands: InputCommand[] }
export interface InputReply { epoch: string; ack: number; error?: string }
export interface ExchangeRequest {
  replica: string;
  epoch?: string;
  received: number;
  command?: InputCommand;
}

/** The app uses the public offload record limits without allocating a
 * TextEncoder buffer on the handheld. Count the fully nested wire JSON. */
export function fitsRecord(payload: string, method = "term.exchange", reply = false): boolean {
  if (payload.length > OFFLOAD.payloadChars) return false;
  const record = JSON.stringify(reply ? { id: Number.MAX_SAFE_INTEGER, payload } : { v: 1, id: Number.MAX_SAFE_INTEGER, method, payload });
  let bytes = 0;
  for (let i = 0; i < record.length; i++) {
    const c = record.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < record.length) { bytes += 4; i++; }
    else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
  }
  return bytes <= OFFLOAD.recordBytes;
}
export interface ExchangeReply {
  epoch: string;
  ack: number;
  sequence: number;
  data?: string;
  more?: boolean;
  error?: string;
}
