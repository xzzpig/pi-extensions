import test from "node:test";

import assert from "node:assert/strict";

import {
  applyToolDisplayBashDecoration,
  maybeDecorateBashForToolDisplay,
} from "../src/tool-display-decoration.ts";

test("applyToolDisplayBashDecoration assigns decorated renderers in place", () => {
  const tool: Record<string, unknown> = {
    name: "bash",
    label: "bash (sandboxed)",
    renderCall: "original-call",
    renderResult: "original-result",
  };
  const decorator = (t: unknown) => ({
    ...(t as object),
    renderCall: "display-call",
    renderResult: "display-result",
  });

  const applied = applyToolDisplayBashDecoration(tool, decorator);

  assert.equal(applied, true);
  assert.equal(tool.renderCall, "display-call");
  assert.equal(tool.renderResult, "display-result");
  assert.equal(tool.label, "bash (sandboxed)");
  assert.equal(tool.name, "bash");
});

test("applyToolDisplayBashDecoration passes the bash adapter options", () => {
  let receivedAdapter: unknown;
  const tool = { name: "bash" };
  const decorator = (t: unknown, adapter?: unknown) => {
    receivedAdapter = adapter;
    return t;
  };

  applyToolDisplayBashDecoration(tool, decorator);

  assert.deepEqual(receivedAdapter, {
    kind: "bash",
    overrideExistingRenderers: true,
  });
});

test("applyToolDisplayBashDecoration no-ops when decorator returns same tool", () => {
  const tool = { name: "bash", renderCall: () => "x" };
  const applied = applyToolDisplayBashDecoration(tool, (t) => t);
  assert.equal(applied, true);
  assert.equal(typeof tool.renderCall, "function");
});

test("applyToolDisplayBashDecoration no-ops on non-object tools", () => {
  assert.equal(
    applyToolDisplayBashDecoration(null, () => ({})),
    false,
  );
  assert.equal(
    applyToolDisplayBashDecoration(undefined, () => ({})),
    false,
  );
  assert.equal(
    applyToolDisplayBashDecoration("bash", () => ({})),
    false,
  );
  assert.equal(
    applyToolDisplayBashDecoration(42, () => ({})),
    false,
  );
});

test("applyToolDisplayBashDecoration swallows decorator errors", () => {
  const tool = { name: "bash" };
  const applied = applyToolDisplayBashDecoration(tool, () => {
    throw new Error("boom");
  });
  assert.equal(applied, false);
  assert.equal(tool.name, "bash");
});

test("maybeDecorateBashForToolDisplay resolves without throwing", async () => {
  const tool = { name: "bash" };
  await maybeDecorateBashForToolDisplay(tool);
  assert.equal(tool.name, "bash");
});
