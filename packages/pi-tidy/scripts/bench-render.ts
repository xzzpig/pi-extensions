import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, initTheme,
  createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createCodemodeExtension,
  type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";

// The driver always comes from the PR; only Tidy's modules change between revisions.
const [root, countArg, mode] = process.argv.slice(2);
const count = Number(countArg);
const opened = mode === "opened" || mode === "opened-2" || mode === "opened-large";
// A large group has 23 calls plus a pinned edit, about what a long real reply makes.
const perTurn = mode === "opened-large" ? 50 : 10;
if (!root || !Number.isInteger(count) || count < perTurn || count % perTurn
  || !["folded", "expanded", "turns", "opened", "opened-2", "opened-large"].includes(mode as string)) {
  throw new Error("Usage: node scripts/bench-render.ts <checkout> <components: multiple of 10, or 50 for opened-large> <folded|expanded|turns|opened|opened-2|opened-large>");
}
// A base from before the move to src/ keeps its modules at the root; the name is the same in both.
const nested = existsSync(resolve(root, "src/index.ts"));
const located = (dir: string, file: string) => resolve(root, nested ? `src/${dir}${file}` : file);
const load = (dir: string, file: string) => import(pathToFileURL(located(dir, file)).href);
const { patchToolBoxFrames, patchContainerBoxes } = await load("", "frame.ts");
const { tidyEnabled, agentRunning } = await load("", "live.ts");
const { resetGroups } = await load("tools/", "tool-groups.ts");
const { codemodeSections } = await load("tools/", "codemode-body.ts");
// Turn folding arrived in 0.7.0: a base that predates it still has to render
// folded and expanded, so the module is optional and only `turns` insists.
const turnModule = existsSync(located("turns/", "turn-state.ts")) ? await load("turns/", "turn-state.ts") : undefined;
initTheme("dark");
tidyEnabled.set(true);
agentRunning.set(false);
patchToolBoxFrames({
  icons: true, groupTools: true, splitDiff: true, diffLines: 20, backgroundJobs: false,
  // An opened run shows one row per call, as after clicking its group open.
  groupOpen: opened, toolRowLines: mode === "opened-2" ? 2 : 1,
});
patchContainerBoxes({ user: "toolTitle" }, { icons: true, includeUser: true, enabled: true });
resetGroups();

const cwd = "/workspace/tidy-benchmark";
const ui = { requestRender() {} } as unknown as TUI;
const definitions: Record<string, ToolDefinition<any, any>> = {
  bash: createBashToolDefinition(cwd), read: createReadToolDefinition(cwd), edit: createEditToolDefinition(cwd),
};
createCodemodeExtension()({ registerTool: (tool: ToolDefinition<any, any>) => { definitions.codemode = tool; } } as ExtensionAPI);
const chat = new Container();
const tools: ToolExecutionComponent[] = [];
const scripts: ToolExecutionComponent[] = [];
// The fixture also feeds a turn store, the way pi's events do: `turns` mode folds
// on top of it, and the other modes simply never enable the fold. Timestamps are
// the message identity, so every message gets its own.
const store = turnModule?.turnStore.get();
let clock = 1_760_000_000_000;
const stamp = () => ({ timestamp: (clock += 1000), provider: "anthropic", model: "claude-sonnet-4.5", durationMs: 900 });
const assistant = (content: any[], stopReason = "stop") => {
  const message = { role: "assistant", content, stopReason, ...stamp() };
  store?.note(message as any);
  return new AssistantMessageComponent(message as any, true);
};
const calls = mode === "opened-large"
  ? [...Array.from({ length: 23 }, (_, call) => ["bash", "bash", "read"][call % 3]!), "edit"]
  : ["read", "bash", "codemode", "edit"];
for (let turn = 0; turn < count / perTurn; turn++) {
  const path = `${cwd}/src/module-${turn}.ts`;
  store?.begin();
  store?.note({ role: "user", content: [{ type: "text", text: `Check module ${turn}` }], ...stamp() } as any);
  chat.addChild(new UserMessageComponent(`Check module ${turn}, inspect its tests, then fix the result. 检查边界情况。`));
  chat.addChild(assistant([{ type: "text", text: `## Module ${turn}\n\nI will inspect the implementation and its tests.` }]));
  for (const [index, name] of calls.entries()) {
    const id = `call-${turn}-${index}-${name}`;
    // Too long for one row, so `opened-2` draws the second one and `opened` clips the same text.
    const args = name === "bash" ? { command: opened
        ? `cd ${cwd} && pnpm test --filter module-${turn}-${index} --reporter=verbose --coverage --bail=1 && git diff --stat -- src/module-${turn}.ts test/module-${turn}.test.ts | tail -20`
        : `pnpm test --filter module-${turn}` }
      : name === "codemode" ? { code: `const source = await tools.read({ path: "${path}" });\nawait tools.bash({ command: "pnpm lint" });\ntext(source);` }
      : name === "edit" ? { path, edits: [{ oldText: `const value = ${turn};`, newText: `const value = ${turn + 1};` }] }
      : { path, offset: 1, limit: 40 };
    if (name !== "edit") chat.addChild(assistant([
      { type: "thinking", thinking: `Check module ${turn}: read the source, verify the boundary condition, then compare the test result.` },
      { type: "toolCall", id, name, arguments: args },
    ], "toolUse"));
    const tool = new ToolExecutionComponent(name, id, args, {}, definitions[name], ui, cwd);
    tool.setArgsComplete();
    tool.markExecutionStarted();
    const diff = Array.from({ length: 40 }, (_, line) =>
      `${line < 20 ? "-" : "+"}${line % 20 + 1} const value${line % 20} = ${turn + (line < 20 ? 0 : 1)};`).join("\n");
    const failed = name === "bash" && turn % 5 === 0;
    const details = name === "edit" ? { diff, firstChangedLine: 1 } : name === "codemode" ? { calls: [
      { id: `${id}/1`, name: "read", args: JSON.stringify({ path }), status: "ok", durationMs: 20 },
      { id: `${id}/2`, name: "bash", args: JSON.stringify({ command: "pnpm lint" }), status: "ok", durationMs: 50 },
    ], durationMs: 125 } : undefined;
    tool.updateResult({
      content: name === "codemode" ? [
        { type: "text", text: "Script completed\nWall time 0.125 seconds\nOutput:\n" },
        { type: "text", text: "==> text 1/1 <==\nSource inspected" },
      ] : [{ type: "text", text: Array.from({ length: 40 }, (_, line) => `const value${line} = ${turn + line};`).join("\n") }],
      isError: failed, durationMs: 125,
      details,
    });
    store?.note({ role: "toolResult", toolCallId: id, toolName: name, isError: failed, content: [], details, ...stamp() } as any);
    tools.push(tool);
    if (name === "codemode") scripts.push(tool);
    chat.addChild(tool);
  }
  chat.addChild(assistant([{ type: "text", text: `Updated module ${turn}.\n\n- Checked the implementation\n- Compared the test output` }]));
  store?.settle(false);
}
if (chat.children.length !== count) throw new Error("Fixture component count changed");
const width = 120;
chat.render(width); // Discover groups before expand-all, as in a live transcript.
if (mode === "expanded") {
  for (const tool of tools) tool.setExpanded(true);
  // Nested script/output sections have independent toggles inside a group.
  for (const script of scripts) Object.assign(codemodeSections(script), { script: true, output: true });
}
if (mode === "turns") {
  if (!turnModule) throw new Error(`turns: turn folding is not in ${root}`);
  turnModule.turnOptions.set({ ...turnModule.turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: false, icons: true });
}
if (opened) {
  if (!turnModule) throw new Error(`${mode}: turn folding is not in ${root}`);
  // Tidy's defaults, with every run opened: this is where the rail is drawn.
  turnModule.turnOptions.set({ ...turnModule.turnOptions.get(), collapseTurns: "afterRun", frameFinalReply: true, icons: true });
  for (const tool of tools) turnModule.expandTurnForTool((tool as unknown as { toolCallId: string }).toolCallId, true);
}
for (let frame = 0; frame < 20; frame++) chat.render(width);
const preview = chat.render(width).join("\n");
const markers = mode === "folded" ? ["3 calls", "diff"]
  : mode === "expanded" ? ["Source inspected", "value19"]
  : mode === "opened-large" ? ["23 calls", "--reporter=verbose", "diff"]
  : opened ? ["3 calls", "--reporter=verbose", "diff"]
  // A folded turn keeps its summary row and the final answer, nothing else.
  : ["4 calls", "Updated module"];
// A highlighted command is cut up by colour codes.
const visible = stripVTControlCharacters(preview);
for (const marker of markers) if (!visible.includes(marker)) throw new Error(`Fixture is missing ${marker}`);
if (mode === "turns" && preview.includes("value19")) throw new Error("Folded turn still renders a tool body");
const samples: number[] = [];
let rows = 0;
for (let frame = 0; frame < 80; frame++) {
  const started = performance.now();
  const lines = chat.render(width);
  samples.push(performance.now() - started);
  rows = lines.length;
}
console.log(JSON.stringify({ count, mode, rows, samples }));
process.exit(0); // Theme / UI timers must not keep a benchmark worker alive.
