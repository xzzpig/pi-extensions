import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { openspecXSkillsDir, resolveAgentDir } from "../src/agent-dir.ts";

describe("resolveAgentDir", () => {
  test("honors an absolute PI_CODING_AGENT_DIR (normalized)", () => {
    expect(
      resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent//x" }, "/home/u"),
    ).toBe(path.normalize("/tmp/agent/x"));
  });

  test("resolves a relative override against homeDir", () => {
    expect(
      resolveAgentDir({ PI_CODING_AGENT_DIR: "pi/agent" }, "/home/u"),
    ).toBe("/home/u/pi/agent");
  });

  test("falls back to <homeDir>/.pi/agent when unset", () => {
    expect(resolveAgentDir({}, "/home/u")).toBe(
      path.join("/home/u", ".pi", "agent"),
    );
  });

  test("treats a blank override as unset", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "   " }, "/home/u")).toBe(
      path.join("/home/u", ".pi", "agent"),
    );
  });
});

describe("openspecXSkillsDir", () => {
  test("appends cache/pi-openspec-x/skills/<version> to the agent dir", () => {
    expect(openspecXSkillsDir("/a", "1.2.3")).toBe(
      path.join("/a", "cache", "pi-openspec-x", "skills", "1.2.3"),
    );
  });
});
