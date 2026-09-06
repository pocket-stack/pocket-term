import type { ClientLine } from "./protocol.ts";

/** Limits cover the guest, provider and durable terminal worker. */
export const LIMITS = { commands: 64, sessions: 32, replicas: 8, outputChars: 262144, lineChars: 65536, fragmentChars: 600 } as const;
export interface ExchangeRequest {
  replica: string;
  epoch?: string;
  received: number;
  command?: { id: number; line: ClientLine };
}
export interface ExchangeReply {
  epoch: string;
  ack: number;
  sequence: number;
  data?: string;
  more?: boolean;
  error?: string;
}
