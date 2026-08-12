import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUILTIN_EVENT_PRIORITIES,
  collectChannelIdConflicts,
  DEFAULT_TERM_PROGRAM_PROTOCOLS,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadPiNotifyConfig,
  makeDefaultConfig,
  mergeChannels,
  mergeConfigLayers,
  parsePiNotifyConfig,
  resolveNtfyIcon,
  resolveNtfyPriority,
} from "../extensions/config.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-notify-"));
  tempDirectories.push(directory);
  return directory;
}

describe("defaults", () => {
  it("ships the fixed terminal OSC instance with the default six events", () => {
    const config = makeDefaultConfig();
    expect(config).toMatchObject({
      version: 1,
      enabled: true,
      herdr: { enabled: true },
    });
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]).toMatchObject({
      id: "terminal",
      type: "osc",
      enabled: true,
      osc: { fallback: "osc9" },
    });
    expect(config.channels[0].events).toEqual([
      "agent-completed",
      "agent-error",
      "input-required",
      "permission-required",
      "task-completed",
      "integration-error",
    ]);
    expect(DEFAULT_TERM_PROGRAM_PROTOCOLS).toMatchObject({
      ghostty: "osc777",
      "iTerm.app": "osc9",
      WezTerm: "osc777",
      WarpTerminal: "osc777",
      vscode: "osc99",
    });
  });

  it("ships built-in event priorities", () => {
    expect(BUILTIN_EVENT_PRIORITIES).toMatchObject({
      "agent-error": 5,
      "integration-error": 5,
      "input-required": 4,
      "permission-required": 4,
      "agent-completed": 3,
      "task-completed": 3,
      "context-compacted": 2,
    });
  });
});

describe("merging", () => {
  it("recursively merges objects and replaces plain arrays, merging channels by id", () => {
    const merged = mergeConfigLayers(
      {
        herdr: { enabled: true },
        channels: [{ id: "a", type: "osc", events: ["agent-error"] }],
      },
      {
        herdr: { enabled: false },
        channels: [{ id: "b", type: "ntfy", ntfy: { topic: "t" } }],
      },
    );
    expect(merged).toEqual({
      herdr: { enabled: false },
      channels: [
        { id: "a", type: "osc", events: ["agent-error"] },
        { id: "b", type: "ntfy", ntfy: { topic: "t" } },
      ],
    });
  });

  it("merges channels by id and keeps common fields on partial overlay", () => {
    const merged = mergeChannels(
      [
        {
          id: "phone",
          type: "ntfy",
          enabled: true,
          events: ["agent-error"],
          ntfy: { serverUrl: "https://ntfy.sh", topic: "t1", token: "tok" },
        },
      ],
      [{ id: "phone", ntfy: { topic: "${PROJECT_TOPIC}" } }],
    ) as Array<Record<string, unknown>>;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "phone",
      type: "ntfy",
      enabled: true,
      events: ["agent-error"],
    });
    expect(merged[0].ntfy).toEqual({
      serverUrl: "https://ntfy.sh",
      topic: "${PROJECT_TOPIC}",
      token: "tok",
    });
  });

  it("appends new ids as complete instances", () => {
    const merged = mergeChannels(
      [{ id: "terminal", type: "osc" }],
      [{ id: "extra", type: "ntfy", ntfy: { topic: "t" } }],
    ) as Array<Record<string, unknown>>;
    expect(merged.map((entry) => entry.id)).toEqual(["terminal", "extra"]);
  });

  it("discards the old type-specific object when type changes", () => {
    const merged = mergeChannels(
      [
        {
          id: "phone",
          type: "ntfy",
          enabled: true,
          events: ["agent-error"],
          ntfy: { topic: "t1", token: "secret" },
        },
      ],
      [{ id: "phone", type: "osc", osc: { fallback: "osc777" } }],
    ) as Array<Record<string, unknown>>;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      id: "phone",
      type: "osc",
      enabled: true,
      events: ["agent-error"],
      osc: { fallback: "osc777" },
    });
  });
});

describe("channel id conflicts", () => {
  it("reports duplicate ids within one file", () => {
    expect(
      collectChannelIdConflicts({
        channels: [{ id: "a" }, { id: "b" }, { id: "a" }],
      }),
    ).toEqual(["a"]);
  });
});

describe("validation and fault isolation", () => {
  it("drops an invalid ntfy instance but keeps valid channels", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        { id: "terminal", type: "osc" },
        { id: "phone", type: "ntfy", ntfy: { topic: "bad/topic!" } },
        { id: "other", type: "ntfy", ntfy: { topic: "good-topic" } },
      ],
    });
    expect(parsed.config?.channels.map((channel) => channel.id)).toEqual([
      "terminal",
      "other",
    ]);
    expect(parsed.warnings.some((text) => text.includes("phone"))).toBe(true);
  });

  it("rejects invalid priority and timeoutMs and drops the instance", () => {
    const priority = parsePiNotifyConfig({
      channels: [{ id: "a", type: "ntfy", ntfy: { topic: "t", priority: 6 } }],
    });
    expect(priority.config?.channels).toHaveLength(0);

    const timeout = parsePiNotifyConfig({
      channels: [{ id: "a", type: "ntfy", ntfy: { topic: "t", timeoutMs: 0 } }],
    });
    expect(timeout.config?.channels).toHaveLength(0);

    const fractional = parsePiNotifyConfig({
      channels: [
        { id: "a", type: "ntfy", ntfy: { topic: "t", timeoutMs: 1.5 } },
      ],
    });
    expect(fractional.config?.channels).toHaveLength(0);

    const negative = parsePiNotifyConfig({
      channels: [
        { id: "a", type: "ntfy", ntfy: { topic: "t", timeoutMs: -5 } },
      ],
    });
    expect(negative.config?.channels).toHaveLength(0);

    for (const bad of [NaN, Infinity]) {
      const parsed = parsePiNotifyConfig({
        channels: [
          { id: "a", type: "ntfy", ntfy: { topic: "t", timeoutMs: bad } },
        ],
      });
      expect(parsed.config?.channels).toHaveLength(0);
    }
  });

  it("accepts a valid priority and timeoutMs", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        {
          id: "a",
          type: "ntfy",
          ntfy: { topic: "t", priority: 5, timeoutMs: 30000 },
        },
      ],
    });
    expect(parsed.config?.channels[0].ntfy).toMatchObject({
      priority: 5,
      timeoutMs: 30000,
    });
  });

  it("honors empty events as silent and a missing events as default", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        { id: "a", type: "osc", events: [] },
        { id: "b", type: "osc" },
      ],
    });
    expect(parsed.config?.channels[0].events).toEqual([]);
    expect(parsed.config?.channels[1].events).toHaveLength(6);
  });

  it("drops unknown event ids from the subscription list with a warning", () => {
    const parsed = parsePiNotifyConfig({
      channels: [{ id: "a", type: "osc", events: ["agent-error", "nope"] }],
    });
    expect(parsed.config?.channels[0].events).toEqual(["agent-error"]);
    expect(parsed.warnings.some((text) => text.includes("nope"))).toBe(true);
  });

  it("rejects unknown config versions", () => {
    const parsed = parsePiNotifyConfig({ version: 2, channels: [] });
    expect(parsed.config).toBeUndefined();
  });

  it("warns about unknown fields but keeps known behavior", () => {
    const parsed = parsePiNotifyConfig({
      unknownField: 1,
      channels: [{ id: "a", type: "osc", unknownChannelField: true }],
    });
    expect(parsed.config?.channels).toHaveLength(1);
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("pre-configures event options for unsubscribed events", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        {
          id: "a",
          type: "ntfy",
          events: ["agent-error"],
          ntfy: {
            topic: "t",
            eventOptions: { "context-compacted": { priority: 2 } },
          },
        },
      ],
    });
    const ntfy = parsed.config?.channels[0].ntfy;
    expect(ntfy?.eventOptions["context-compacted"]).toEqual({ priority: 2 });
  });

  it("ignores invalid icon values with a warning", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        {
          id: "a",
          type: "ntfy",
          ntfy: { topic: "t", icon: "file:///x.png" },
        },
      ],
    });
    expect(parsed.config?.channels[0].ntfy?.icon).toBeUndefined();
    expect(parsed.warnings.some((text) => text.includes("icon"))).toBe(true);
  });

  it("accepts null icons and http(s) icons", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        {
          id: "a",
          type: "ntfy",
          ntfy: {
            topic: "t",
            icon: null,
            eventOptions: {
              "agent-error": { icon: "https://x.example/i.png" },
            },
          },
        },
      ],
    });
    expect(parsed.config?.channels[0].ntfy?.icon).toBeNull();
    expect(
      parsed.config?.channels[0].ntfy?.eventOptions["agent-error"],
    ).toEqual({
      icon: "https://x.example/i.png",
    });
  });

  it("accepts icon URLs with query strings (only serverUrl is restricted)", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        {
          id: "a",
          type: "ntfy",
          ntfy: {
            topic: "t",
            icon: "https://x.example/i.png?v=4",
          },
        },
      ],
    });
    expect(parsed.config?.channels[0].ntfy?.icon).toBe(
      "https://x.example/i.png?v=4",
    );
    expect(parsed.warnings.some((w) => w.includes("icon"))).toBe(false);
  });
});

describe("priority resolution (event > instance > built-in)", () => {
  const base = {
    serverUrl: "https://ntfy.sh",
    topic: "t",
    timeoutMs: 5000,
    eventOptions: {},
  };

  it("uses built-in levels", () => {
    expect(resolveNtfyPriority("agent-error", { ...base })).toBe(5);
    expect(resolveNtfyPriority("agent-completed", { ...base })).toBe(3);
    expect(resolveNtfyPriority("context-compacted", { ...base })).toBe(2);
  });

  it("lets an explicit instance priority override built-in levels", () => {
    expect(resolveNtfyPriority("agent-error", { ...base, priority: 2 })).toBe(
      2,
    );
  });

  it("lets the event option win over the instance", () => {
    expect(
      resolveNtfyPriority("agent-error", {
        ...base,
        priority: 2,
        eventOptions: { "agent-error": { priority: 4 } },
      }),
    ).toBe(4);
  });
});

describe("icon resolution (event > instance > default)", () => {
  it("uses the default icon when nothing is configured", () => {
    expect(
      resolveNtfyIcon(
        "agent-completed",
        {
          serverUrl: "https://ntfy.sh",
          topic: "t",
          timeoutMs: 5000,
          eventOptions: {},
        },
        "https://cdn.jsdelivr.net/npm/@xzzpig/pi-notify@0.1.0/assets/pi.png",
      ),
    ).toBe(
      "https://cdn.jsdelivr.net/npm/@xzzpig/pi-notify@0.1.0/assets/pi.png",
    );
  });

  it("lets the instance icon override the default", () => {
    expect(
      resolveNtfyIcon(
        "agent-completed",
        {
          serverUrl: "https://ntfy.sh",
          topic: "t",
          timeoutMs: 5000,
          icon: "https://a.example/i.png",
          eventOptions: {},
        },
        "default",
      ),
    ).toBe("https://a.example/i.png");
  });

  it("lets the event icon win and null disable the header", () => {
    const config = {
      serverUrl: "https://ntfy.sh",
      topic: "t",
      timeoutMs: 5000,
      icon: "https://a.example/i.png",
      eventOptions: { "agent-completed": { icon: null } },
    };
    expect(resolveNtfyIcon("agent-completed", config, "default")).toBeNull();
    expect(resolveNtfyIcon("agent-error", config, "default")).toBe(
      "https://a.example/i.png",
    );
  });
});

describe("layered loading", () => {
  it("reads the global config and defaults when no files exist", () => {
    const agentDir = tempDir();
    const loaded = loadPiNotifyConfig({ agentDir, trusted: false });
    expect(loaded.config.channels).toHaveLength(1);
    expect(loaded.config.channels[0].id).toBe("terminal");
  });

  it("ignores an unreadable global config with a warning", () => {
    const agentDir = tempDir();
    const path = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ invalid", "utf8");
    const loaded = loadPiNotifyConfig({ agentDir, trusted: false });
    expect(loaded.config.channels[0].id).toBe("terminal");
    expect(loaded.warnings.some((text) => text.includes("global"))).toBe(true);
  });

  it("ignores a global config with an unsupported version", () => {
    const agentDir = tempDir();
    const path = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 99 }), "utf8");
    const loaded = loadPiNotifyConfig({ agentDir, trusted: false });
    expect(loaded.config.channels[0].id).toBe("terminal");
    expect(loaded.warnings.some((text) => text.includes("version"))).toBe(true);
  });

  it("applies the trusted project overlay but never for untrusted projects", () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    const globalPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({
        channels: [
          {
            id: "phone",
            type: "ntfy",
            ntfy: { topic: "global-topic", token: "tok" },
          },
        ],
      }),
      "utf8",
    );

    const projectPath = getProjectConfigPath(cwd, ".pi");
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(
      projectPath,
      JSON.stringify({
        channels: [{ id: "phone", ntfy: { topic: "project-topic" } }],
      }),
      "utf8",
    );

    const untrusted = loadPiNotifyConfig({ agentDir, cwd, trusted: false });
    expect(
      untrusted.config.channels.find((channel) => channel.id === "phone")?.ntfy
        ?.topic,
    ).toBe("global-topic");

    const trusted = loadPiNotifyConfig({ agentDir, cwd, trusted: true });
    expect(
      trusted.config.channels.find((channel) => channel.id === "phone")?.ntfy
        ?.topic,
    ).toBe("project-topic");
    expect(
      trusted.config.channels.find((channel) => channel.id === "phone")?.ntfy
        ?.token,
    ).toBe("tok");
  });

  it("expands environment variables before validation", () => {
    const agentDir = tempDir();
    const path = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        channels: [
          {
            id: "phone",
            type: "ntfy",
            ntfy: { topic: "${SMOKE_TOPIC}", token: "${SMOKE_TOKEN}" },
          },
        ],
      }),
      "utf8",
    );

    const loaded = loadPiNotifyConfig({
      agentDir,
      trusted: false,
      processEnv: { SMOKE_TOPIC: "env-topic", SMOKE_TOKEN: "env-token" },
    });
    const ntfy = loaded.config.channels.find(
      (channel) => channel.id === "phone",
    )?.ntfy;
    expect(ntfy?.topic).toBe("env-topic");
    expect(ntfy?.token).toBe("env-token");
  });

  it("rejects a serverUrl with query string or fragment", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        {
          id: "a",
          type: "ntfy",
          ntfy: { topic: "t", serverUrl: "http://h/base?x=1" },
        },
      ],
    });
    expect(parsed.config?.channels).toHaveLength(0);
    expect(parsed.warnings.some((w) => w.includes("invalid serverUrl"))).toBe(
      true,
    );

    const parsed2 = parsePiNotifyConfig({
      channels: [
        {
          id: "b",
          type: "ntfy",
          ntfy: { topic: "t", serverUrl: "http://h/base#frag" },
        },
      ],
    });
    expect(parsed2.config?.channels).toHaveLength(0);
    expect(parsed2.warnings.some((w) => w.includes("invalid serverUrl"))).toBe(
      true,
    );
  });

  it("deduplicates channels with repeated ids in one file", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        { id: "a", type: "osc" },
        { id: "a", type: "osc" },
        { id: "b", type: "osc" },
      ],
    });
    expect(parsed.config?.channels).toHaveLength(2);
    expect(
      parsed.warnings.some((w) => w.includes("duplicate channel id")),
    ).toBe(true);
  });

  it("deduplicates repeated events in a channel's subscription list", () => {
    const parsed = parsePiNotifyConfig({
      channels: [
        {
          id: "a",
          type: "osc",
          events: ["agent-error", "agent-completed", "agent-error"],
        },
      ],
    });
    expect(parsed.config?.channels[0].events).toEqual([
      "agent-error",
      "agent-completed",
    ]);
    expect(parsed.warnings.some((w) => w.includes("duplicate event"))).toBe(
      true,
    );
  });

  it("rejects non-array channels with a warning", () => {
    const parsed = parsePiNotifyConfig({ channels: "not-an-array" });
    expect(parsed.config?.channels[0].id).toBe("terminal");
    expect(
      parsed.warnings.some((w) => w.includes("channels must be an array")),
    ).toBe(true);
  });

  it("rejects non-boolean herdr.enabled and falls back to true", () => {
    const parsed = parsePiNotifyConfig({
      herdr: { enabled: "yes" },
      channels: [{ id: "a", type: "osc" }],
    });
    expect(parsed.config?.herdr.enabled).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("herdr.enabled"))).toBe(true);
  });
});
