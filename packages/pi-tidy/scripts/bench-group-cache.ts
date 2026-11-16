import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { agentRunning } from "../src/live.ts";
import { getTheme } from "../src/theme-access.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { renderGroupedTool } from "../src/tools/tool-group-view.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";

const count = Number(process.argv[2] ?? 1_000);
const rounds = 40;
const width = 100;
const resultLines = 20;
if (!Number.isInteger(count) || count < 1) throw new Error("Usage: node scripts/bench-group-cache.ts [tool-count=1000]");

initTheme("dark");
const theme = getTheme()!;
const ui = { requestRender() {} };
const bash = createBashToolDefinition(process.cwd());
const bodyCache = new WeakMap<object, Map<number, string[]>>();

function measure(expanded: boolean) {
  patchToolBoxFrames({ groupTools: true, groupOpen: expanded, backgroundJobs: false });
  agentRunning.set(false);
  const tools = Array.from({ length: count }, (_, index) => {
    const tool = new ToolExecutionComponent("bash", `${expanded ? "open" : "folded"}-${index}`, { command: `echo history-${index}` }, {}, bash as any, ui as any, process.cwd());
    tool.setExpanded(expanded);
    tool.setArgsComplete();
    tool.markExecutionStarted();
    tool.updateResult({
      content: [{ type: "text", text: Array.from({ length: resultLines }, (_, line) => `result-${index}-${line}`).join("\n") }],
      isError: false,
      durationMs: 20,
    } as any, false);
    return tool;
  });
  const render = (tool: ToolExecutionComponent, index: number) => renderGroupedTool(
    tool as any,
    width,
    theme,
    { icons: false, pinned: false, highlight: false, rowLines: 1 },
    (boxWidth) => {
      let byWidth = bodyCache.get(tool);
      if (!byWidth) bodyCache.set(tool, byWidth = new Map());
      const cached = byWidth.get(boxWidth);
      if (cached) return cached;
      const output = (tool as any).contentBox.render(boxWidth) as string[];
      const body = output.filter((line) => stripVTControlCharacters(line).includes(`result-${index}-`));
      assert.equal(body.length, resultLines, "expanded groups use real Pi tool-result rows");
      byWidth.set(boxWidth, body);
      return body;
    },
  )!;
  const references = tools.map((tool, index) => {
    resetGroups(); // Model each settled tool as the first member/anchor of its historical group.
    return render(tool, index);
  });
  assert.ok(references.every((rows) => rows.length > 0), "each fixture has a historical group row");
  if (expanded) assert.ok(references.every((rows) => rows.some((line) => stripVTControlCharacters(line).includes("result-"))), "opened fixtures draw real result bodies");

  const sample = (active: boolean) => {
    agentRunning.set(active);
    const samples: number[] = [];
    let identityHits = 0;
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      for (let index = 0; index < tools.length; index++) {
        const rows = render(tools[index]!, index);
        if (rows === references[index]) identityHits++;
      }
      samples.push(performance.now() - started);
    }
    for (let index = 0; index < tools.length; index++) {
      assert.deepEqual(render(tools[index]!, index), references[index], "group state changes do not alter settled output");
    }
    samples.sort((a, b) => a - b);
    return {
      medianMs: samples[samples.length >> 1],
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
      rowIdentityHits: identityHits,
      possibleHits: rounds * count,
    };
  };

  const idle = sample(false);
  const whileAgentRuns = sample(true);
  assert.equal(whileAgentRuns.rowIdentityHits, rounds * count, "agent activity must not invalidate settled history rows");
  return { idle, agentRunning: whileAgentRuns };
}

const folded = measure(false);
const opened = measure(true);
console.log(JSON.stringify({
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  width,
  historicalGroups: count,
  resultLines,
  rounds,
  folded,
  opened,
  note: "Both collapsed summaries and expanded groups backed by real Pi tool-result rows are measured. Compare scaling and row-identity hits; absolute timings are informational only.",
}, null, 2));
agentRunning.set(false);
process.exit(0);
