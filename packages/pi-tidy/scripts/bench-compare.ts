import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Measurement {
  count: number;
  mode: string;
  rows: number;
  samples: number[];
}

/** One revision in one state, over several worker processes. */
export interface Scenario extends Measurement {
  /** Each worker's median. Identical code can differ by a third between processes, so this is the noise to read a change against. */
  workers: number[];
}

/** First line of the PR comment, so the next run patches it instead of adding one. */
export const COMMENT_MARKER = "<!-- pi-tidy-bench -->";

export function percentile(samples: number[], fraction: number): number {
  if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid timing samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("Invalid timing samples");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Merge one revision's workers. Throws if they did not render the same scenario. */
export function scenario(runs: Measurement[]): Scenario {
  if (!runs.length || runs.some((run) => run.count !== runs[0]!.count || run.mode !== runs[0]!.mode || run.rows !== runs[0]!.rows)) {
    throw new Error("Benchmark worker returned an inconsistent scenario");
  }
  return { ...runs[0]!, samples: runs.flatMap((run) => run.samples), workers: runs.map((run) => percentile(run.samples, 0.5)) };
}

const range = (workers: number[]) => `${Math.min(...workers).toFixed(3)}–${Math.max(...workers).toFixed(3)}`;

export function comparisonRow(base: Scenario, head: Scenario): string {
  if (base.count !== head.count || base.mode !== head.mode) throw new Error("Benchmark scenarios do not match");
  const before = median(base.workers);
  const after = median(head.workers);
  const signed = (n: number, digits: number) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
  const percent = before > 0 ? `${signed((after / before - 1) * 100, 1)}%` : "n/a";
  const overlap = Math.min(...head.workers) <= Math.max(...base.workers) && Math.min(...base.workers) <= Math.max(...head.workers);
  return `| ${base.mode} | ${base.count} | ${base.rows} → ${head.rows} | ${before.toFixed(3)} | ${after.toFixed(3)} | ${signed(after - before, 3)} ms (${percent}) | ${range(base.workers)} → ${range(head.workers)} | ${overlap ? "yes" : "**no**"} | ${percentile(base.samples, 0.95).toFixed(3)} → ${percentile(head.samples, 0.95).toFixed(3)} |`;
}

/**
 * A scenario the base revision cannot render — turn folding arrived in 0.7.0,
 * so a PR against an older base has no number to compare with. Its absolute
 * cost is still worth reporting, and the table keeps its shape.
 */
export function headOnlyRow(head: Scenario): string {
  return `| ${head.mode} | ${head.count} | — → ${head.rows} | — | ${median(head.workers).toFixed(3)} | — | — → ${range(head.workers)} | — | — |`;
}

/** Workers per revision. Two let one report show +28% between identical revisions. */
const ROUNDS = 4;
/** What a state needs turn folding for, and the sizes it is measured at. 100 components says little about these. */
const TURN_STATES = ["turns", "opened", "opened-2", "opened-large"];
const STATES: [mode: string, counts: number[]][] = [
  ["folded", [100, 500, 1500]], ["turns", [100, 500, 1500]], ["expanded", [100, 500, 1500]],
  ["opened", [500, 1500]], ["opened-2", [500, 1500]], ["opened-large", [500, 1500]],
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseRoot = process.argv[2];
  if (!baseRoot) throw new Error("Usage: node scripts/bench-compare.ts <base-checkout> [head-checkout]");
  const headRoot = resolve(process.argv[3] ?? ".");
  const roots = [resolve(baseRoot), headRoot];
  const sha = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5000 }).trim();
  const revisions = roots.map(sha);
  const worker = fileURLToPath(new URL("bench-render.ts", import.meta.url));
  // Turn folding arrived in 0.7.0: an older base has no module to render it with.
  const baseHasTurns = ["turn-state.ts", "src/turns/turn-state.ts"].some((file) => existsSync(resolve(roots[0]!, file)));
  const results: ({ base: Scenario; head: Scenario } | { head: Scenario })[] = [];
  const measure = (index: number, count: number, mode: string): Measurement =>
    JSON.parse(execFileSync(process.execPath, [worker, roots[index]!, String(count), mode], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
    }));
  for (const [mode, counts] of STATES) {
    for (const count of counts) {
      if (TURN_STATES.includes(mode) && !baseHasTurns) {
        results.push({ head: scenario(Array.from({ length: ROUNDS }, () => measure(1, count, mode))) });
        console.error(`Measured ${count} components, ${mode} (PR only)`);
        continue;
      }
      const measurements: Measurement[][] = [[], []];
      // Swap the order every round so one revision is not always measured first.
      for (let round = 0; round < ROUNDS; round++) for (const index of round % 2 ? [1, 0] : [0, 1]) {
        measurements[index]!.push(measure(index, count, mode));
      }
      results.push({ base: scenario(measurements[0]!), head: scenario(measurements[1]!) });
      console.error(`Measured ${count} components, ${mode}`);
    }
  }
  const metadata = {
    base: revisions[0], head: revisions[1], node: process.version,
    platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model,
    width: 120, warmupFrames: 20, sampledFramesPerWorker: 80, rounds: ROUNDS,
  };
  const report = [
    "## Transcript render benchmark", "",
    `Base: \`${metadata.base}\` · PR: \`${metadata.head}\``, "",
    `${metadata.node} · ${metadata.platform} · ${metadata.cpu} · width ${metadata.width}`, "",
    "| State | Components | Rows base → PR | Base median (ms) | PR median (ms) | Median change | Worker range base → PR (ms) | Ranges overlap | P95 base → PR (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((result) => "base" in result ? comparisonRow(result.base, result.head) : headOnlyRow(result.head)), "",
    ...("base" in results[0]! ? [] : ["Turn folding is newer than this PR's base; its rows only carry the PR's own numbers.", ""]),
    "Same PR-owned fixture and installed dependencies for both revisions; separate processes, alternating order.",
    `Each worker warms up 20 frames, then samples 80 frames; ${ROUNDS} workers per revision and scenario. A median is the median of the workers' medians.`,
    "Identical code can differ by a third between processes, so a change whose worker ranges overlap is not evidence of anything.",
    "Measures warm transcript render() only, not terminal drawing or scroll latency.",
    "Folded means every tool output closed, turns means each run folded to its summary, expanded means all tool outputs open.",
    "Opened means each run and its group open with a row per call, on the rail; opened-2 adds toolRowLines: 2; opened-large has 23 calls per group.",
    "Positive changes mean slower. Small differences may be runner noise; timing changes do not fail CI.", "",
  ].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  // One comment per PR that each run overwrites; the marker is how it is found again.
  if (process.env.BENCH_COMMENT) writeFileSync(process.env.BENCH_COMMENT, `${COMMENT_MARKER}\n${report}`);
  if (process.env.BENCH_OUTPUT) writeFileSync(process.env.BENCH_OUTPUT, JSON.stringify({ ...metadata, results }, null, 2));
}
