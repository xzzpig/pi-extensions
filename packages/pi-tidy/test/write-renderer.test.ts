/** The write preview must decorate rendering without taking ownership of execution. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWriteToolDefinition, initTheme, ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { COPY_CHIP } from "../src/turns/code-blocks.ts";
import tidy from "../src/index.ts";
import { collectWarnings, harness, loadTidy as load } from "./renderer-harness.ts";

/** Tidy's own defaults for the parts these tests do not exercise. */
const loadTidy = (pi: Parameters<typeof load>[1], config: Record<string, unknown> = {}) =>
  load(tidy, pi, { highlightBash: false, backgroundJobs: false, ...config });

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[
  Symbol.for("@earendil-works/pi-coding-agent:theme")
];
const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "").replace(/ +$/gm, "");

for (const tidyFirst of [true, false]) {
  test(`write execution stays sandboxed when Tidy loads ${tidyFirst ? "first" : "last"}`, async () => {
    const h = harness();
    const denied = new Error("Sandbox denied this write");
    const sandboxed = {
      ...createWriteToolDefinition(process.cwd()),
      description: "Sandboxed write",
      execute: async () => { throw denied; },
    };
    if (tidyFirst) loadTidy(h.pi);
    h.pi.registerTool(sandboxed);
    if (!tidyFirst) loadTidy(h.pi);

    assert.deepEqual(h.conflicts, []);
    assert.equal(h.tools.size, 1);
    assert.strictEqual(h.tools.get("write"), sandboxed, "schema, metadata and execute are untouched");
    assert.equal(h.resolvers.length, 2, "only renderers are registered: bash's and write's");
    assert.notStrictEqual(h.resolve("write")?.renderCall, sandboxed.renderCall);
    assert.strictEqual(h.resolve("write")?.renderResult, sandboxed.renderResult);
    await assert.rejects(
      () => h.tools.get("write")!.execute(
        "call", { path: "/denied.txt", content: "test" }, undefined, undefined, {} as any,
      ),
      (error) => error === denied,
    );
  });
}

test("Tidy does not register write even without another execution extension", () => {
  const h = harness();
  loadTidy(h.pi);
  assert.equal(h.tools.size, 0);
  assert.equal(h.resolvers.length, 2);
  assert.equal(typeof h.resolve("write")?.renderCall, "function");
  assert.equal(h.resolve("unregistered"), undefined);
});

test("a write box's path moves into the top border without a blank row", () => {
  const h = harness();
  loadTidy(h.pi);
  const resolved = h.resolve("write")!;
  const base = createWriteToolDefinition(process.cwd());
  const definition = { ...base, renderShell: resolved.renderShell, renderCall: resolved.renderCall, renderResult: resolved.renderResult };
  const component = new ToolExecutionComponent(
    "write", "call-write", { path: "/tmp/demo.txt", content: "first\nsecond" }, {},
    definition as any, { requestRender() {} } as any, process.cwd(),
  );
  component.setExpanded(true);
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult({ content: [], isError: false, durationMs: 1 }, false);
  const lines = (component.render(80) as string[]).map(plain);
  assert.match(lines[0], new RegExp(`^╭─ .*demo\\.txt ${COPY_CHIP} +─{5,}╮$`), "the path, its copy chip, then the rule");
  assert.match(lines[1], /^│ first +│$/, "the preview starts right under the border");
});

test("write rendering preserves the downstream shell and success/error result renderer", () => {
  const h = harness();
  loadTidy(h.pi);
  const original: ToolRenderers = {
    renderShell: "self",
    renderCall: () => new Text("original call", 0, 0),
    renderResult: (_result, _options, _theme, context) =>
      new Text(context.isError ? "sandbox denial" : "sandbox success", 0, 0),
  };
  // Another resolver may be installed later; it must still be consulted via next().
  h.pi.registerToolRenderer((_name, _next) => original);
  const rendered = h.resolve("write")!;
  assert.equal(rendered.renderShell, "self");
  assert.notStrictEqual(rendered.renderCall, original.renderCall);
  assert.strictEqual(rendered.renderResult, original.renderResult);
  for (const isError of [false, true]) {
    const result = rendered.renderResult!(
      { content: [], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      { isError, state: {} } as any,
    );
    assert.match(result.render(80).join("\n"), isError ? /sandbox denial/ : /sandbox success/);
  }
  assert.strictEqual(h.resolve("read"), original, "unrelated tools pass through unchanged");
});

test("the registered write renderer respects preview limits, expansion and streaming updates", () => {
  for (const lines of [0, 2, 10]) {
    const h = harness();
    loadTidy(h.pi, { writeLines: lines });
    const renderer = h.resolve("write")!.renderCall!;
    const originalCallText = new Text("owned by the execution extension", 0, 0);
    const context = { state: { callText: originalCallText }, expanded: false } as any;
    const args = { path: "/tmp/test.txt", content: "alpha\nbeta\ngamma" };
    const component = renderer(args, theme, context);
    const collapsed = plain(component.render(80).join("\n"));
    if (lines === 0) assert.doesNotMatch(collapsed, /alpha/);
    if (lines === 2) {
      assert.match(collapsed, /alpha\nbeta/);
      assert.doesNotMatch(collapsed, /gamma/);
      assert.match(collapsed, /1 more lines, 3 total/);
    }
    if (lines === 10) assert.match(collapsed, /alpha\nbeta\ngamma/);

    context.expanded = true;
    const expanded = renderer(args, theme, context);
    assert.strictEqual(expanded, component, "reuse the call's Text component");
    assert.match(plain(expanded.render(80).join("\n")), /alpha\nbeta\ngamma/);
    assert.doesNotMatch(plain(expanded.render(80).join("\n")), /more lines/);
    const updated = renderer({ ...args, content: "updated" }, theme, context);
    assert.match(plain(updated.render(80).join("\n")), /updated/);
    assert.match(originalCallText.render(80).join("\n"), /owned by the execution extension/);
  }
});

test("older Pi without the renderer API skips the preview rather than overriding write", async () => {
  const h = harness();
  Reflect.deleteProperty(h.pi, "registerToolRenderer");
  // A non-default writeLines is the only reason to speak up: nothing was lost
  // for someone who left it at pi's own ten lines.
  loadTidy(h.pi, { writeLines: 2 });
  assert.equal(h.tools.size, 0, "no unsafe registerTool fallback");
  assert.equal(h.resolvers.length, 0);
  const warnings = await collectWarnings(h.handlers);
  assert.ok(warnings.some((message) => /write.*preview/i.test(message) && /registerToolRenderer/.test(message)));
});

test("older Pi is not lectured about a setting it never changed", async () => {
  const h = harness();
  Reflect.deleteProperty(h.pi, "registerToolRenderer");
  loadTidy(h.pi);
  assert.deepEqual(await collectWarnings(h.handlers), []);
});

test("disabled Tidy registers neither tools nor renderers", () => {
  const h = harness();
  loadTidy(h.pi, { enabled: false });
  assert.equal(h.tools.size, 0);
  assert.equal(h.resolvers.length, 0);
});
