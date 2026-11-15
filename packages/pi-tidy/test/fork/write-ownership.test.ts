import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import {
  initTheme,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import tidy from "../../src/index.ts";
import { applyForkDefaults } from "../../fork/defaults.ts";
import { loadConfig } from "../../src/config.ts";
import { collectWarnings, harness, loadTidy } from "../renderer-harness.ts";

initTheme("dark");
const theme = (globalThis as unknown as Record<symbol, any>)[
  Symbol.for("@earendil-works/pi-coding-agent:theme")
];

function load(config: Record<string, unknown> = {}) {
  const h = harness();
  // Undefined removes the upstream-baseline opt-in from the serialized settings.
  loadTidy(tidy, h.pi, {
    frameTools: false,
    highlightBash: false,
    writePreview: undefined,
    ...config,
  });
  return h;
}

const owner: ToolRenderers = {
  renderShell: "default",
  renderCall: () => new Text("write demo.txt", 0, 0),
  renderResult: (_result, _options, _theme, context) =>
    new Text(
      context.isError ? "owner denial" : "created\nunique-write-body",
      0,
      0,
    ),
};

for (const writePreview of [undefined, false, "true", 1, null]) {
  test(`write preview remains opt-in for ${String(writePreview)}`, () => {
    const h = load({ writePreview, writeLines: 2 });
    assert.strictEqual(h.resolve("write", owner), owner);
    assert.equal(
      h.resolvers.length,
      1,
      "only the existing bash resolver is registered",
    );
    assert.equal(h.tools.size, 0, "execution is not re-registered");
  });
}

for (const ownerFirst of [true, false]) {
  test(`write owner resolver is preserved when loaded ${ownerFirst ? "first" : "last"}`, () => {
    const h = harness();
    if (ownerFirst) h.pi.registerToolRenderer((_name, next) => next() ?? owner);
    loadTidy(tidy, h.pi, { frameTools: false, writePreview: undefined });
    if (!ownerFirst)
      h.pi.registerToolRenderer((_name, next) => next() ?? owner);
    assert.strictEqual(h.resolve("write"), owner);
  });
}

for (const expanded of [false, true]) {
  test(`native tool component renders the write body once (expanded=${expanded})`, () => {
    const h = load();
    const component = new ToolExecutionComponent(
      "write",
      "write-id",
      { path: "demo.txt", content: "unique-write-body" },
      {},
      h.resolve("write", owner) as any,
      { requestRender() {} } as any,
      process.cwd(),
    );
    component.setExpanded(expanded);
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult({ content: [], isError: false }, false);
    const text = component.render(100).join("\n");
    assert.equal(text.split("unique-write-body").length - 1, 1);
    component.updateResult({ content: [], isError: true }, false);
    assert.match(component.render(100).join("\n"), /owner denial/);
  });
}

test("explicit opt-in restores preview without replacing result or shell", () => {
  const h = load({ writePreview: true, writeLines: 1 });
  const rendered = h.resolve("write", owner)!;
  assert.notStrictEqual(rendered.renderCall, owner.renderCall);
  assert.strictEqual(rendered.renderResult, owner.renderResult);
  assert.strictEqual(rendered.renderShell, owner.renderShell);
  const context = { state: {}, expanded: false } as any;
  const args = { path: "demo.txt", content: "first\nsecond" };
  assert.match(
    rendered.renderCall!(args, theme, context).render(80).join("\n"),
    /1 more lines/,
  );
  context.expanded = true;
  assert.match(
    rendered.renderCall!(args, theme, context).render(80).join("\n"),
    /second/,
  );
  // A new host (as on /reload) with opt-in removed restores exact identity.
  assert.strictEqual(load().resolve("write", owner), owner);
});

test("legacy toolbox supports the opt-in and tidy takes precedence", () => {
  const upstream = loadConfig();
  assert.equal(
    applyForkDefaults(upstream, { toolbox: { writePreview: true } })
      .writePreview,
    true,
  );
  assert.equal(
    applyForkDefaults(upstream, { tidy: {}, toolbox: { writePreview: true } })
      .writePreview,
    false,
  );
});

test("disabled preview does not warn about unused writeLines on old Pi", async () => {
  const h = harness();
  Reflect.deleteProperty(h.pi, "registerToolRenderer");
  loadTidy(tidy, h.pi, {
    writePreview: false,
    writeLines: 2,
    highlightBash: false,
  });
  assert.deepEqual(await collectWarnings(h.handlers), []);
});

test("other built-in and extension tool renderer sets remain untouched", () => {
  const h = load();
  for (const name of [
    "read",
    "edit",
    "grep",
    "find",
    "ls",
    "codemode",
    "custom_tool",
  ]) {
    assert.strictEqual(h.resolve(name, owner), owner, name);
  }
  // With default highlighting off, bash keeps the owner's command and shell.
  const bash = h.resolve("bash", owner)!;
  assert.strictEqual(bash.renderCall, owner.renderCall);
  assert.strictEqual(bash.renderShell, owner.renderShell);
});
