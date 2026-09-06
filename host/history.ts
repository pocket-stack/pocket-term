import { randomUUID } from "node:crypto";
import { HISTORY, type HistoryManifest } from "../shared/history.ts";

/** Only observes boundaries that may replace old rows. Ghostty still parses
 * every byte and owns all terminal state. This survives split sequences and
 * ignores escape-looking text in OSC/DCS strings. A reset followed by enough
 * output in one PTY chunk must not silently reuse earlier row addresses. */
export class HistoryBoundary {
  private state: "ground" | "escape" | "csi" | "string" | "string-escape" = "ground";
  private csi = "";
  private osc: string | undefined;
  private oscOverflow = false;
  private finishString(): boolean {
    const [code, ...params] = (this.osc ?? "").split(";");
    this.osc = undefined;
    // Palette/default-color writes reinterpret already stored cells. Color
    // queries and titles must not repeatedly invalidate an editor's history.
    return ["104", "110", "111"].includes(code) ||
      code === "4" && (this.oscOverflow || params.some((value, n) => n % 2 === 1 && value !== "?")) ||
      ["10", "11"].includes(code) && (this.oscOverflow || params.some(value => value !== "?" && value !== ""));
  }
  feed(text: string): boolean {
    let reset = false;
    for (const ch of text) {
      if (this.state === "string" || this.state === "string-escape") {
        if (ch === "\x07" || ch === "\x9c" || this.state === "string-escape" && ch === "\\") {
          if (this.finishString()) reset = true;
          this.state = "ground";
        } else {
          if (ch !== "\x1b" && this.osc !== undefined) {
            if (this.osc.length < 256) this.osc += ch;
            else this.oscOverflow = true;
          }
          this.state = ch === "\x1b" ? "string-escape" : "string";
        }
        continue;
      }
      if (ch === "\x18" || ch === "\x1a") { this.state = "ground"; continue; }
      if (ch === "\x1b") { this.state = "escape"; continue; }
      if (ch === "\x9b") { this.state = "csi"; this.csi = ""; continue; }
      if (ch === "\x9d") { this.state = "string"; this.osc = ""; this.oscOverflow = false; continue; }
      if (this.state === "escape") {
        if (ch === "[") { this.state = "csi"; this.csi = ""; }
        else if ("]PX^_".includes(ch)) { this.state = "string"; this.osc = ch === "]" ? "" : undefined; this.oscOverflow = false; }
        else { if (ch === "c") reset = true; this.state = "ground"; }
      } else if (this.state === "csi") {
        if (ch >= "@" && ch <= "~") {
          if (ch === "J" && this.csi.split(";").includes("3") ||
              ch === "p" && this.csi === "!" ||
              (ch === "h" || ch === "l") && /^\?/.test(this.csi) && this.csi.slice(1).split(";").some(p => ["3", "47", "1047", "1049"].includes(p))) reset = true;
          this.state = "ground";
        } else if (this.csi.length < 128) this.csi += ch;
        else { reset = true; this.state = "ground"; }
      }
    }
    return reset;
  }
}

export interface HistoryCore { getScrollbackCount(): number; getScrollbackDiscardedCount(): number; usingAltScreen(): boolean }

export class SessionHistory {
  private readonly identity = randomUUID();
  private generation = 0;
  private count = 0;
  private discarded = 0;
  private alternate = false;
  private readonly boundary = new HistoryBoundary();
  private reset = false;
  observe(text: string) { if (this.boundary.feed(text)) this.reset = true; }
  invalidate() { this.reset = true; }
  update(core: HistoryCore): HistoryManifest {
    const count = core.getScrollbackCount(), discarded = core.getScrollbackDiscardedCount(), alternate = core.usingAltScreen();
    if (this.reset || alternate !== this.alternate || discarded < this.discarded || count + discarded < this.count + this.discarded) this.generation++;
    this.reset = false; this.count = count; this.discarded = discarded; this.alternate = alternate;
    return this.manifest();
  }
  manifest(): HistoryManifest {
    const end = this.discarded + this.count;
    return { epoch: `${this.identity}:${this.generation}`, first: this.alternate ? end : Math.max(this.discarded, end - HISTORY.rows), end, alternate: this.alternate };
  }
  /** Ghostty indexes history newest-first; the wire addresses oldest-first. */
  offset(row: number, epoch: string): number {
    const m = this.manifest();
    if (m.alternate || epoch !== m.epoch || !Number.isSafeInteger(row) || row < m.first || row >= m.end) throw new Error("History range expired");
    return m.end - 1 - row;
  }
}
