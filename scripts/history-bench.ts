/** Optional baseline: git show d12e905:app/history.ts > .pocket/before-batch-history.ts */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { historyThroughput } from "../test/history-throughput.ts";
const baselinePath = process.argv.find(arg => arg.startsWith("--baseline="))?.slice(11);
const baseline = baselinePath ? (await import(pathToFileURL(resolve(baselinePath)).href)).createTermHistory : undefined;
console.log(JSON.stringify({ baseline: baselinePath, samples: [[60, false], [20, false], [60, true]].map(([fps, colored]) => ({
  ...(baseline ? { before: historyThroughput(baseline, Number(fps), Boolean(colored)) } : {}),
  current: historyThroughput(undefined, Number(fps), Boolean(colored)),
})) }, null, 2));
