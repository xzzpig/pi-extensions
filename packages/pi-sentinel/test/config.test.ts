import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  KNOWN_CORE_EVENTS,
  loadConfig,
  loadConfigFromPaths,
  mergeRules,
  validateRule,
  type SourcedRule,
} from "../extensions/config.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-sentinel-config-"));
  dirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fakeCtx(cwd: string, trusted: boolean): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => trusted,
  } as unknown as ExtensionContext;
}

function baseRule(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "rule",
    trigger: { type: "tool_call", tools: ["bash"] },
    mode: "blocking",
    prompt: "check it",
    ...overrides,
  };
}

afterEach(() => {
  dirs.length = 0;
});

describe("config loading and merge", () => {
  test("project rules override same-name global rules", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, {
      rules: [
        baseRule({ name: "bash-safety", prompt: "global bash prompt" }),
        baseRule({ name: "edit-style", prompt: "global edit prompt" }),
      ],
    });
    writeJson(projectPath, {
      rules: [baseRule({ name: "bash-safety", prompt: "project bash prompt" })],
    });

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.rules.map((rule) => rule.name)).toEqual([
      "bash-safety",
      "edit-style",
    ]);
    const bashSafety = loaded.rules.find((rule) => rule.name === "bash-safety");
    expect(bashSafety?.prompt).toBe("project bash prompt");
    expect(bashSafety?.source).toBe("project");
    expect(
      loaded.rules.find((rule) => rule.name === "edit-style")?.source,
    ).toBe("global");
    expect(loaded.warnings).toEqual([]);
  });

  test("an illegal rule is skipped without affecting its siblings", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, {});
    writeJson(projectPath, {
      rules: [
        baseRule({ name: "fine-a" }),
        baseRule({
          name: "bad-blocking",
          mode: "blocking",
          trigger: { type: "turn_end" },
        }),
        baseRule({ name: "fine-b" }),
      ],
    });

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["fine-a", "fine-b"]);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("bad-blocking");
    expect(loaded.warnings[0]).toContain("blocking");
  });

  test("project config is ignored silently for an untrusted project", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, { rules: [baseRule({ name: "global-only" })] });
    writeJson(projectPath, { rules: [baseRule({ name: "project-only" })] });

    const loaded = loadConfigFromPaths({ globalPath, projectPath: null });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["global-only"]);
    expect(loaded.warnings).toEqual([]);
  });

  test("loadConfig honors ctx.isProjectTrusted()", () => {
    const dir = tempDir();
    mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
    const configPath = join(dir, CONFIG_DIR_NAME, "sentinel.json");
    writeJson(configPath, { rules: [baseRule({ name: "project-only" })] });

    // Point the loader at the temp project by faking getAgentDir via cwd-relative path.
    const trusted = loadConfig({
      cwd: dir,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext);
    const untrusted = loadConfig(fakeCtx(dir, false));

    expect(trusted.rules.map((rule) => rule.name)).toContain("project-only");
    expect(untrusted.rules.map((rule) => rule.name)).not.toContain(
      "project-only",
    );
  });

  test("file-level unknown keys warn and are ignored", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, {
      unknownTopLevel: { nested: true },
      rules: [baseRule({ name: "kept" })],
    });
    writeJson(projectPath, {});

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["kept"]);
    expect(
      loaded.warnings.some((warning) => warning.includes("unknownTopLevel")),
    ).toBe(true);
  });

  test("an auditor tool that is not a host built-in fails validation", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, {
      rules: [
        baseRule({
          name: "with-mcp-tool",
          tools: ["read", "mcp__fs__read_file"],
        }),
        baseRule({ name: "with-read", tools: ["read"] }),
      ],
    });
    writeJson(projectPath, {});

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["with-read"]);
    expect(loaded.warnings[0]).toContain("mcp__fs__read_file");
  });
});

describe("defaults and keybindings merge", () => {
  test("defaults merge per key with project winning and built-ins underneath", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, {
      defaults: {
        model: "global/model",
        cacheTtlMs: 1000,
        configure: { model: "global/conf" },
      },
    });
    writeJson(projectPath, {
      defaults: {
        model: "project/model",
        configure: { model: "project/conf" },
      },
    });

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.defaults.model).toBe("project/model");
    expect(loaded.defaults.cacheTtlMs).toBe(1000);
    expect(loaded.defaults.configure?.model).toBe("project/conf");
    expect(loaded.defaults.cache).toBe(true);
    expect(loaded.defaults.maxConcurrent).toBe(3);
    expect(loaded.defaults.maxWindowTokens).toBe(20_000);
  });

  test("invalid defaults values warn instead of failing the file", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, {
      defaults: { cacheTtlMs: -5, thinking: "ultra", nope: 1 },
      rules: [baseRule({ name: "kept" })],
    });
    writeJson(projectPath, {});

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["kept"]);
    expect(
      loaded.warnings.some((warning) => warning.includes("cacheTtlMs")),
    ).toBe(true);
    expect(
      loaded.warnings.some((warning) => warning.includes("thinking")),
    ).toBe(true);
    expect(loaded.warnings.some((warning) => warning.includes("nope"))).toBe(
      true,
    );
    expect(loaded.defaults.cacheTtlMs).toBe(600_000);
  });

  test("fleetKeybindings merge per key over the defaults", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeJson(globalPath, { fleetKeybindings: { close: ["x"], bogus: ["y"] } });
    writeJson(projectPath, {});

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.fleetKeybindings.close).toEqual(["x"]);
    expect(loaded.fleetKeybindings.steer).toEqual(["s"]);
    expect(loaded.warnings.some((warning) => warning.includes("bogus"))).toBe(
      true,
    );
  });

  test("a broken JSON file is skipped with a warning", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, "{ not json", "utf8");
    writeJson(projectPath, { rules: [baseRule({ name: "from-project" })] });

    const loaded = loadConfigFromPaths({ globalPath, projectPath });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["from-project"]);
    expect(loaded.warnings[0]).toContain("invalid JSON");
  });

  test("missing files produce an empty, silent config", () => {
    const dir = tempDir();
    const loaded = loadConfigFromPaths({
      globalPath: join(dir, "nope-global.json"),
      projectPath: join(dir, "nope-project.json"),
    });

    expect(loaded.rules).toEqual([]);
    expect(loaded.warnings).toEqual([]);
  });
});

describe("rule validation details", () => {
  test("context_tokens requires a positive threshold", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    writeJson(globalPath, {
      rules: [
        baseRule({
          name: "no-threshold",
          mode: "background",
          trigger: { type: "context_tokens" },
        }),
        baseRule({
          name: "zero-threshold",
          mode: "background",
          trigger: { type: "context_tokens", threshold: 0 },
        }),
        baseRule({
          name: "good-threshold",
          mode: "background",
          trigger: { type: "context_tokens", threshold: 1000 },
        }),
      ],
    });

    const loaded = loadConfigFromPaths({ globalPath, projectPath: null });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["good-threshold"]);
    expect(loaded.warnings).toHaveLength(2);
  });

  test("unknown rule fields and multi-key windows fail the rule", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    writeJson(globalPath, {
      rules: [
        baseRule({ name: "unknown-field", mystery: true }),
        baseRule({ name: "bad-window", window: { messages: 1, tokens: 2 } }),
        baseRule({ name: "good-window", window: { full: true } }),
      ],
    });

    const loaded = loadConfigFromPaths({ globalPath, projectPath: null });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["good-window"]);
    expect(loaded.warnings[0]).toContain("unknown field");
    expect(loaded.warnings[1]).toContain("exactly one");
  });

  test("mergeRules replaces in place and appends new names", () => {
    const a = { name: "a", source: "global" } as SourcedRule;
    const b = { name: "b", source: "global" } as SourcedRule;
    const a2 = { name: "a", source: "project" } as SourcedRule;
    const c = { name: "c", source: "project" } as SourcedRule;

    expect(mergeRules([a, b], [a2, c])).toEqual([a2, b, c]);
  });
});

describe("KNOWN_CORE_EVENTS", () => {
  test("lists 41 unique host event names", () => {
    expect(KNOWN_CORE_EVENTS).toHaveLength(41);
    expect(new Set(KNOWN_CORE_EVENTS).size).toBe(41);
  });

  test("contains representative host events", () => {
    expect(KNOWN_CORE_EVENTS).toContain("session_compact");
    expect(KNOWN_CORE_EVENTS).toContain("message_update");
    expect(KNOWN_CORE_EVENTS).toContain("tool_call");
  });
});

describe("event trigger validation", () => {
  function eventRule(
    trigger: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      name: "on-event",
      trigger,
      mode: "background",
      prompt: "check it",
    };
  }

  test("a valid bare-name and core: rule passes validation", () => {
    const bus = validateRule(
      eventRule({ type: "event", event: "pi-subagents:done" }),
    );
    expect(bus.ok).toBe(true);

    const core = validateRule(
      eventRule({ type: "event", event: "core:session_compact" }),
    );
    expect(core.ok).toBe(true);
  });

  test("trigger.event is required for event rules and must be non-empty", () => {
    const missing = validateRule(eventRule({ type: "event" }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("required");

    const blank = validateRule(eventRule({ type: "event", event: "   " }));
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toContain("non-empty string");
  });

  test("trigger.event on other trigger types fails validation", () => {
    const result = validateRule(
      eventRule({ type: "tool_call", event: "pi-subagents:done" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("only valid for event");
  });

  test("blocking mode combined with event is rejected", () => {
    const result = validateRule({
      name: "on-event",
      trigger: { type: "event", event: "core:session_compact" },
      mode: "blocking",
      prompt: "check it",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("blocking");
  });

  test("trigger.tools and trigger.threshold on event rules are rejected", () => {
    const tools = validateRule(
      eventRule({ type: "event", event: "done", tools: ["bash"] }),
    );
    expect(tools.ok).toBe(false);
    if (!tools.ok) expect(tools.error).toContain("trigger.tools");

    const threshold = validateRule(
      eventRule({ type: "event", event: "done", threshold: 5 }),
    );
    expect(threshold.ok).toBe(false);
    if (!threshold.ok) expect(threshold.error).toContain("trigger.threshold");
  });

  test("an unknown core: event name is rejected and the error lists all legal names", () => {
    const result = validateRule(
      eventRule({ type: "event", event: "core:sesson_compact" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("core:sesson_compact");
      expect(result.error).toContain(KNOWN_CORE_EVENTS.join(", "));
    }
  });
});

describe("event trigger loading", () => {
  test("a misspelled core: event name is skipped with a warning listing legal names", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    writeJson(globalPath, {
      rules: [
        baseRule({
          name: "typo-event",
          mode: "background",
          trigger: { type: "event", event: "core:sesson_compact" },
        }),
        baseRule({
          name: "fine",
          mode: "background",
          trigger: { type: "turn_end" },
        }),
      ],
    });

    const loaded = loadConfigFromPaths({ globalPath, projectPath: null });

    expect(loaded.rules.map((rule) => rule.name)).toEqual(["fine"]);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("typo-event");
    expect(loaded.warnings[0]).toContain("session_compact");
  });

  test("bus channel names load without validation and hot core events are accepted", () => {
    const dir = tempDir();
    const globalPath = join(dir, "global.json");
    writeJson(globalPath, {
      rules: [
        baseRule({
          name: "bus-rule",
          mode: "background",
          trigger: { type: "event", event: "pi-subagents:done" },
        }),
        baseRule({
          name: "hot-core-rule",
          mode: "background",
          trigger: { type: "event", event: "core:message_update" },
        }),
      ],
    });

    const loaded = loadConfigFromPaths({ globalPath, projectPath: null });

    expect(loaded.rules.map((rule) => rule.name)).toEqual([
      "bus-rule",
      "hot-core-rule",
    ]);
    expect(loaded.warnings).toEqual([]);
  });
});
