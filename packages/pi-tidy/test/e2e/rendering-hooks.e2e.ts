import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";

import { createHostHarness, createIsolatedEnvironment, createTuiContext } from "./harness.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const fakeTheme = {
  fg(color: string, text: string) {
    const opener = color === "error" ? "31" : color === "warning" ? "33" : color.startsWith("#") ? "38;2;127;132;156" : "36";
    return `\x1b[${opener}m${text}\x1b[39m`;
  },
  bg(_color: string, text: string) {
    return `\x1b[48;5;60m${text}\x1b[49m`;
  },
  bold(text: string) {
    return `\x1b[1m${text}\x1b[22m`;
  },
  italic(text: string) {
    return `\x1b[3m${text}\x1b[23m`;
  },
  underline(text: string) {
    return `\x1b[4m${text}\x1b[24m`;
  },
  strikethrough(text: string) {
    return `\x1b[9m${text}\x1b[29m`;
  },
  getColorMode: () => "truecolor",
};

function setTheme(): () => void {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const previous = globals[THEME_KEY];
  globals[THEME_KEY] = fakeTheme;
  return () => {
    if (previous === undefined) delete globals[THEME_KEY];
    else globals[THEME_KEY] = previous;
  };
}

test("pure transcript render helpers clean chrome and preserve tidy display features", async () => {
  const environment = createIsolatedEnvironment();
  const restoreTheme = setTheme();
  try {
    const { cleanTranscriptRows } = await import("../../src/clean-copy.ts");
    const { withHexSwatches } = await import("../../src/messages/hex-swatches.ts");
    const { ruleCodeToken } = await import("../../src/turns/code-blocks.ts");

    const frame = ["╭────────────────╮", "│ hello          │", "╰────────────────╯"];
    const cleanFrame = cleanTranscriptRows(frame, 0, frame.length - 1);
    assert.deepEqual(cleanFrame.rows.map((row) => row?.text.trimEnd() ?? null), [null, "hello", null]);
    const rail = ["────────────────", "│ hello", "────────────────"];
    const cleanRail = cleanTranscriptRows(rail, 0, rail.length - 1);
    assert.deepEqual(cleanRail.rows.map((row) => row?.text.trimEnd() ?? null), [null, "hello", null]);
    const copiedText = cleanFrame.rows.flatMap((row) => (row ? [row.text] : [])).join("\n");
    assert.doesNotMatch(copiedText, /[╭╮│╰─]/, "cleanCopy omits frame edges and rails");

    const swatches = withHexSwatches("#7f849c and rgb(127, 132, 156)", "", fakeTheme as never);
    assert.equal((swatches.match(/●/g) ?? []).length, 2);
    assert.match(swatches, /\x1b\[38;2;127;132;156m●/);
    const fenced = withHexSwatches("```css\n#7f849c\n```", "", fakeTheme as never);
    assert.doesNotMatch(fenced, /●/, "fenced code is not transformed");

    const codeBlock = ruleCodeToken(
      ["```fish", "  echo ready", "```"],
      { lang: "fish", text: "echo ready" },
      40,
      { theme: fakeTheme as never, icons: true, enabled: true, splitDiff: false, splitDiffMinWidth: 72, canCopy: false },
    );
    assert.ok(codeBlock, "enabled code blocks are transformed");
    const codeRows = codeBlock.lines.map(stripVTControlCharacters);
    assert.match(codeRows[0]!, /fish/);
    assert.match(codeRows[0]!, /─/);
    assert.match(codeRows.at(-1)!, /^\s*─+\s*$/);
    assert.ok(codeRows.some((line) => line.includes("echo ready")));
    assert.ok(codeRows.every((line) => !line.includes("```")), "the fences become rules");
  } finally {
    restoreTheme();
    environment.cleanup();
  }
});

test("three identical error rows become one ×3 frame and warnings pass through", async () => {
  const environment = createIsolatedEnvironment();
  const restoreTheme = setTheme();
  try {
    const { Text } = await import("@earendil-works/pi-tui");
    const { installErrorLines } = await import("../../src/messages/error-lines.ts");
    const children: InstanceType<typeof Text>[] = [];
    const container = {
      children: children as unknown[],
      addChild(child: InstanceType<typeof Text>) {
        children.push(child);
      },
    };
    installErrorLines(container as never);
    const repeated = 'Error: 429: {"message":"rate limit exceeded"}';
    for (let attempt = 0; attempt < 3; attempt++) {
      container.addChild(new Text(fakeTheme.fg("error", repeated), 1, 1));
    }

    assert.equal(children.length, 1, "only the first attempt survives");
    const renderedError = stripVTControlCharacters(children[0]!.render(80).join("\n"));
    assert.match(renderedError, /error ×3/);
    assert.match(renderedError, /Error: 429/);

    const warning = new Text(fakeTheme.fg("warning", "Warning: service is busy"), 1, 1);
    container.addChild(warning);
    assert.equal(children.at(-1), warning, "warning row keeps its original component");
    const renderedWarning = stripVTControlCharacters(warning.render(80).join("\n"));
    assert.match(renderedWarning, /Warning: service is busy/);
    assert.doesNotMatch(renderedWarning, /╭|╮|error ×/);
  } finally {
    restoreTheme();
    environment.cleanup();
  }
});

test("a missing InteractiveMode.init hook degrades with one session warning", async () => {
  const environment = createIsolatedEnvironment();
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const prototype = sdk.InteractiveMode.prototype as typeof sdk.InteractiveMode.prototype & { init?: unknown };
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "init");
    Object.defineProperty(prototype, "init", { configurable: true, writable: true, value: undefined });
    try {
      const host = createHostHarness();
      await host.load("pi-tidy");
      const ctx = await createTuiContext(environment.home);
      await host.fire("session_start", ctx);
      await host.fire("session_start", ctx);
      const warnings = ctx.notifications.filter((notification: { message: string; level?: string }) => notification.message.includes("InteractiveMode.init"));
      assert.equal(warnings.length, 1, "unsupported error-row deduplication is reported once");
      assert.equal(warnings[0]?.level, "warning");
    } finally {
      if (descriptor) Object.defineProperty(prototype, "init", descriptor);
      else delete (prototype as { init?: unknown }).init;
    }
  } finally {
    environment.cleanup();
  }
});
