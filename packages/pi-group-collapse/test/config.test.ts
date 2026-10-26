/**
 * Configuration layering tests (change task 1.4).
 *
 * Pins the whole group-collapse.json contract: file locations, project
 * table replacing (not concatenating) the global table, whole-layer strict
 * validation with fallback, issue reporting for deduplicated notices, and
 * the snapshot's detachment from later file edits. All filesystem access
 * is injected, so no test reads or writes user configuration.
 */

import { describe, expect, test } from "vitest";
import { CONFIG_FILE_NAME, loadGroupCollapseConfig } from "../src/config.ts";

type Files = Record<string, string | undefined>;

function reader(files: Files) {
  const reads: string[] = [];
  const readFile = (path: string): string | undefined => {
    reads.push(path);
    return files[path];
  };
  return { readFile, reads };
}

const AGENT_DIR = "/agent-home";
const PROJECT_DIR = "/project";
const GLOBAL_PATH = `${AGENT_DIR}/${CONFIG_FILE_NAME}`;
const PROJECT_PATH = `${PROJECT_DIR}/.pi/${CONFIG_FILE_NAME}`;

function load(files: Files) {
  const { readFile, reads } = reader(files);
  const snapshot = loadGroupCollapseConfig({
    cwd: PROJECT_DIR,
    agentDir: AGENT_DIR,
    readFile,
  });
  return { snapshot, reads };
}

describe("layer resolution", () => {
  test("missing files fall back to built-in defaults with no issues", () => {
    const { snapshot, reads } = load({});
    expect(snapshot.source).toBe("defaults");
    expect(snapshot.rules).toEqual([]);
    expect(snapshot.issues).toEqual([]);
    // Exactly one read per layer, nothing polled or re-read.
    expect(reads).toEqual([GLOBAL_PATH, PROJECT_PATH]);
  });

  test("the project table replaces the global table entirely", () => {
    const { snapshot } = load({
      [GLOBAL_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "update_goal", action: "keep" }],
      }),
      [PROJECT_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "bash", action: "keep" }],
      }),
    });
    expect(snapshot.source).toBe("project");
    expect(snapshot.rules).toEqual([
      { kind: "tool", name: "bash", action: "keep" },
    ]);
  });

  test("a project file without a rules field inherits the global table", () => {
    const { snapshot } = load({
      [GLOBAL_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "update_goal", action: "keep" }],
      }),
      [PROJECT_PATH]: JSON.stringify({}),
    });
    expect(snapshot.source).toBe("global");
    expect(snapshot.rules).toEqual([
      { kind: "tool", name: "update_goal", action: "keep" },
    ]);
    expect(snapshot.issues).toEqual([]);
  });

  test("an explicitly empty project table restores the defaults", () => {
    const { snapshot } = load({
      [GLOBAL_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "update_goal", action: "keep" }],
      }),
      [PROJECT_PATH]: JSON.stringify({ rules: [] }),
    });
    expect(snapshot.source).toBe("project");
    expect(snapshot.rules).toEqual([]);
  });
});

describe("strict validation", () => {
  test("invalid JSON rejects only that layer and reports the file", () => {
    const { snapshot } = load({
      [GLOBAL_PATH]: "{not json",
    });
    expect(snapshot.source).toBe("defaults");
    expect(snapshot.issues).toEqual([
      { file: GLOBAL_PATH, reason: expect.stringContaining("invalid JSON") },
    ]);
  });

  test("a rejected project layer falls back to the valid global layer", () => {
    const { snapshot } = load({
      [GLOBAL_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "read", action: "keep" }],
      }),
      [PROJECT_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "", action: "group" }],
      }),
    });
    expect(snapshot.source).toBe("global");
    expect(snapshot.rules).toEqual([
      { kind: "tool", name: "read", action: "keep" },
    ]);
    expect(snapshot.issues).toEqual([
      {
        file: PROJECT_PATH,
        reason: expect.stringContaining("rules[0]"),
      },
    ]);
  });

  test("unknown top-level fields reject the layer", () => {
    const { snapshot } = load({
      [PROJECT_PATH]: JSON.stringify({ rules: [], extra: true }),
    });
    expect(snapshot.source).toBe("defaults");
    expect(snapshot.issues).toEqual([
      {
        file: PROJECT_PATH,
        reason: expect.stringContaining("unknown top-level field"),
      },
    ]);
  });

  test("kind-inappropriate fields reject the rule (and thus the layer)", () => {
    const files: Files = {
      [PROJECT_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "bash", action: "group", level: "info" }],
      }),
    };
    const { snapshot } = load(files);
    expect(snapshot.source).toBe("defaults");
    expect(snapshot.issues[0]?.reason).toContain("unknown field");
  });

  test("empty selection conditions are rejected", () => {
    const cases: unknown[][] = [
      [{ kind: "tool", name: "", action: "group" }],
      [{ kind: "customMessage", customType: "", action: "group" }],
      [{ kind: "notification", textPrefix: "", action: "group" }],
    ];
    for (const rules of cases) {
      const { snapshot } = load({
        [PROJECT_PATH]: JSON.stringify({ rules }),
      });
      expect(snapshot.source).toBe("defaults");
      expect(snapshot.issues.length).toBe(1);
    }
  });

  test("invalid actions and levels are rejected", () => {
    const { snapshot: actionSnapshot } = load({
      [PROJECT_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "bash", action: "toggle" }],
      }),
    });
    expect(actionSnapshot.issues[0]?.reason).toContain("action");

    const { snapshot: levelSnapshot } = load({
      [PROJECT_PATH]: JSON.stringify({
        rules: [
          {
            kind: "notification",
            textPrefix: "x:",
            level: "verbose",
            action: "group",
          },
        ],
      }),
    });
    expect(levelSnapshot.issues[0]?.reason).toContain("level");
  });

  test("a valid notification rule parses with and without a level", () => {
    const { snapshot } = load({
      [PROJECT_PATH]: JSON.stringify({
        rules: [
          { kind: "notification", textPrefix: "Prefix:", action: "group" },
          {
            kind: "notification",
            textPrefix: "Other:",
            level: "info",
            action: "keep",
          },
          {
            kind: "customMessage",
            customType: "pi-goal-audit-event",
            action: "group",
          },
        ],
      }),
    });
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.rules).toEqual([
      { kind: "notification", textPrefix: "Prefix:", action: "group" },
      {
        kind: "notification",
        textPrefix: "Other:",
        level: "info",
        action: "keep",
      },
      {
        kind: "customMessage",
        customType: "pi-goal-audit-event",
        action: "group",
      },
    ]);
  });
});

describe("snapshot immutability", () => {
  test("later file edits never leak into an already-loaded snapshot", () => {
    let current: string | undefined = JSON.stringify({
      rules: [{ kind: "tool", name: "bash", action: "keep" }],
    });
    const readFile = (path: string): string | undefined =>
      path === PROJECT_PATH ? current : undefined;
    const first = loadGroupCollapseConfig({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      readFile,
    });
    expect(first.rules.length).toBe(1);

    current = JSON.stringify({
      rules: [{ kind: "tool", name: "read", action: "keep" }],
    });
    // The snapshot was taken at load time; edits do not hot-apply.
    expect(first.rules[0]).toMatchObject({ name: "bash" });

    // A fresh load (reload) sees the new content.
    const second = loadGroupCollapseConfig({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      readFile,
    });
    expect(second.rules[0]).toMatchObject({ name: "read" });
  });

  test("the snapshot object is frozen", () => {
    const { snapshot } = load({
      [PROJECT_PATH]: JSON.stringify({
        rules: [{ kind: "tool", name: "bash", action: "keep" }],
      }),
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rules)).toBe(true);
    expect(Object.isFrozen(snapshot.issues)).toBe(true);
  });
});
