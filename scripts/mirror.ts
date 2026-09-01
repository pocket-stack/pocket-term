// bun run mirror — build the Mac/Linux mirror window: the guest bundle plus
// the stock PocketJS desktop host it runs on.
//
// The daemon spawns one of these per session (host/serve.ts openMirror), so
// this script only builds; nothing is launched here. The bundle must land in
// THIS repository's dist, because that is the POCKETJS_DIST the daemon passes
// to the host.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { passThrough } from "./run.ts";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve.ts";
import { DIST, PLAN_DIR, ROOT, VENDOR } from "./paths.ts";

const target = process.platform === "darwin" ? "macos-app" : "linux-app";
const manifest = JSON.parse(readFileSync(resolve(ROOT, "pocket.mirror.json"), "utf8"));
const resolution = validateAndResolveBuildPlan(manifest, { target });
if (!resolution.ok) {
  throw new Error(
    `pocket-term: the mirror did not resolve against ${target}: ${resolution.diagnostics
      .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
      .join("; ")}`,
  );
}
const plan = resolution.plan;

mkdirSync(PLAN_DIR, { recursive: true });
const planPath = resolve(PLAN_DIR, `${plan.app.output}.${target}.plan.json`);
writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

mkdirSync(DIST, { recursive: true });
await passThrough($`bun ${VENDOR}/tools/build.ts --plan=${planPath} --project-root=${ROOT} --outdir=${DIST}`.cwd(ROOT));
await passThrough($`cargo build --release --locked`.cwd(`${VENDOR}/hosts/desktop`));

console.log(`pocket-term: built ${plan.app.output} for ${target} + the desktop host`);
