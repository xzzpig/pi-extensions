/**
 * Tests for tool box per-kind colors and icons, and for the frame patch
 * leaving user messages alone unless asked (the default "rail" style is
 * user-message.ts's — see user-message.test.ts).
 *
 * Runs in its own process (node --test isolates files), so the prototype
 * patches here must NOT enable includeUser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
(globalThis as any)[THEME_KEY] = {
  fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
  bg: (_color: string, text: string) => `\x1b[48;5;60m${text}\x1b[49m`,
  bold: (text: string) => `<b>${text}</b>`,
};

const { patchContainerBoxes, patchToolBoxFrames } = await import("../src/frame.ts");
const { ToolExecutionComponent, UserMessageComponent } = await import("@earendil-works/pi-coding-agent");
const { Text } = await import("@earendil-works/pi-tui");

patchToolBoxFrames({
  icons: true,
  toolColors: { bash: "bashCol", read: "readCol" },
  // 这组测试断言的是「完整盒子」的渲染(框、缓存、图标),
  // 分组折叠(C 行)由 test/tool-groups.test.ts 单独覆盖。
  groupTools: false,
});

function fakeToolBox(
  toolName: string,
  args: unknown,
  state: { isPartial?: boolean; isError?: boolean; callRow?: string } = {},
): { render(width: number): string[] } {
  const component = Object.create(ToolExecutionComponent.prototype);
  component.hideComponent = false;
  component.hasRendererDefinition = () => false;
  component.contentText = new Text(state.callRow ?? `${toolName} doing things`, 0, 0);
  component.isPartial = state.isPartial ?? false;
  component.result = { isError: state.isError ?? false };
  component.expanded = false;
  component.imageComponents = [];
  component.imageSpacers = [];
  component.toolName = toolName;
  component.args = args;
  return component;
}

const ESCAPE_RE = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;
const visible = (line: string) => line.replace(ESCAPE_RE, "").replace(/<\/?fg:[^>]*>/g, "").replace(/<\/fg>/g, "");

test("successful read gets its tool color; icons replace the tool-name word", () => {
  // Production shape: the name is wrapped in its own ANSI spans, so the
  // separator space sits AFTER the closing escapes — naive removal leaves
  // a double space between kind and file icons.
  const callRow = "\x1b[38;2;137;180;250m\x1b[1mread\x1b[22m\x1b[39m src/index.ts";
  const lines = fakeToolBox("read", { path: "src/index.ts" }, { callRow }).render(60);
  assert.match(lines[0], /^<fg:readCol>╭─+╮<\/fg>$/, "border in the tool color");
  const row = visible(lines[1]);
  assert.ok(
    row.startsWith("│ \u{f06e} \u{f06e6} src/index.ts"),
    `exact single-spaced layout, got ${JSON.stringify(row.trimEnd())}`,
  );
});

test("file icons carry their nvim-web-devicons brand color", () => {
  const lines = fakeToolBox("read", { path: "src/index.ts" }, { callRow: "read src/index.ts" }).render(60);
  // TypeScript brand color #0188d1 → truecolor escape right before the glyph.
  assert.ok(lines[1].includes("\x1b[38;2;1;136;209m\u{f06e6}\x1b[39m"), "colored TS glyph");
});

test("file icon falls back into the prefix when the path is not in the call row", () => {
  const lines = fakeToolBox("read", { path: "src/index.ts" }).render(60);
  const row = visible(lines[1]);
  assert.ok(row.indexOf("\u{f06e}") < row.indexOf("\u{f06e6}"), "kind icon before file icon");
  assert.ok(row.indexOf("\u{f06e6}") < row.indexOf("doing things"), "file icon still leads the row");
  assert.ok(!row.includes("read"), "tool-name word removed");
});

test("successful bash gets its tool color and the terminal icon", () => {
  const lines = fakeToolBox("bash", { command: "ls" }).render(60);
  assert.match(lines[0], /^<fg:bashCol>╭─+╮<\/fg>$/);
  assert.ok(lines[1].includes("\u{f018d}"), "console icon");
});

test("error stays red even for a colored tool", () => {
  const lines = fakeToolBox("read", { path: "a.ts" }, { isError: true }).render(60);
  assert.match(lines[0], /^<fg:error>╭─+╮<\/fg>$/);
});

test("pending stays muted even for a colored tool", () => {
  const lines = fakeToolBox("bash", {}, { isPartial: true }).render(60);
  assert.match(lines[0], /^<fg:borderMuted>╭─+╮<\/fg>$/);
});

test("unlisted tool falls back to the accent color and the wrench icon", () => {
  const lines = fakeToolBox("mcp_server_thing", {}).render(60);
  assert.match(lines[0], /^<fg:accent>╭─+╮<\/fg>$/);
  assert.ok(lines[1].includes("\u{f0ad}"), "default wrench icon");
});

test("read without a path arg falls back to the read tool icon", () => {
  const lines = fakeToolBox("read", {}).render(60);
  assert.ok(lines[1].includes("\u{f06e}"), "eye icon");
});

test("file icon follows the ~-shortened display path", () => {
  // renderToolPath shortens $HOME to ~ in the display text; the raw args
  // path never appears in the row, so the icon must match the short form.
  const home = process.env.HOME!;
  const raw = `${home}/.pi/agent/settings.json`;
  const lines = fakeToolBox("edit", { path: raw }, { callRow: "edit ~/.pi/agent/settings.json" }).render(70);
  const row = visible(lines[1]);
  const fileIdx = row.indexOf("\ue60b"); // json glyph
  assert.ok(fileIdx >= 0, "json icon present");
  assert.ok(fileIdx < row.indexOf("~/.pi/agent"), "icon sits in front of the ~ path");
  assert.ok(!row.includes("edit"), "tool-name word removed");
});

test("file icon lands outside the OSC 8 hyperlink, never inside its URL", () => {
  // Real write/read renderCall wraps the path in an ST-terminated OSC 8
  // hyperlink whose URL contains the path — a naive indexOf would inject
  // the icon into the escape sequence (invisible + corrupts the link).
  const path = "/tmp/pi-toolbox-demo/demo.ts";
  const opener = `\x1b]8;;file://${path}\x1b\\`;
  const closer = "\x1b]8;;\x1b\\";
  const callRow = `write ${opener}\x1b[96m${path}\x1b[0m${closer}`;
  const lines = fakeToolBox("write", { path }, { callRow }).render(60);
  const row = lines[1];

  assert.ok(row.includes(opener), "hyperlink opener intact");
  assert.ok(!opener.includes("\u{f06e6}"), "URL not polluted by the icon");
  const vis = visible(row);
  const fileIdx = vis.indexOf("\u{f06e6}");
  assert.ok(fileIdx >= 0, "file icon visible");
  assert.ok(fileIdx < vis.indexOf(path), "icon sits in front of the path");
  assert.ok(!vis.includes("write"), "tool-name word removed");
});

test("interior-only changes are not served from the frame cache (elapsed timer)", () => {
  // A running bash box renders the elapsed row between the call row and a
  // trailing blank line, so line count, first line and last line are all
  // identical while the value changes every second. A fingerprint keyed on
  // those three served the stale frame — the box froze on "Elapsed 0.0s"
  // until something else (a click expanding it) invalidated the cache.
  const box = fakeToolBox("bash", { command: "sleep 580" }, {
    isPartial: true,
    callRow: "$ sleep 580\nElapsed 0.0s\n",
  }) as unknown as { render(width: number): string[]; contentText: { setText(text: string): void } };

  const first = box.render(60);
  assert.ok(visible(first.join("\n")).includes("Elapsed 0.0s"), "initial frame");

  box.contentText.setText("$ sleep 580\nElapsed 1.0s\n");
  const second = box.render(60);

  assert.notDeepEqual(second, first, "a content change must produce a new frame");
  assert.ok(visible(second.join("\n")).includes("Elapsed 1.0s"), "second frame shows the new elapsed value");
});

test("an unchanged box still hits the cache (no re-framing)", () => {
  const box = fakeToolBox("bash", { command: "ls" });
  const first = box.render(60);
  const second = box.render(60);
  assert.strictEqual(second, first, "same array instance returned on a hit");
});

test("the frame patch leaves user messages alone without includeUser", () => {
  patchContainerBoxes({ user: "userCol", custom: "customCol" });
  const component = new UserMessageComponent("hello" as never);
  const lines: string[] = component.render(60);
  assert.ok(!lines.some((l) => l.includes("╭")), "no frame on user messages by default");
  assert.ok(lines.join("\n").includes("hello"), "original render intact");
});
