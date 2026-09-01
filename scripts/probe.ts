// bun run probe [--host <ip>] [--out shot.png] — one round trip to a running
// console: runtime status, device stats, the mounted tree and a screenshot of
// both displays. The same key-planting as push.ts, then the vendored tool.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { passThrough } from "./run.ts";
import { ROOT, VENDOR } from "./paths.ts";

const keys = resolve(ROOT, ".pocket/devices");
if (existsSync(keys)) {
  const vendorKeys = resolve(VENDOR, ".pocket/3ds/devices");
  mkdirSync(vendorKeys, { recursive: true });
  for (const name of readdirSync(keys).filter((entry) => entry.endsWith(".key"))) {
    copyFileSync(resolve(keys, name), resolve(vendorKeys, name));
  }
}

await passThrough($`bun ${VENDOR}/tools/3ds-dev.ts probe ${process.argv.slice(2)}`.cwd(ROOT));
