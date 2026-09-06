import { mount } from "@pocketjs/framework/solid";
import TermApp from "../../app/app.tsx";
import { TERM_PROTO, type HostLine, type RowUpdate } from "../../shared/protocol.ts";
const ruler = "1234567890".repeat(8);
const rows: RowUpdate[] = Array.from({ length: 24 }, (_, y) => [y, [0, y === 0 || y === 23 ? ruler : `${String(y + 1).padStart(2, "0")}  ${[
  "Pocket Term  |  macOS shell  |  80 columns x 24 rows",
  "$ stty size     24 80",
  "$ git status --short --branch",
  "## feat/offload-terminal-multiplex",
  "  PID TTY      TIME COMMAND",
  " 1042 ttys003  0:00 /bin/zsh -il",
  " 1043 ttys004  0:01 vim main.ts",
  "printf, pipes |, redirects >, ctrl-c, alt-b, F1-F12",
  "!@#$%^&*()_+-=[]{};:'\"\\|,.<>/? ~ `",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz",
  "0O 1Il | 2Z 5S 6G 8B 9g -- pixel glyph distinction",
  "┌──────────────────────┬───────────────────────────────┐",
  "│ SESSION #5           │ restored after reconnect      │",
  "└──────────────────────┴───────────────────────────────┘",
  "██████████████████████████  100%  no horizontal margin",
  "request -> paired offload -> PTY -> libghostty -> rows",
  "$ printf 'hello from another terminal'",
  "hello from another terminal",
  "vim alternate screen / ANSI colors / scrollback",
  "L/R switches sessions; touch arrows page all 32 tabs",
  "$ ",
][(y - 1) % 21]}`.padEnd(80, " ").slice(0, 80), y % 4 === 0 ? 0x81a2be : -1, y === 5 ? 0x243047 : -1]]);
const sessions = Array.from({ length: 12 }, (_, n) => ({ sid: n + 1, title: `zsh #${n + 1}` }));
const queue: string[] = []; let sequence = 0, ack = 0, held: any, response = "", gen = 0;
function push(line: HostLine) {
  const text = JSON.stringify(line);
  for (let i = 0; i < text.length; i += 500) queue.push(JSON.stringify({ data: text.slice(i, i + 500), more: i + 500 < text.length }));
}
(globalThis as any).offload = {
  session: () => 1,
  submit(record: string) {
    const request = JSON.parse(record), input = JSON.parse(request.payload);
    if (input.epoch) {
      if (held && input.received === sequence) held = undefined;
      if (input.command && input.command.id > ack) {
        ack = input.command.id;
        const command = input.command.line;
        if (command.t === "hello" || command.t === "attach") {
          push({ t: "hello", proto: TERM_PROTO, name: "evandeMacBook-Pro" });
          push({ t: "sessions", list: sessions, active: command.sid ?? 5 });
          push({ t: "grid", sid: command.sid ?? 5, gen: ++gen, seq: 0, full: 1, rows, cur: [79, 23, 1] });
        }
      }
      if (!held && queue.length) { held = JSON.parse(queue.shift()!); sequence++; }
    }
    response = JSON.stringify({ id: request.id, payload: JSON.stringify({ epoch: "fixture", ack, sequence, ...held }) }); return true;
  },
  take() { const value = response; response = ""; return value || undefined; },
};
mount(() => <TermApp />);
