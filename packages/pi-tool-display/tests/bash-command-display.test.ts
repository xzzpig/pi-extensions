import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderBashCall } from "../src/bash-display.ts";
import { handleToolDisplayArgs, openSettingsModal } from "../src/config-modal.ts";
import {
  BASH_COMMAND_ELLIPSIS,
  BASH_COMMAND_FALLBACK_WIDTH,
  clampBashCommandLineToWidth,
  foldBashCommandToSingleLine,
  resolveBashCommandDisplayWidth,
  shouldCollapseBashCommand,
} from "../src/bash-command-display.ts";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";
import { detectToolDisplayPreset } from "../src/presets.ts";
import { BASH_COMMAND_DISPLAY_MODES, DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

// Fork-only test file: covers the fork-added `bashCommandDisplay` option
// (config contract + bash command line rendering). Upstream test files stay
// byte-stable per the fork-divergence discipline.

const MULTI_LINE_COMMAND = "echo one\necho two";

interface TestTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function createPassThroughTheme(): TestTheme {
  return {
    fg: (_color: string, text: string): string => text,
    bold: (text: string): string => text,
  };
}

function createAnsiTheme(): TestTheme {
  return {
    fg: (color: string, text: string): string =>
      `\x1b[${color === "warning" ? "93" : color === "muted" ? "90" : color === "toolTitle" ? "94" : color === "accent" ? "92" : "0"}m${text}\x1b[0m`,
    bold: (text: string): string => `\x1b[1m${text}\x1b[0m`,
  };
}

function makeConfig(overrides: Partial<typeof DEFAULT_TOOL_DISPLAY_CONFIG> = {}) {
  return { ...DEFAULT_TOOL_DISPLAY_CONFIG, ...overrides };
}

/** pi-tui's truncateToWidth terminates truncated output with a reset sequence. */
function stripTrailingAnsiReset(text: string): string {
  return text.replace(/\x1b\[0m$/, "");
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    executionStarted: false,
    isPartial: false,
    ...overrides,
  };
}

function renderLinesAt(
  args: Record<string, unknown>,
  config: unknown,
  context: Record<string, unknown>,
  width: number,
): string[] {
  const text = renderBashCall(
    args,
    createPassThroughTheme(),
    makeContext(context) as never,
    config as never,
  );
  return text
    .render(width)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function renderLines(args: Record<string, unknown>, config: unknown, context: Record<string, unknown>): string[] {
  return renderLinesAt(args, config, context, 200);
}

function withTerminalColumns<T>(columns: number | undefined, run: () => T): T {
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: columns,
  });
  try {
    return run();
  } finally {
    delete (process.stdout as { columns?: unknown }).columns;
  }
}

test("bashCommandDisplay accepts every documented mode", () => {
  assert.deepEqual([...BASH_COMMAND_DISPLAY_MODES], ["full", "collapsed", "auto"]);

  for (const mode of BASH_COMMAND_DISPLAY_MODES) {
    const config = normalizeToolDisplayConfig({ bashCommandDisplay: mode });
    assert.equal(config.bashCommandDisplay, mode);
  }
});

test("bashCommandDisplay falls back to full for invalid or missing values", () => {
  assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.bashCommandDisplay, "full");

  const invalidValues: unknown[] = [undefined, null, "", "folded", "COLLAPSED", true, 1, [], {}];
  for (const value of invalidValues) {
    const config = normalizeToolDisplayConfig({ bashCommandDisplay: value });
    assert.equal(config.bashCommandDisplay, "full", `expected fallback for ${JSON.stringify(value)}`);
  }

  assert.equal(normalizeToolDisplayConfig({}).bashCommandDisplay, "full");
});

test("example configs document bashCommandDisplay", () => {
  const examplePath = fileURLToPath(new URL("../config/config.example.json", import.meta.url));
  const example = JSON.parse(readFileSync(examplePath, "utf8")) as {
    bashCommandDisplay?: unknown;
  };
  assert.equal(example.bashCommandDisplay, "full");
});

test("foldBashCommandToSingleLine folds newlines, carriage returns, and tabs", () => {
  assert.equal(foldBashCommandToSingleLine(MULTI_LINE_COMMAND), "echo one echo two");
  assert.equal(foldBashCommandToSingleLine("a\r\nb"), "a b");
  assert.equal(foldBashCommandToSingleLine("a\rb"), "a b");
  assert.equal(foldBashCommandToSingleLine("for x in a; do\n    echo $x\ndone"), "for x in a; do echo $x done");
  assert.equal(foldBashCommandToSingleLine("echo\tone"), "echo one");
  assert.equal(foldBashCommandToSingleLine("  echo one  "), "echo one");
  assert.equal(foldBashCommandToSingleLine("echo 'a  b'"), "echo 'a  b'");
  assert.equal(foldBashCommandToSingleLine(""), "");
});

test("clampBashCommandLineToWidth is ANSI-aware and appends an ellipsis", () => {
  const plain = "x".repeat(200);
  const clamped = clampBashCommandLineToWidth(plain, 40);
  assert.equal(visibleWidth(clamped), 40);
  assert.ok(stripTrailingAnsiReset(clamped).endsWith(BASH_COMMAND_ELLIPSIS));

  const ansi = `\x1b[92m${"y".repeat(200)}\x1b[0m`;
  const clampedAnsi = clampBashCommandLineToWidth(ansi, 30);
  assert.equal(visibleWidth(clampedAnsi), 30);
  assert.ok(stripTrailingAnsiReset(clampedAnsi).includes(BASH_COMMAND_ELLIPSIS));

  const short = "$ echo hi";
  assert.equal(clampBashCommandLineToWidth(short, 40), short);
  assert.equal(clampBashCommandLineToWidth(short, 0), short);
  assert.equal(clampBashCommandLineToWidth(short, Number.NaN), short);
});

test("resolveBashCommandDisplayWidth prefers the render width, then columns, then the fallback", () => {
  assert.equal(resolveBashCommandDisplayWidth(42), 42);
  withTerminalColumns(200, () => assert.equal(resolveBashCommandDisplayWidth(Number.NaN), 200));
  withTerminalColumns(undefined, () => {
    assert.equal(resolveBashCommandDisplayWidth(Number.NaN), BASH_COMMAND_FALLBACK_WIDTH);
    assert.equal(resolveBashCommandDisplayWidth(0), BASH_COMMAND_FALLBACK_WIDTH);

    const longLine = `$ echo ${"z".repeat(400)}`;
    const clamped = clampBashCommandLineToWidth(longLine, resolveBashCommandDisplayWidth(Number.NaN));
    assert.equal(visibleWidth(clamped), BASH_COMMAND_FALLBACK_WIDTH);
    assert.ok(stripTrailingAnsiReset(clamped).endsWith(BASH_COMMAND_ELLIPSIS));
  });
});

test("shouldCollapseBashCommand keeps full mode and expanded rows intact", () => {
  const full = { bashCommandDisplay: "full" } as const;
  const collapsed = { bashCommandDisplay: "collapsed" } as const;
  const auto = { bashCommandDisplay: "auto" } as const;

  assert.equal(shouldCollapseBashCommand(undefined, {}), false);
  assert.equal(shouldCollapseBashCommand(full, {}), false);
  assert.equal(shouldCollapseBashCommand(collapsed, {}), true);
  assert.equal(shouldCollapseBashCommand(collapsed, { expanded: true }), false);
  assert.equal(shouldCollapseBashCommand(auto, { expanded: true, executionStarted: true, isPartial: true }), false);
  assert.equal(shouldCollapseBashCommand(auto, { executionStarted: true, isPartial: true }), false);
  assert.equal(shouldCollapseBashCommand(auto, { executionStarted: true, isPartial: false }), true);
  assert.equal(shouldCollapseBashCommand(auto, {}), true);
});

test("full mode keeps upstream multi-line command rendering byte-stable", () => {
  const withoutConfig = renderLines({ command: MULTI_LINE_COMMAND }, undefined, {});
  const explicitFull = renderLines({ command: MULTI_LINE_COMMAND }, makeConfig(), {});
  const withAnsiTheme = renderBashCall(
    { command: MULTI_LINE_COMMAND },
    createAnsiTheme(),
    makeContext({}) as never,
    makeConfig(),
  )
    .render(200)
    .join("\n");

  assert.deepEqual(withoutConfig, ["$ echo one", "echo two"]);
  assert.deepEqual(explicitFull, withoutConfig);
  assert.ok(withAnsiTheme.includes("\x1b[92m"));
  assert.ok(withAnsiTheme.includes("echo one"));
  assert.ok(withAnsiTheme.includes("echo two"));
});

test("collapsed mode folds a multi-line command onto one line", () => {
  const lines = renderLines({ command: MULTI_LINE_COMMAND }, makeConfig({ bashCommandDisplay: "collapsed" }), {});
  assert.deepEqual(lines, ["$ echo one echo two"]);
});

test("collapsed mode truncates an overlong line to the render width", () => {
  const command = `echo ${"x".repeat(120)}`;
  const lines = renderLinesAt({ command }, makeConfig({ bashCommandDisplay: "collapsed" }), {}, 30);

  assert.equal(lines.length, 1);
  assert.equal(visibleWidth(lines[0]), 30);
  assert.ok(stripTrailingAnsiReset(lines[0]).endsWith(BASH_COMMAND_ELLIPSIS));
  assert.ok(lines[0].startsWith("$ echo "));
});

test("collapsed mode clamps to the render width, not the terminal columns", () => {
  const command = `echo ${"y".repeat(80)}`;

  withTerminalColumns(200, () => {
    const wide = renderLinesAt({ command }, makeConfig({ bashCommandDisplay: "collapsed" }), {}, 200);
    assert.deepEqual(wide, [`$ ${command}`]);

    const narrow = renderLinesAt({ command }, makeConfig({ bashCommandDisplay: "collapsed" }), {}, 40);
    assert.equal(narrow.length, 1);
    assert.equal(visibleWidth(narrow[0]), 40);
    assert.ok(stripTrailingAnsiReset(narrow[0]).endsWith(BASH_COMMAND_ELLIPSIS));
  });
});

test("collapsed rendering reuses the same Text component across renders", () => {
  const config = makeConfig({ bashCommandDisplay: "collapsed" });
  const first = renderBashCall(
    { command: MULTI_LINE_COMMAND },
    createPassThroughTheme(),
    makeContext({}) as never,
    config as never,
  );
  const second = renderBashCall(
    { command: MULTI_LINE_COMMAND },
    createPassThroughTheme(),
    makeContext({ lastComponent: first }) as never,
    config as never,
  );

  assert.equal(second, first);
  assert.equal(second.render(60).filter((line) => line.trim().length > 0).length, 1);
});

test("expanding the tool row reveals the full multi-line command in every mode", () => {
  const args = { command: MULTI_LINE_COMMAND, shellPath: "/usr/bin/zsh", timeout: 30 };

  for (const mode of BASH_COMMAND_DISPLAY_MODES) {
    const lines = renderLines(args, makeConfig({ bashCommandDisplay: mode }), { expanded: true });
    assert.deepEqual(
      lines,
      ["$ echo one", "echo two [shell: /usr/bin/zsh] (timeout 30s)"],
      `expected expanded ${mode} to keep the original command`,
    );
  }
});

test("auto mode shows the full command while running and collapses afterwards", () => {
  const config = makeConfig({ bashCommandDisplay: "auto" });
  const args = { command: MULTI_LINE_COMMAND };

  const running = renderLines(args, config, { executionStarted: true, isPartial: true });
  assert.equal(running.length, 2);
  assert.ok(running[0].includes("echo one"));
  assert.equal(running[1], "echo two");

  const finished = renderLines(args, config, { executionStarted: true, isPartial: false });
  assert.deepEqual(finished, ["$ echo one echo two"]);
});

test("collapsed mode still renders shell and timeout hints when the line fits", () => {
  const lines = renderLines(
    { command: MULTI_LINE_COMMAND, shellPath: "/usr/bin/zsh", timeout: 30 },
    makeConfig({ bashCommandDisplay: "collapsed" }),
    {},
  );
  assert.deepEqual(lines, ["$ echo one echo two [shell: /usr/bin/zsh] (timeout 30s)"]);
});

test("preset detection treats a non-default bashCommandDisplay as custom", () => {
  assert.equal(detectToolDisplayPreset(makeConfig()), "opencode");
  assert.equal(detectToolDisplayPreset(makeConfig({ bashCommandDisplay: "collapsed" })), "custom");
  assert.equal(detectToolDisplayPreset(makeConfig({ bashCommandDisplay: "auto" })), "custom");
});

test("config summary reports the bash command display mode", () => {
  const notifications: string[] = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify: (message: string): void => {
        notifications.push(message);
      },
    },
  };
  const controller = {
    getConfig: () => makeConfig({ bashCommandDisplay: "collapsed" }),
    setConfig: (): void => {},
    getCapabilities: () => ({ hasMcpTooling: false, hasRtkOptimizer: false }),
  };

  assert.equal(handleToolDisplayArgs("show", ctx as never, controller as never), true);
  assert.ok(notifications[0]?.includes("bashCommand=collapsed"));
});

test("settings inspector exposes bashCommandDisplay and applies new values", async () => {
  const passThroughTheme = {
    fg: (_color: string, text: string): string => text,
    bold: (text: string): string => text,
  };
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let current = makeConfig();
  const ctx = {
    hasUI: true,
    ui: {
      custom: async (
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown,
      ): Promise<void> => {
        component = factory({ requestRender: (): void => {} }, passThroughTheme, {}, () => {}) as never;
      },
    },
  };
  const controller = {
    getConfig: () => current,
    setConfig: (next: typeof current): void => {
      current = next;
    },
    getCapabilities: () => ({ hasMcpTooling: false, hasRtkOptimizer: false }),
  };

  await openSettingsModal(ctx as never, controller as never);
  assert.ok(component, "expected the settings inspector component");

  for (const character of "multiline") {
    component.handleInput(character);
  }
  assert.ok(component.render(140).join("\n").includes("Bash command line"));

  component.handleInput(" ");
  assert.equal(current.bashCommandDisplay, "collapsed");

  component.handleInput(" ");
  assert.equal(current.bashCommandDisplay, "auto");
});
