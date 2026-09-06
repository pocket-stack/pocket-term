import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TERM_PROTO, type ClientLine, type HostLine, type Run } from "../shared/protocol.ts";
import type { ExchangeReply, ExchangeRequest } from "../shared/exchange.ts";
import type { HistoryManifest, HistoryReply } from "../shared/history.ts";
import { createCursorStick } from "../app/stick.ts";

test("real macOS PTYs: multiplex, resumable history, vim/nano cursor keys and VT modes", { timeout: 45000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-term-pty-"));
  const worker = fork(fileURLToPath(new URL("../host/terminal-worker.ts", import.meta.url)), ["--port", "0", "--no-mirror", "--no-beacon", "--no-login", "--shell", "/bin/sh", "--cwd", directory], {
    env: { ...process.env, HOME: directory }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let log = "";
  let provider: ChildProcess | undefined, native: ReturnType<typeof createServer> | undefined, transport: Socket | undefined;
  worker.stdout!.on("data", data => log += data); worker.stderr!.on("data", data => log += data);
  try {
    const config = await Promise.race([once(worker, "message").then(([message]) => message as { endpoint: string; token: string }), delay(5000).then(() => { throw new Error(`Worker failed to start: ${log}`); })]);
    const unauthorized = await fetch(config.endpoint, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 403);
    // Emulate only the native socket boundary. The actual PocketJS provider,
    // its capability worker, local broker, PTY and libghostty all run here.
    const pairingKey = randomBytes(32).toString("hex");
    let nextRequest = 1;
    const waiting = new Map<number, (reply: any) => void>();
    native = createServer(socket => {
      let buffer = Buffer.alloc(0), paired = false;
      socket.on("data", bytes => {
        buffer = Buffer.concat([buffer, typeof bytes === "string" ? Buffer.from(bytes) : bytes]);
        if (!paired) {
          if (buffer.length < 64) return;
          assert.equal(buffer.subarray(0, 64).toString(), pairingKey);
          buffer = buffer.subarray(64); paired = true; transport = socket;
        }
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
          const length = buffer.readUInt32BE(0);
          const reply = JSON.parse(buffer.subarray(4, 4 + length).toString());
          buffer = buffer.subarray(4 + length);
          waiting.get(reply.id)?.(reply); waiting.delete(reply.id);
        }
      });
    });
    native.listen(0, "127.0.0.1"); await once(native, "listening");
    provider = spawn("bun", [fileURLToPath(new URL("../host/provider.ts", import.meta.url))], {
      env: { ...process.env, POCKET_TERM_PROVIDER: JSON.stringify({ address: "127.0.0.1", port: (native.address() as { port: number }).port, key: pairingKey, ...config }) }, stdio: ["ignore", "pipe", "pipe"],
    });
    provider.stdout!.on("data", data => log += data); provider.stderr!.on("data", data => log += data);
    const capability = async (method: string, request: unknown): Promise<any> => {
      const deadline = Date.now() + 4000;
      while (!transport || transport.destroyed) { if (Date.now() > deadline) throw new Error(`Provider did not connect: ${log}`); await delay(5); }
      const id = nextRequest++;
      const record = Buffer.from(JSON.stringify({ v: 1, id, method, payload: JSON.stringify(request) }));
      const frame = Buffer.alloc(4 + record.length); frame.writeUInt32BE(record.length); record.copy(frame, 4);
      const reply = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Provider reply timeout: ${log}`)); }, 5000);
        waiting.set(id, value => { clearTimeout(timer); resolve(value); }); transport!.write(frame);
      });
      if (reply.error) throw new Error(reply.error); return JSON.parse(reply.payload);
    };
    const post = (request: ExchangeRequest): Promise<ExchangeReply> => capability("term.exchange", request);
    const historyRow = async (sid: number, m: HistoryManifest, row: number): Promise<Run[]> => {
      let raw = "", parts = 1;
      for (let part = 0; part < parts; part++) {
        const p = await capability("term.history", { sid, epoch: m.epoch, row, part }) as HistoryReply;
        assert.equal(p.epoch, m.epoch); assert.equal(p.row, row); assert.equal(p.part, part); parts = p.parts; raw += p.data;
      }
      return JSON.parse(raw);
    };
    class Replica {
      id: string; epoch?: string; received = 0; command = 0; partial = "";
      active = -1; sessions: number[] = []; grid: Run[][] = []; lines: HostLine[] = [];
      history?: HistoryManifest;
      constructor(id: string) { this.id = id; }
      async exchange(line?: ClientLine, loseReply = false) {
        const request: ExchangeRequest = { replica: this.id, epoch: this.epoch, received: this.received, ...(line ? { command: { id: ++this.command, line } } : {}) };
        let reply = await post(request);
        if (loseReply) { transport!.destroy(); const replay = await post(request); if (reply.data) assert.deepEqual(replay, reply); else { assert.equal(replay.ack, reply.ack); assert.equal(replay.epoch, reply.epoch); } reply = replay; }
        assert.equal(reply.error, undefined);
        this.epoch = reply.epoch;
        if (reply.data && reply.sequence > this.received) {
          assert.equal(reply.sequence, this.received + 1); this.received = reply.sequence; this.partial += reply.data;
          if (!reply.more) {
            const message = JSON.parse(this.partial) as HostLine; this.partial = ""; this.lines.push(message);
            if (message.t === "sessions") { this.sessions = message.list.map(s => s.sid); this.active = message.active; }
            if (message.t === "grid") { for (const [y, ...runs] of message.rows) this.grid[y] = runs; if (message.history) this.history = message.history; }
          }
        }
        return reply;
      }
      text() { return this.grid.map(row => row.map(run => run[1]).join("")).join("\n"); }
      async until(predicate: () => boolean) {
        const deadline = Date.now() + 6000;
        while (!predicate()) { if (Date.now() > deadline) throw new Error(`Terminal timeout: ${this.text()}\n${log}`); await this.exchange(); await delay(5); }
      }
    }
    const first = new Replica("integration-device-one");
    await first.exchange();
    await first.exchange({ t: "hello", proto: TERM_PROTO, cols: 80, rows: 24, cell: [5, 10] });
    await first.until(() => first.active > 0);
    const sid1 = first.active;
    await first.exchange({ t: "ch", s: `PS1=''; cd '${directory}'; stty size\r` });
    await first.until(() => first.text().includes("24 80"));
    await first.exchange({ t: "ch", s: `printf x >> '${directory}/once'; printf '\\033[2J\\033[H__FIRST__\\n'\r` }, true);
    await first.until(() => first.text().includes("__FIRST__"));
    await delay(100); assert.equal(readFileSync(join(directory, "once"), "utf8"), "x");
    await first.exchange({ t: "new" }, true);
    await first.until(() => first.sessions.length === 2 && first.active !== sid1);
    const sid2 = first.active;
    await first.exchange({ t: "ch", s: "printf '\\033[2J\\033[H__SECOND__\\n'\r" });
    await first.until(() => first.text().includes("__SECOND__"));
    // A new guest realm names its prior session; existing processes survive.
    const reconnected = new Replica("integration-device-two"); await reconnected.exchange();
    await reconnected.exchange({ t: "hello", proto: TERM_PROTO, cols: 80, rows: 24, cell: [5, 10], want: sid1 });
    await reconnected.until(() => reconnected.active === sid1 && reconnected.text().includes("__FIRST__"));
    assert.equal(first.active, sid2);
    // Input is sent raw; a multi-character escape sequence is not a paste.
    await reconnected.exchange({ t: "ch", s: "printf '\\033[?1049h\\033[H\\033[31mALT_SCREEN\\033[0m\\033[24;80HX'\r" });
    await reconnected.until(() => reconnected.grid[23]?.some(run => run[0] === 79 && run[1] === "X") ?? false);
    assert(reconnected.grid[0].some(run => run[1].includes("ALT_SCREEN") && run[2] >= 0));
    await reconnected.exchange({ t: "ch", s: "printf '\\033[?1049l'\r" });
    await reconnected.until(() => reconnected.text().includes("__FIRST__"));
    // Buffered paste commits once at the explicit end, even across retries.
    await reconnected.exchange({ t: "paste", s: "printf PASTE_", phase: "start" }, true);
    await reconnected.exchange({ t: "paste", s: "OK > pasted\n", phase: "end" }, true);
    await delay(100); assert.equal(readFileSync(join(directory, "pasted"), "utf8"), "PASTE_OK");
    await reconnected.exchange({ t: "ch", s: "printf '你好 café\\n'\r" });
    await reconnected.until(() => reconnected.lines.some(line => line.t === "atlas"));
    // An application in raw mode receives terminal query replies and one
    // bracketed paste, rather than shell echo being mistaken for acceptance.
    writeFileSync(join(directory, "query.py"), `import os,tty,termios,select\nold=termios.tcgetattr(0)\ntty.setraw(0)\nos.write(1,b'\\x1b[6n')\nreply=b''\nwhile not reply.endswith(b'R'):\n if not select.select([0],[],[],3)[0]: raise Exception('query timeout')\n reply+=os.read(0,100)\nopen('query-reply','wb').write(reply)\nos.write(1,b'\\x1b[?2004hPASTE_READY')\ndata=b''\nwhile not data.endswith(b'\\x1b[201~'):\n if not select.select([0],[],[],5)[0]: raise Exception('paste timeout')\n data+=os.read(0,4096)\nopen('paste-bytes','wb').write(data)\nos.write(1,b'\\x1b[?2004lPASTE_DONE')\ntermios.tcsetattr(0,termios.TCSANOW,old)\n`);
    await reconnected.exchange({ t: "ch", s: "python3 query.py\r" });
    await reconnected.until(() => reconnected.text().includes("PASTE_READY"));
    assert.match(readFileSync(join(directory, "query-reply"), "utf8"), /^\x1b\[\d+;\d+R$/);
    await reconnected.exchange({ t: "paste", s: "hello\n", phase: "start" });
    await reconnected.exchange({ t: "paste", s: "world", phase: "end" });
    await reconnected.until(() => reconnected.text().includes("PASTE_DONE"));
    assert.equal(readFileSync(join(directory, "paste-bytes"), "utf8"), "\x1b[200~hello\nworld\x1b[201~");
    // Real editor sessions receive the same named keys emitted by the right
    // stick. File contents prove cursor movement, not just PTY echo.
    for (const editor of ["vim", "nano"]) {
      const path = join(directory, `${editor}.txt`); writeFileSync(path, "alpha\nbeta\n");
      await reconnected.exchange({ t: "ch", s: editor === "vim" ? "vim -Nu NONE -n vim.txt\r" : "nano nano.txt\r" });
      await reconnected.until(() => !!reconnected.history?.alternate && reconnected.text().includes("beta"));
      const stick = createCursorStick();
      await reconnected.exchange({ t: "key", k: stick.step(0, 0.9)! }); stick.step(0, 0);
      await reconnected.exchange({ t: "key", k: stick.step(0.9, 0)! });
      await reconnected.exchange({ t: "ch", s: editor === "vim" ? "iX" : "X" });
      if (editor === "vim") {
        await reconnected.exchange({ t: "key", k: "Escape" }); await reconnected.exchange({ t: "ch", s: ":wq\r" });
      } else {
        await reconnected.exchange({ t: "key", k: "o", ctrl: 1 }); await reconnected.exchange({ t: "key", k: "Enter" });
        await reconnected.exchange({ t: "key", k: "x", ctrl: 1 });
      }
      await reconnected.until(() => reconnected.history?.alternate === false);
      assert.equal(readFileSync(path, "utf8"), "alpha\nbXeta\n");
    }
    await reconnected.exchange({ t: "ch", s: "printf '\\033[3J\\033[2J\\033[H'; i=0; while [ \"$i\" -lt 150 ]; do printf 'row-%03d\\n' \"$i\"; i=$((i+1)); done\r" });
    await reconnected.until(() => reconnected.text().includes("row-149") && (reconnected.history?.end ?? 0) >= 100);
    const history = { ...reconnected.history! }, address = history.first + 3;
    const original = await historyRow(sid1, history, address);
    assert.equal(original.map(r => r[1]).join(""), "row-003");
    const newest = await historyRow(sid1, history, history.end - 1);
    assert(newest.map(r => r[1]).join("").startsWith("row-"));
    await reconnected.exchange({ t: "ch", s: "printf 'more\\nmore\\nmore\\nmore\\n'\r" });
    await reconnected.until(() => (reconnected.history?.end ?? 0) > history.end);
    assert.equal(reconnected.history!.epoch, history.epoch); assert.deepEqual(await historyRow(sid1, history, address), original);
    transport!.destroy(); // historical addresses outlive the provider worker
    assert.deepEqual(await historyRow(sid1, history, address), original);
    await reconnected.exchange({ t: "ch", s: "printf '\\033[3JHISTORY_CLEARED\\n'\r" });
    await reconnected.until(() => reconnected.history?.epoch !== history.epoch);
    await assert.rejects(historyRow(sid1, history, address), /expired/);
    await first.exchange({ t: "kill", sid: sid2 }); await first.until(() => first.sessions.length === 1 && first.active === sid1);
    await first.exchange({ t: "kill", sid: sid1 }); await first.until(() => first.sessions.length === 0 && first.active === -1);
    await first.exchange({ t: "new" }); await first.until(() => first.sessions.length === 1 && first.active > sid2);
  } finally {
    provider?.kill(); if (provider && provider.exitCode === null && provider.signalCode === null) await once(provider, "exit"); transport?.destroy(); native?.close();
    worker.kill(); if (worker.exitCode === null && worker.signalCode === null) await once(worker, "exit"); rmSync(directory, { recursive: true, force: true });
  }
});
