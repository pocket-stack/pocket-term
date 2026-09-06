import { expect, test } from "bun:test";
import { createTermChannel } from "../app/offload.ts";
import { latencyScenario } from "./latency.ts";

test("20 Hz input stays bounded on a 100 ms link without dropping ordered keys", () => {
  const result = latencyScenario(createTermChannel);
  expect(result.inputs).toBe(60); expect(result.ordered).toBe(true); expect(result.unique).toBe(60);
  expect(result.p95Ms).toBeLessThanOrEqual(200); expect(result.peakQueue).toBeLessThanOrEqual(4);
});
