import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { withHexSwatches } from "../src/messages/hex-swatches.ts";
import type { ThemeLike } from "../src/theme-access.ts";

const theme: ThemeLike = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const candidates = [1_000, 2_000, 4_000, 8_000];
const rounds = 7;
const percentile = (values: number[], at: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * at) - 1]!;

const results = candidates.map((count) => {
  const input = "See #not-a-color in this issue. ".repeat(count);
  for (let warm = 0; warm < 2; warm++) assert.equal(withHexSwatches(input, "", theme), input);
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    const output = withHexSwatches(input, "", theme);
    samples.push(performance.now() - started);
    assert.equal(output, input, "invalid color candidates must not alter transcript text");
  }
  return {
    candidates: count,
    characters: input.length,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
});

console.log(JSON.stringify({
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  rounds,
  measurements: results,
  medianDoublingRatios: results.slice(1).map((result, index) => Number((result.medianMs / results[index]!.medianMs).toFixed(2))),
  note: "Informational only; compare scaling trends, not absolute cross-machine thresholds.",
}, null, 2));
