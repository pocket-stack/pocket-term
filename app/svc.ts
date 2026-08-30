// app/svc.ts — the companion channel over spec ops 30..32 (the
// apps/note/svc.ts shape). Hosts without the channel feature-detect to null
// and the app stays on its connect screen.

import { getOps } from "@pocketjs/framework";
import { TERM_APP, type ClientLine, type HostInputLine, type HostLine } from "./protocol.ts";

export interface Svc {
  /** Non-blocking transport probe — call once per frame; false while the
   *  companion is still being discovered (the app supplies the cadence). */
  open(): boolean;
  /** Drain and parse this frame's lines (call once per frame). The queue
   *  carries the companion's terminal state and, on a desktop host, the
   *  window's own input — see HostInputLine. */
  poll(): (HostLine | HostInputLine)[];
  send(line: ClientLine): void;
}

/** Null = this host has no svc channel at all (goldens, hosts/sim). */
export function connectSvc(): Svc | null {
  const ops = getOps();
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend) return null;
  const open = ops.svcOpen.bind(ops);
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  return {
    open: () => open(TERM_APP),
    poll() {
      const batch = poll();
      if (!batch) return [];
      const lines: (HostLine | HostInputLine)[] = [];
      for (const line of batch.split("\n")) {
        if (line === "") continue;
        try {
          lines.push(JSON.parse(line) as HostLine | HostInputLine);
        } catch {
          // A malformed line is a companion bug; skip it rather than wedge.
        }
      }
      return lines;
    },
    send(line) {
      send(JSON.stringify(line));
    },
  };
}
