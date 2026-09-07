import { expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import { __advanceClock, resetClock } from "@pocketjs/framework/clock";
import { createTermStore } from "../app/store.ts";
import { TERM_PROTO, type ClientLine, type HostLine } from "../shared/protocol.ts";

test("chunked snapshots commit atomically, gaps resync, reconnect remembers the session", () => {
  let open = true, incoming: HostLine[] = []; const sent: ClientLine[] = [];
  const store = createTermStore({ cols: 80, rows: 24, cell: [5, 10] }, {
    open: () => open, send: line => { sent.push(line); }, poll: () => incoming.splice(0),
  });
  store.frame(); expect(sent[0]).toMatchObject({ t: "hello", proto: TERM_PROTO, cols: 80, rows: 24 });
  incoming.push({ t: "sessions", list: [{ sid: 1, title: "sh" }], active: 1 },
    { t: "grid", sid: 1, gen: 1, seq: 0, full: 1, more: 1, rows: [[0, [0, "first", -1, -1]]] });
  store.frame(); expect(store.row(0)()).toEqual([]);
  incoming.push({ t: "grid", sid: 1, gen: 1, seq: 1, full: 1, rows: [[23, [79, "X", -1, -1]]], cur: [79, 23, 1] });
  store.frame(); expect(store.row(0)()[0][1]).toBe("first"); expect(store.cursor()).toEqual([79, 23, 1]);
  incoming.push({ t: "grid", sid: 1, gen: 1, seq: 3, rows: [[0, [0, "wrong", -1, -1]]] });
  store.frame(); expect(sent.at(-1)).toEqual({ t: "resync" }); expect(store.row(0)()[0][1]).toBe("first");
  open = false; store.frame(); store.sendText("must not queue");
  open = true; store.frame(); expect(sent.at(-1)).toMatchObject({ t: "hello", want: 1 });
});

test("paste preserves Unicode and explicit start/end instead of inferring typing", () => {
  let incoming: HostLine[] = [{ t: "sessions", list: [{ sid: 1, title: "sh" }], active: 1 }];
  const sent: ClientLine[] = [];
  const store = createTermStore({ cols: 80, rows: 24, cell: [5, 10] }, { open: () => true, send: line => { sent.push(line); }, poll: () => incoming.splice(0) });
  store.frame(); store.paste("😀".repeat(200));
  const chunks = sent.filter(line => line.t === "paste");
  expect(chunks.map(line => line.s).join("")).toBe("😀".repeat(200));
  expect(chunks[0].phase).toBe("start"); expect(chunks.at(-1)!.phase).toBe("end");
  expect(chunks.every(line => line.s.length <= 128)).toBe(true);
});

for (const hz of [20, 60]) test(`prediction uses frame time for expiry and confidence at ${hz}Hz without reading wall time`, () => {
  const host = globalThis as { __simHz?: number }, previousHz = host.__simHz;
  const wallClock = spyOn(Date, "now").mockImplementation(() => { throw new Error("Prediction must not read wall time"); });
  try {
    host.__simHz = hz; resetClock();
    createRoot(dispose => {
      let incoming: HostLine[] = [
        { t: "sessions", list: [{ sid: 1, title: "sh" }], active: 1 },
        { t: "grid", sid: 1, gen: 1, seq: 0, full: 1, rows: [[0, [0, "$ ", -1, -1]]], cur: [2, 0, 1] },
      ];
      let commandId = 0, seq = 0, text = "$ ";
      const store = createTermStore({ cols: 80, rows: 24, cell: [5, 10] }, {
        open: () => true, send: () => ++commandId, poll: () => incoming.splice(0),
      });
      const frames = (count: number) => { for (let i = 0; i < count; i++) { __advanceClock(); store.frame(); } };
      const echo = (ch: string) => {
        text += ch;
        incoming.push({ t: "grid", sid: 1, gen: 1, seq: ++seq, ack: commandId,
          rows: [[0, [0, text, -1, -1]]], cur: [text.length, 0, 1] });
        frames(1);
      };
      try {
        frames(1);
        for (let i = 0; i < 2; i++) { store.sendText("a"); echo("a"); }
        store.sendText("c");
        expect(store.preview()?.text?.value).toBe("c");
        frames(hz * 0.3);
        expect(store.preview()?.text?.value).toBe("c");
        expect(store.row(0)()[0][1]).toBe("$ aa");
        frames(hz * 0.1);
        expect(store.preview()).toBeUndefined();
        expect(store.cursor()).toEqual([4, 0, 1]);
        expect(store.row(0)()[0][1]).toBe("$ aa");

        // A late real echo remains authoritative; retrain and then age out
        // confidence while no guess is pending, using the same frame clock.
        echo("c");
        for (let i = 0; i < 2; i++) { store.sendText("a"); echo("a"); }
        frames(hz * 2 + 1);
        store.sendText("d");
        expect(store.preview()).toBeUndefined();
        expect(store.row(0)()[0][1]).toBe("$ aacaa");
        expect(wallClock).not.toHaveBeenCalled();
      } finally { store.dispose(); dispose(); }
    });
  } finally {
    wallClock.mockRestore();
    if (previousHz === undefined) delete host.__simHz; else host.__simHz = previousHz;
    resetClock();
  }
});
