// bun run push [--host <ip>] — rebuild the guest package and hot-push it to a
// paired console over the Pocket Runtime dev wire. The native binary is not
// touched, so this is the loop for app changes; a change under
// vendor/pocketjs/hosts/3ds needs `bun run 3ds` and a reflash.
//
// Device keys are per-checkout and the dev tool keeps them beside itself,
// inside the submodule — where a re-clone loses them. Keep yours in this
// repository's .pocket/devices/ (git-ignored) and this script plants them
// where the tool looks before delegating.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { DIST_3DS, ROOT, VENDOR } from "./paths.ts";

const keys = resolve(ROOT, ".pocket/devices");
if (existsSync(keys)) {
  const vendorKeys = resolve(VENDOR, ".pocket/3ds/devices");
  mkdirSync(vendorKeys, { recursive: true });
  for (const name of readdirSync(keys).filter((entry) => entry.endsWith(".key"))) {
    copyFileSync(resolve(keys, name), resolve(vendorKeys, name));
  }
}

await $`bun ${import.meta.dir}/3ds.ts --pocket-only`.cwd(ROOT);
await $`bun ${VENDOR}/tools/3ds-dev.ts push --package ${DIST_3DS}/pocketterm-main.pocket ${process.argv.slice(2)}`.cwd(
  ROOT,
);
