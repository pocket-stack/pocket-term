import { expect, test } from "bun:test";
import { Mailbox } from "../host/exchange.ts";
import { createTermChannel } from "../app/offload.ts";
import { LIMITS, type ExchangeRequest } from "../shared/exchange.ts";
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

test("guest keeps one request in flight, retries the same id, and bounds batches", () => {
  const requests: any[] = []; let callback: any;
  const channel = createTermChannel({ connected: () => true, session: () => 1,
    request(method, payload, done) { requests.push({ method, ...JSON.parse(payload) }); callback = done; return requests.length; }, cancel() {} }, "test-replica");
  channel.send({ t: "new" }); channel.poll(); channel.poll();
  expect(requests.length).toBe(1); expect(requests[0].command).toBeUndefined();
  callback({ ok: true, value: JSON.stringify({ epoch: "mac", ack: 0, sequence: 0 }) });
  channel.poll(); expect(requests[1].command.id).toBe(1);
  callback({ ok: false, error: "lost reply" });
  for (let i = 0; i < 30; i++) channel.poll();
  expect(requests[2].command).toEqual(requests[1].command);
  expect(channel.sendBatch!(Array.from({ length: LIMITS.commands }, () => ({ t: "new" })))).toBe(false);
  callback({ ok: true, value: JSON.stringify({ epoch: "mac", ack: 1, sequence: 0 }) });
  channel.poll(); expect(requests.at(-1).command).toBeUndefined();
});
