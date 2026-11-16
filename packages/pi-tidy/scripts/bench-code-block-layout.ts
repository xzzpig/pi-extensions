import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { TurnStore, turnOptions, turnStore } from "../src/turns/turn-state.ts";

const turns = Number(process.argv[2] ?? 50);
const codeLines = Number(process.argv[3] ?? 100);
const width = 120;
const warmFrames = 20;
const sampledFrames = 80;
if (!Number.isInteger(turns) || turns < 1 || !Number.isInteger(codeLines) || codeLines < 1) {
  throw new Error("Usage: node scripts/bench-code-block-layout.ts [turns=50] [code-lines=100]");
}

initTheme("dark");
patchToolBoxFrames({ groupTools: true, groupOpen: false, icons: true, splitDiff: false });
let timestamp = 1_760_000_000_000;

function makeTranscript(codeBlocks: boolean) {
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: true,
    replyStyle: "rules",
    codeBlocks,
    splitDiff: false,
    icons: true,
  });
  const store = new TurnStore();
  turnStore.set(store);
  const chat = new Container();
  const answers: AssistantMessageComponent[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const user = { role: "user", content: [{ type: "text", text: `Review module ${turn}` }], timestamp: timestamp++ };
    const source = Array.from({ length: codeLines }, (_, line) => `const value_${turn}_${line} = ${line}; // stable cached code row`)
      .join("\n");
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "code-layout-benchmark",
      timestamp: timestamp++,
      durationMs: 100,
      stopReason: "stop",
      content: [{ type: "text", text: `Review complete.\n\n\`\`\`typescript\n${source}\n\`\`\`` }],
    };
    store.begin(user.timestamp);
    store.note(user as any);
    store.note(message as any);
    store.settle(false, timestamp++);
    chat.addChild(new UserMessageComponent(`Review module ${turn}`));
    const answer = new AssistantMessageComponent(message as any, true);
    answers.push(answer);
    chat.addChild(answer);
  }
  return { chat, answers };
}

function measure(codeBlocks: boolean) {
  const { chat, answers } = makeTranscript(codeBlocks);
  const first = chat.render(width).join("\n");
  const visible = stripVTControlCharacters(first);
  assert.ok(visible.includes("value_0_0"), "fixture has the code body");
  if (codeBlocks) assert.ok(visible.includes("typescript") && !visible.includes("```typescript"), "Tidy frames the code fence");
  else assert.ok(visible.includes("```typescript"), "Pi's original fence is preserved without code framing");
  for (let frame = 0; frame < warmFrames; frame++) chat.render(width);
  const memos = answers.map((answer) => (answer as any)[Symbol.for("pi-tidy:code-blocks")]?.ruleRowsMemo);
  const samples: number[] = [];
  for (let frame = 0; frame < sampledFrames; frame++) {
    const started = performance.now();
    chat.render(width);
    samples.push(performance.now() - started);
  }
  if (codeBlocks) {
    assert.ok(memos.every(Boolean), "each code reply has a derived layout memo");
    assert.ok(answers.every((answer, index) => (answer as any)[Symbol.for("pi-tidy:code-blocks")]?.ruleRowsMemo === memos[index]),
      "steady-state frames reuse every reply's rule-row layout");
  }
  samples.sort((a, b) => a - b);
  return {
    count: turns * 2,
    rows: first.split("\n").length,
    medianMs: samples[samples.length >> 1],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
    layoutMemoHits: codeBlocks ? memos.length : 0,
  };
}

console.log(JSON.stringify({
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  width,
  turns,
  codeLines,
  warmFrames,
  sampledFrames,
  piNativeMarkdown: measure(false),
  tidyCodeBlocks: measure(true),
}, null, 2));
process.exit(0);
