import { expect, test } from "bun:test";
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
