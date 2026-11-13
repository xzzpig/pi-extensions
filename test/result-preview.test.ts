/**
 * Collapsed result previews: pi hard-codes 5 output lines for bash and offers no
 * setting, so pi-toolbox lowers the budget on the component pi built.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { collapsedResultBudget, shrinkResultPreview } from "../src/tools/result-preview.ts";

function preview(maxVisualLines: number) {
  const node = {
    options: { maxVisualLines },
    invalidated: 0,
    invalidate() {
      node.invalidated++;
    },
  };
  return node;
}

test("lowers a nested preview budget and invalidates its cache", () => {
  const inner = preview(5);
  const root = { children: [{ children: [inner] }] };
  assert.equal(shrinkResultPreview(root, 1), 1);
  assert.equal(inner.options.maxVisualLines, 1);
  assert.equal(inner.invalidated, 1);
});

test("never raises a preview that is already narrower", () => {
  const only = preview(1);
  assert.equal(shrinkResultPreview({ children: [only] }, 3), 0);
  assert.equal(only.options.maxVisualLines, 1);
});

test("no preview in the tree is not an error", () => {
  assert.equal(shrinkResultPreview({ children: [{ children: [] }] }, 1), 0);
  assert.equal(shrinkResultPreview(null, 1), 0);
  assert.equal(shrinkResultPreview(preview(5), Number.NaN), 0);
});

test("a preview is not searched for nested previews", () => {
  const inner = preview(5);
  const outer = preview(5);
  (outer as any).children = [inner];
  shrinkResultPreview({ children: [outer] }, 1);
  assert.equal(outer.options.maxVisualLines, 1);
  assert.equal(inner.options.maxVisualLines, 5);
});

test("errors keep pi's own budget", () => {
  assert.equal(collapsedResultBudget(1, false), 1);
  assert.equal(collapsedResultBudget(1, true), undefined);
  assert.equal(collapsedResultBudget(0, false), 0);
});
