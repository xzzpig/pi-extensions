/**
 * The render caches key off one options revision instead of naming the options
 * they read.
 *
 * Naming them meant every new option had to be added to every cache that felt
 * it, and one missed name left the old frame on screen after a `/reload` — the
 * bug class that made 0.9.4's split diff ignore a theme switch. These tests pin
 * both directions: a re-patch reaches a cached frame, and an unchanged frame is
 * still reused.
 *
 * Runs in its own process, so the options set here stay here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { optionsRevision } from "../src/live.ts";
import { patchToolBoxFrames } from "../src/tools/tool-frame.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";

initTheme("dark");

const W = 90;
const CWD = process.cwd();
const bashDef = createBashToolDefinition(CWD);
const ui = { requestRender() {} };
const OPTIONS = { icons: false, groupTools: false, splitDiff: true, splitDiffMinWidth: 72, diffLines: 8 };

resetGroups();
patchToolBoxFrames(OPTIONS);

let nextId = 0;
function bashBox() {
  const box = new ToolExecutionComponent("bash", `call-${++nextId}`, { command: "pnpm test" }, {}, bashDef as any, ui as any, CWD);
  box.setArgsComplete();
  box.markExecutionStarted();
  box.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 9 } as any, false);
  return box;
}

test("a re-patch rebuilds a cached frame, even when every value is unchanged", () => {
  const box = bashBox();
  box.render(W);
  const built = (box as any).__frameCache;
  assert.equal(built.revision, optionsRevision(), "the frame records the revision it was built under");

  box.render(W);
  assert.strictEqual((box as any).__frameCache, built, "an unchanged frame reuses what it drew");

  // Nothing the cache compares changed; only the revision moved. That is what
  // lets an option this cache has never heard of reach the frame.
  patchToolBoxFrames(OPTIONS);
  assert.notEqual(optionsRevision(), built.revision);
  box.render(W);
  const rebuilt = (box as any).__frameCache;
  assert.notStrictEqual(rebuilt, built, "the next frame is built under the new revision");
  assert.equal(rebuilt.revision, optionsRevision());

  box.render(W);
  assert.strictEqual((box as any).__frameCache, rebuilt, "and it caches again");
});

test("an option the cache no longer names still redraws a cached box", () => {
  patchToolBoxFrames({ ...OPTIONS, icons: false });
  const box = bashBox();
  const withoutIcons = box.render(W);

  patchToolBoxFrames({ ...OPTIONS, icons: true });
  const withIcons = box.render(W);
  assert.notDeepEqual(withIcons, withoutIcons, "the kind icon reaches the frame through the revision");

  patchToolBoxFrames({ ...OPTIONS, icons: false });
  assert.deepEqual(box.render(W), withoutIcons, "and turning it off again restores the first frame");
});
