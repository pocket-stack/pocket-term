import { expect, test } from "bun:test";
import { createTypingPrediction, type TypingPreview } from "../app/prediction.ts";
import type { Cursor, Run } from "../shared/protocol.ts";

function fixture() {
  let cursor: Cursor = [2, 0, 1], text = "$ ", preview: TypingPreview | undefined;
  const p = createTypingPrediction(() => [[0, text, -1, -1]], () => cursor, next => preview = next);
  return { p, view: () => preview, set(value: string, x: number) { text = value; cursor = [x, 0, 1]; } };
}

test("typing preview learns actual echoes, renders immediately and removes confirmed prefixes", () => {
  const f = fixture();
  for (let n = 0; n < 2; n++) {
    f.p.input({ t: "ch", s: "a" }, n + 1, n * 40); expect(f.view()).toBeUndefined();
    f.set("$ " + "a".repeat(n + 1), 3 + n); f.p.authoritative(n + 1, n * 40 + 20);
  }
  f.p.input({ t: "ch", s: "b" }, 3, 100); expect(f.view()?.text).toEqual({ x: 4, y: 0, value: "b" });
  f.p.input({ t: "ch", s: "c" }, 4, 120); expect(f.view()?.text?.value).toBe("bc");
  f.set("$ aab", 5); f.p.authoritative(4, 140); expect(f.view()?.text?.value).toBe("c");
  f.set("$ aabc", 6); f.p.authoritative(4, 160); expect(f.view()).toBeUndefined();
  f.p.input({ t: "ch", s: "d" }, 5, 180); expect(f.view()).toBeDefined();
  f.p.frame(540); expect(f.view()).toBeUndefined();
});

test("write acknowledgement alone cannot enable echo; password-like silence and timeouts stay hidden", () => {
  const f = fixture();
  f.p.input({ t: "ch", s: "s" }, 1, 0); f.p.authoritative(1, 100);
  f.p.input({ t: "ch", s: "e" }, 2, 120); f.p.authoritative(2, 150);
  expect(f.view()).toBeUndefined(); f.p.frame(500); expect(f.view()).toBeUndefined();
  f.p.input({ t: "key", k: "Enter" }, 3, 510); f.p.input({ t: "ch", s: "x" }, 4, 520);
  expect(f.view()).toBeUndefined();
});

test("control transitions, mismatched output and wrapped/wide rows revoke predictions", () => {
  const f = fixture();
  f.p.input({ t: "ch", s: "a" }, 1, 0); f.set("$ a", 3); f.p.authoritative(1, 20);
  f.p.input({ t: "ch", s: "b" }, 2, 40); f.set("$ ab", 4); f.p.authoritative(2, 60);
  f.p.input({ t: "ch", s: "c" }, 3, 80); expect(f.view()).toBeDefined();
  f.set("unexpected", 0); f.p.authoritative(3, 100); expect(f.view()).toBeUndefined();
  f.p.input({ t: "ch", s: "x" }, 4, 120); expect(f.view()).toBeUndefined();
  f.p.input({ t: "key", k: "Escape" }, 5, 130); expect(f.view()).toBeUndefined();
  let result: TypingPreview | undefined;
  const wide: Run[] = [[0, "字", -1, -1, 19, 2]];
  const p = createTypingPrediction(() => wide, () => [79, 0, 1], value => result = value);
  p.input({ t: "ch", s: "x" }, 1, 0); expect(result).toBeUndefined();
});

test("learned cursor motion is provisional and never writes cells", () => {
  let cursor: Cursor = [0, 0, 1], preview: TypingPreview | undefined;
  const row: Run[] = [[0, "alpha beta", -1, -1]];
  const p = createTypingPrediction(() => row, () => cursor, value => preview = value);
  for (let n = 1; n <= 2; n++) { p.input({ t: "key", k: "Right" }, n, n * 40); cursor = [n, 0, 1]; p.authoritative(n, n * 40 + 20); }
  p.input({ t: "key", k: "Right" }, 3, 130); expect(preview?.cursor).toEqual([3, 0, 1]); expect(cursor).toEqual([2, 0, 1]);
  expect(row[0][1]).toBe("alpha beta"); p.enabled(false); expect(preview).toBeUndefined();
});

test("a command submission revokes trained echo before a silent password prompt", () => {
  const f = fixture();
  for (let n = 0; n < 2; n++) {
    f.p.input({ t: "ch", s: "a" }, n + 1, n * 40); f.set("$ " + "a".repeat(n + 1), 3 + n); f.p.authoritative(n + 1, n * 40 + 20);
  }
  f.p.input({ t: "ch", s: "b" }, 3, 100); expect(f.view()).toBeDefined();
  f.p.input({ t: "key", k: "Enter" }, 4, 110); expect(f.view()).toBeUndefined(); f.set("Password: ", 10);
  for (let n = 0; n < 5; n++) { f.p.input({ t: "ch", s: "s" }, 5 + n, 520 + n * 10); f.p.authoritative(5 + n, 525 + n * 10); expect(f.view()).toBeUndefined(); }
});
