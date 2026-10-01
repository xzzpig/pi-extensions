/**
 * Tests for the opsx configuration loader (task B2 fix).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_ALLOW_WRITE,
  loadOpsxConfig,
  OPSX_CONFIG_FILE,
} from "../src/config.ts";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("loadOpsxConfig", () => {
  it("returns no overrides when neither file exists", () => {
    expect(
      loadOpsxConfig({
        agentDir: tempDir("opsx-agent-"),
        cwd: tempDir("opsx-cwd-"),
      }),
    ).toEqual({});
  });

  it("reads the global file from the agent dir", () => {
    const agentDir = tempDir("opsx-agent-");
    fs.writeFileSync(
      path.join(agentDir, OPSX_CONFIG_FILE),
      JSON.stringify({ plannerAllowWrite: ["openspec/**", "notes/**"] }),
    );
    expect(loadOpsxConfig({ agentDir, cwd: tempDir("opsx-cwd-") })).toEqual({
      plannerAllowWrite: ["openspec/**", "notes/**"],
    });
  });

  it("lets the project file override field by field", () => {
    const agentDir = tempDir("opsx-agent-");
    const cwd = tempDir("opsx-cwd-");
    fs.writeFileSync(
      path.join(agentDir, OPSX_CONFIG_FILE),
      JSON.stringify({
        agentAllowWrite: ["openspec/**"],
        reviewerAllowWrite: ["reports/**"],
      }),
    );
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", OPSX_CONFIG_FILE),
      JSON.stringify({ agentAllowWrite: ["openspec/**", "dist/**"] }),
    );
    expect(loadOpsxConfig({ agentDir, cwd })).toEqual({
      agentAllowWrite: ["openspec/**", "dist/**"],
      reviewerAllowWrite: ["reports/**"],
    });
  });

  it("ignores a malformed file instead of throwing", () => {
    const agentDir = tempDir("opsx-agent-");
    const cwd = tempDir("opsx-cwd-");
    fs.writeFileSync(path.join(agentDir, OPSX_CONFIG_FILE), "{ not json");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", OPSX_CONFIG_FILE), "[1,2,3]");
    expect(loadOpsxConfig({ agentDir, cwd })).toEqual({});
  });

  it("drops non-array and non-string entries", () => {
    const agentDir = tempDir("opsx-agent-");
    fs.writeFileSync(
      path.join(agentDir, OPSX_CONFIG_FILE),
      JSON.stringify({
        agentAllowWrite: "openspec/**",
        plannerAllowWrite: ["openspec/**", 7, "", "  ", "notes/**"],
      }),
    );
    expect(loadOpsxConfig({ agentDir, cwd: tempDir("opsx-cwd-") })).toEqual({
      plannerAllowWrite: ["openspec/**", "notes/**"],
    });
  });

  it("defaults stay in config.ts and are not duplicated by the loader", () => {
    // The agent write boundary has exactly one source of truth; the loader
    // only ever supplies an override.
    expect(
      loadOpsxConfig({
        agentDir: tempDir("opsx-agent-"),
        cwd: tempDir("opsx-cwd-"),
      }).agentAllowWrite,
    ).toBeUndefined();
    expect(DEFAULT_AGENT_ALLOW_WRITE).toContain("dist/**");
  });
});
