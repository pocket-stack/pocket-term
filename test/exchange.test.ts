import { expect, test } from "bun:test";
import { Mailbox } from "../host/exchange.ts";
import { createTermChannel } from "../app/offload.ts";
import { LIMITS, fitsRecord, type ExchangeRequest } from "../shared/exchange.ts";
import { TERM_PROTO } from "../shared/protocol.ts";
import { OFFLOAD } from "@pocketjs/framework/offload";

test("lost replies retain output and never re-execute input", () => {
  const mailbox = new Mailbox(); let executions = 0;
  const req: ExchangeRequest = { replica: "test-replica", epoch: "mac", received: 0, command: { id: 1, line: { t: "new" } } };
  mailbox.push({ t: "hello", proto: TERM_PROTO, name: "Mac" });
  const a = mailbox.exchange(req, "mac", () => executions++);
  expect(mailbox.exchange(req, "mac", () => executions++)).toEqual(a);
  expect(executions).toBe(1);
  expect(mailbox.exchange({ ...req, received: a.sequence }, "mac", () => executions++).data).toBeUndefined();
  expect(executions).toBe(1);
});

test("nested wire records obey both UTF-8 and payload budgets", () => {
  for (const text of ["\\\"\n".repeat(2000), "你好😀".repeat(2000), "A".repeat(6000)]) {
    const mailbox = new Mailbox();
    const line = { t: "hello" as const, proto: TERM_PROTO, name: text };
    mailbox.push(line);
    let received = 0, result = "";
    while (mailbox.busy) {
      const reply = mailbox.exchange({ replica: "test-replica", epoch: "mac", received }, "mac", () => {});
      const payload = JSON.stringify(reply);
      expect(payload.length).toBeLessThanOrEqual(OFFLOAD.payloadChars);
      expect(Buffer.byteLength(JSON.stringify({ id: 1, payload }))).toBeLessThanOrEqual(OFFLOAD.recordBytes);
      if (reply.data) { result += reply.data; received = reply.sequence; }
    }
    expect(JSON.parse(result)).toEqual(line);
  }
});

test("an expired replica or restarted daemon does not replay mutations", () => {
  const mailbox = new Mailbox(); let executed = false;
  const reply = mailbox.exchange({ replica: "test-replica", epoch: "old", received: 9, command: { id: 7, line: { t: "new" } } }, "new", () => executed = true);
  expect(reply.epoch).toBe("new"); expect(executed).toBe(false);
});

test("output overflow retires the replica epoch without crashing the terminal process", () => {
  const mailbox = new Mailbox(), identity = mailbox.identity;
  expect(() => mailbox.push({ t: "hello", proto: TERM_PROTO, name: "x".repeat(LIMITS.lineChars + 1) })).not.toThrow();
  expect(mailbox.identity).not.toBe(identity); expect(mailbox.busy).toBe(false);
  let executed = false;
  mailbox.exchange({ replica: "test-replica", epoch: identity, received: 0, command: { id: 1, line: { t: "new" } } }, mailbox.identity, () => executed = true);
  expect(executed).toBe(false);
});

test("input bypasses held output, batches bursts, and retries identical ids", () => {
  const requests: { method: string; input: any; done: any }[] = [];
  const channel = createTermChannel({ connected: () => true, session: () => 1,
    request(method, payload, done) { requests.push({ method, input: JSON.parse(payload), done }); return requests.length; }, cancel() {} }, "test-replica");
  channel.poll(); requests[0].done({ ok: true, value: JSON.stringify({ epoch: "mac", ack: 0, sequence: 0 }) });
  channel.poll(); // Hold this output request for the entire test.
  const outputCount = requests.filter(r => r.method === "term.exchange").length;
  channel.send({ t: "key", k: "Right" });
  const first = requests.at(-1)!; expect(first.method).toBe("term.input"); expect(first.input.commands[0].id).toBe(1);
  for (let n = 0; n < 7; n++) channel.send({ t: "key", k: "Right" });
  first.done({ ok: false, error: "lost reply" }); channel.poll(); channel.poll();
  const retry = requests.at(-1)!; expect(retry.input.commands.map((c: any) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const mailbox = new Mailbox(); let count = 0;
  mailbox.input(first.input, "mac", () => count++); const reply = mailbox.input(retry.input, "mac", () => count++);
  expect(count).toBe(8); retry.done({ ok: true, value: JSON.stringify(reply) }); channel.poll();
  expect(channel.inputPending!()).toBe(false);
  expect(requests.filter(r => r.method === "term.exchange")).toHaveLength(outputCount);
  expect(channel.sendBatch!(Array.from({ length: LIMITS.commands + 1 }, () => ({ t: "new" })))).toBe(false);
});

test("a malformed input batch is rejected before any new command runs", () => {
  const mailbox = new Mailbox(); let count = 0;
  expect(() => mailbox.input({ replica: "test-replica", epoch: "mac", commands: [
    { id: 1, line: { t: "new" } }, { id: 3, line: { t: "new" } },
  ] }, "mac", () => count++)).toThrow("gap");
  expect(count).toBe(0); expect(mailbox.ack).toBe(0);
});

test("held output still fits when an independent input adds a maximally escaped error", () => {
  const mailbox = new Mailbox();
  mailbox.push({ t: "hello", proto: TERM_PROTO, name: '"\\字'.repeat(1200) });
  const request = { replica: "test-replica", epoch: "mac", received: 0 };
  const first = mailbox.exchange(request, "mac", () => {});
  mailbox.input({ replica: request.replica, epoch: "mac", commands: [{ id: 1, line: { t: "new" } }] }, "mac", () => { throw "\u0000".repeat(120); });
  const retry = mailbox.exchange(request, "mac", () => {});
  expect(retry.data).toBe(first.data); expect(retry.sequence).toBe(first.sequence);
  expect(retry.error).toHaveLength(120); expect(retry.ack).toBe(1);
  expect(fitsRecord(JSON.stringify(retry), "term.exchange", true)).toBe(true);
});

test("a rejected command remains consumed and its error survives later commands in the same batch", () => {
  const mailbox = new Mailbox(); let calls = 0;
  const request = { replica: "test-replica", epoch: "mac", commands: [1, 2].map(id => ({ id, line: { t: "new" as const } })) };
  const reply = mailbox.input(request, "mac", () => { if (++calls === 1) throw new Error("session limit"); });
  expect(reply.ack).toBe(2); expect(reply.error).toContain("session limit");
  expect(mailbox.input(request, "mac", () => calls++)).toEqual(reply); expect(calls).toBe(2);
});

test("retired ticket callbacks cannot replace a newer transport epoch", () => {
  const requests: any[] = [];
  const channel = createTermChannel({ connected: () => true, session: () => 1,
    request(method, payload, done) { requests.push({ method, input: JSON.parse(payload), done }); return requests.length; }, cancel() {} }, "test-replica");
  channel.send({ t: "hello", proto: TERM_PROTO, cols: 80, rows: 24 }); channel.poll();
  requests[0].done({ ok: true, value: JSON.stringify({ epoch: "a", ack: 0, sequence: 0 }) }); channel.poll();
  const old = requests.find(r => r.method === "term.input");
  requests.at(-1).done({ ok: true, value: JSON.stringify({ epoch: "b", ack: 0, sequence: 0 }) });
  old.done({ ok: true, value: JSON.stringify({ epoch: "a", ack: 1 }) });
  expect(channel.poll()).toContainEqual({ t: "transport-reset" });
  expect(requests.at(-1).input.epoch).toBe("b");
});
