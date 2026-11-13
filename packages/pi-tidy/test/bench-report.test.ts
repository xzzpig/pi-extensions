import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { comparisonRow, headOnlyRow, median, percentile, scenario, type Measurement, type Scenario } from "../scripts/bench-compare.ts";

const measurement = (samples: number[]): Scenario => ({ count: 100, mode: "folded", rows: 40, samples, workers: samples });

test("benchmark fixture renders real folded and expanded tool outputs", () => {
  const worker = fileURLToPath(new URL("../scripts/bench-render.ts", import.meta.url));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [folded, expanded] = ["folded", "expanded"].map((mode) => JSON.parse(execFileSync(
    process.execPath, [worker, root, "10", mode], { encoding: "utf8", timeout: 30_000 },
  )) as Measurement);
  assert.ok(folded.rows > 0);
  assert.ok(expanded.rows > folded.rows);
  for (const run of [folded, expanded]) {
    assert.equal(run.count, 10);
    assert.equal(run.samples.length, 80);
    assert.ok(run.samples.every((value) => Number.isFinite(value) && value > 0));
  }
});

test("the opened states render a real rail, group rows and second rows", () => {
  const worker = fileURLToPath(new URL("../scripts/bench-render.ts", import.meta.url));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [one, two, large] = ([["opened", "50"], ["opened-2", "50"], ["opened-large", "50"]] as const).map(([mode, count]) => JSON.parse(execFileSync(
    process.execPath, [worker, root, count, mode], { encoding: "utf8", timeout: 30_000 },
  )) as Measurement);
  assert.ok(two!.rows > one!.rows, "toolRowLines 2 must draw the long commands' second rows");
  assert.equal(large!.count, 50);
  assert.ok(large!.rows > 0);
});

test("benchmark percentiles use nearest rank without mutating samples", () => {
  const samples = [4, 1, 3, 2];
  assert.equal(percentile(samples, 0.5), 2);
  assert.equal(percentile(samples, 0.95), 4);
  assert.deepEqual(samples, [4, 1, 3, 2]);
  for (const invalid of [[], [NaN], [Infinity], [-1]]) assert.throws(() => percentile(invalid, 0.5));
});

test("workers merge into one scenario, and only a consistent one", () => {
  const run = (rows: number, samples: number[]): Measurement => ({ count: 100, mode: "folded", rows, samples });
  const merged = scenario([run(40, [1, 2, 3]), run(40, [5, 6, 7])]);
  assert.deepEqual(merged.workers, [2, 6]);
  assert.equal(merged.samples.length, 6);
  assert.equal(median(merged.workers), 4);
  assert.throws(() => scenario([run(40, [1]), run(41, [1])]));
  assert.throws(() => scenario([]));
});

test("the report says whether worker ranges overlap", () => {
  const workers = (values: number[]): Scenario => ({ ...measurement(values), workers: values });
  const overlapping = comparisonRow(workers([2, 3]), workers([2.5, 4]));
  assert.match(overlapping, /2\.000–3\.000 → 2\.500–4\.000 \| yes/);
  assert.match(comparisonRow(workers([2, 3]), workers([4, 5])), /\| \*\*no\*\* \|/);
  assert.match(headOnlyRow(workers([2, 3])), /— → 2\.000–3\.000/);
});

test("benchmark comparison reports signed absolute and relative changes", () => {
  assert.match(comparisonRow(measurement([2]), measurement([3])), /\+1\.000 ms \(\+50\.0%\)/);
  assert.match(comparisonRow(measurement([2]), measurement([1])), /-1\.000 ms \(-50\.0%\)/);
  assert.match(comparisonRow(measurement([0]), measurement([1])), /n\/a/);
  const changed = { ...measurement([2]), rows: 50 };
  assert.match(comparisonRow(measurement([2]), changed), /40 → 50/);
  assert.throws(() => comparisonRow(measurement([1]), { ...changed, mode: "expanded" }));
  assert.throws(() => comparisonRow(measurement([1]), { ...changed, count: 500 }));
});
