/**
 * bash is decorated, never re-registered.
 *
 * The same conflict that hit `write` (issue #7) applies here: pi fails to load
 * an extension whose tool name is already taken, so a sandbox extension that
 * owns `bash` used to be mutually exclusive with `highlightBash`. Both of Tidy's
 * bash changes are rendering only, so they travel as a renderer resolver and
 * the execution extension keeps its tool, schema and result renderer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition, initTheme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import tidy from "../src/index.ts";
import { collectWarnings, harness, loadTidy as load } from "./renderer-harness.ts";

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "").replace(/ +$/gm, "");

/** Tidy with bash highlighting on (the default), everything else quiet. */
const loadTidy = (pi: Parameters<typeof load>[1], config: Record<string, unknown> = {}) =>
  load(tidy, pi, { highlightBash: true, backgroundJobs: false, ...config });

const bashDefinition = () => createBashToolDefinition(process.cwd()) as unknown as ToolRenderers;

/** A component shaped like the node pi's preview budget walk looks for. */
function preview(budget: number) {
  const node: any = {
    options: { maxVisualLines: budget },
    children: [],
    invalidated: 0,
    render: () => ["command output"],
    invalidate() {
      node.invalidated++;
    },
  };
  return node;
}

test("bash is never registered as a tool, and a sandbox that owns it still loads", () => {
  const h = harness();
  loadTidy(h.pi);
  // A sandbox extension registering bash after Tidy must not collide.
  const sandboxed = { ...bashDefinition(), description: "sandboxed bash" };
  h.pi.registerTool(sandboxed as any);
  assert.deepEqual(h.conflicts, []);
  assert.strictEqual(h.tools.get("bash"), sandboxed);
});

test("the call row is ours, the result renderer stays the execution extension's", () => {
  const h = harness();
  loadTidy(h.pi);
  const base = bashDefinition();
  const rendered = h.resolve("bash", base)!;
  assert.notStrictEqual(rendered.renderCall, base.renderCall, "the command row is replaced");
  assert.notStrictEqual(rendered.renderResult, base.renderResult, "the result is wrapped, not replaced");
  assert.strictEqual(rendered.renderShell, base.renderShell, "the shell decision stays downstream");
});

test("the command row is syntax highlighted and shortens while collapsed", () => {
  const h = harness();
  loadTidy(h.pi);
  const renderCall = h.resolve("bash", bashDefinition())!.renderCall!;
  const command = "cd ~/x && pnpm test\nsecond line\nthird line";
  const context = { state: {}, expanded: false } as any;
  const collapsed = plain(renderCall({ command }, theme, context).render(120).join("\n"));
  assert.match(collapsed, /pnpm test/);
  assert.match(collapsed, /\(\+\d+ lines?\)|more line/, `expected a fold hint:\n${collapsed}`);
  assert.doesNotMatch(collapsed, /second line/);

  const expanded = plain(renderCall({ command }, theme, { ...context, expanded: true }).render(120).join("\n"));
  assert.match(expanded, /second line/);
  assert.match(expanded, /third line/);
});

test("the call renderer keeps the timing state pi's result renderer reads", () => {
  const h = harness();
  loadTidy(h.pi);
  const renderCall = h.resolve("bash", bashDefinition())!.renderCall!;
  const state: any = {};
  renderCall({ command: "sleep 1" }, theme, { state, expanded: false, executionStarted: true } as any);
  assert.equal(typeof state.startedAt, "number", "startedAt drives the Took Xs footer");
  assert.equal(state.endedAt, undefined);
  assert.ok(state.tidyCallText, "the reused component lives in our own slot");
});

test("the collapsed result budget is applied on top of the downstream result", () => {
  const h = harness();
  loadTidy(h.pi, { bashResultLines: 1 });
  const result = { content: [{ type: "text", text: "a\nb\nc" }], details: {}, isError: false };
  let calls = 0;
  const downstream = {
    renderResult: () => {
      calls++;
      return preview(5);
    },
  } as unknown as ToolRenderers;
  const rendered = h.resolve("bash", downstream)!;
  const collapsed = (rendered.renderResult! as any)(result, { expanded: false, isPartial: false }, theme, {
    isError: false,
  });
  assert.equal(calls, 1, "the downstream renderer still owns the component");
  assert.equal(collapsed.options.maxVisualLines, 1, "pi's five lines are lowered to the setting");
  assert.ok(collapsed.invalidated > 0);

  // Expanded, or on an error, the downstream output is left alone.
  const expanded = (rendered.renderResult! as any)(result, { expanded: true, isPartial: false }, theme, {
    isError: false,
  });
  assert.equal(expanded.options.maxVisualLines, 5);
  const failed = (rendered.renderResult! as any)(result, { expanded: false, isPartial: false }, theme, {
    isError: true,
  });
  assert.equal(failed.options.maxVisualLines, 5);
});

test("highlightBash: false keeps the owner's command row, and the budget still applies", () => {
  const h = harness();
  loadTidy(h.pi, { highlightBash: false, bashResultLines: 2 });
  const base = { renderCall: () => ({ render: () => [] }), renderResult: () => preview(5) } as unknown as ToolRenderers;
  const rendered = h.resolve("bash", base)!;
  assert.strictEqual(rendered.renderCall, base.renderCall, "the command row is not ours to change");
  const collapsed = (rendered.renderResult! as any)(
    { content: [{ type: "text", text: "a\nb\nc" }], details: {}, isError: false },
    { expanded: false, isPartial: false },
    theme,
    { isError: false },
  );
  assert.equal(collapsed.options.maxVisualLines, 2);
});

test("other tools pass through untouched", () => {
  const h = harness();
  loadTidy(h.pi);
  const read = { renderCall: () => ({ render: () => [] }) } as unknown as ToolRenderers;
  assert.strictEqual(h.resolve("read", read), read);
  assert.equal(h.resolve("unregistered"), undefined);
});

test("older Pi keeps its own bash and says what it is missing", async () => {
  const h = harness();
  Reflect.deleteProperty(h.pi, "registerToolRenderer");
  loadTidy(h.pi);
  assert.equal(h.tools.size, 0, "no tool override to fall back to");
  assert.equal(h.resolvers.length, 0);
  const warnings = await collectWarnings(h.handlers);
  assert.ok(
    warnings.some((message) => /bash/.test(message) && /registerToolRenderer/.test(message)),
    `expected a bash warning, got ${JSON.stringify(warnings)}`,
  );
});

test("with highlighting off, older Pi is not told about bash", async () => {
  const h = harness();
  Reflect.deleteProperty(h.pi, "registerToolRenderer");
  loadTidy(h.pi, { highlightBash: false });
  assert.deepEqual(await collectWarnings(h.handlers), []);
});

test("with highlighting off, older Pi still hears about a budget the user set", async () => {
  const h = harness();
  Reflect.deleteProperty(h.pi, "registerToolRenderer");
  loadTidy(h.pi, { highlightBash: false, bashResultLines: 3 });
  const warnings = await collectWarnings(h.handlers);
  assert.ok(warnings.some((message) => /bashResultLines/.test(message)), JSON.stringify(warnings));
});

test("disabled Tidy registers nothing at all", () => {
  const h = harness();
  loadTidy(h.pi, { enabled: false });
  assert.equal(h.tools.size, 0);
  assert.equal(h.resolvers.length, 0);
});
