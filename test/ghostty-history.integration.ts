import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GhosttyCore } from "../host/node_modules/@wterm/ghostty/dist/index.js";
import { SessionHistory } from "../host/history.ts";

test("pinned libghostty history addresses remain correct across native page pruning and same-chunk resets", async () => {
  const wasm = readFileSync(new URL("../host/node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm", import.meta.url));
  const core = await GhosttyCore.load({ wasmPath: `data:application/wasm;base64,${wasm.toString("base64")}`, scrollbackLimit: 2000 });
  core.init(80, 24); const history = new SessionHistory();
  const write = (text: string) => { history.observe(text); core.writeString(text); return history.update(core); };
  const row = (id: number, epoch: string) => Array.from({ length: 12 }, (_, x) => String.fromCodePoint(core.getScrollbackCell(history.offset(id, epoch), x).char)).join("").trim();
  let m = history.update(core), epoch = m.epoch;
  for (let chunk = 0; chunk < 10; chunk++) {
    m = write(Array.from({ length: 1000 }, (_, n) => `line-${chunk * 1000 + n}\r\n`).join(""));
    assert.equal(m.epoch, epoch); assert.equal(m.end, (chunk + 1) * 1000 - 23);
    assert.equal(row(m.first, epoch), `line-${m.first}`);
    assert.equal(row(m.end - 1, epoch), `line-${m.end - 1}`);
  }
  assert(m.first > 0); assert.throws(() => row(0, epoch), /expired/);
  const pinned = m.end - 10, content = row(pinned, epoch);
  m = write("tail-a\r\ntail-b\r\n"); assert.equal(row(pinned, epoch), content);
  const reset = write("\x1b[3J" + "replacement\r\n".repeat(1500));
  assert.notEqual(reset.epoch, epoch); assert.throws(() => row(pinned, epoch), /expired/);
  epoch = reset.epoch; const alternate = write("\x1b[?1049hvim\x1b[?1049l");
  assert.notEqual(alternate.epoch, epoch); assert.equal(alternate.alternate, false);
});
