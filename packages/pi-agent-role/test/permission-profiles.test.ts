import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listGlobalPermissionProfiles } from "../src/permission-profiles.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function useAgentDir(config?: string): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-agent-role-permissions-"),
  );
  roots.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  if (config !== undefined) {
    const dir = path.join(root, "extensions", "pi-permission-system");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), config);
  }
  return root;
}

describe("global permission profile registry", () => {
  it("returns no profiles when no configuration exists", () => {
    useAgentDir();

    expect(listGlobalPermissionProfiles()).toEqual({ profiles: [] });
  });

  it("lists profile names sorted and drops unusable keys", () => {
    useAgentDir(
      JSON.stringify({
        profiles: { strict: {}, locked: {}, "": {}, "  ": {} },
      }),
    );

    expect(listGlobalPermissionProfiles()).toEqual({
      profiles: ["locked", "strict"],
    });
  });

  it("treats a configuration without a profiles key as empty", () => {
    useAgentDir(JSON.stringify({ "*": "ask" }));

    expect(listGlobalPermissionProfiles()).toEqual({ profiles: [] });
  });

  it("reports a parse failure instead of throwing", () => {
    useAgentDir("{ not json");

    const registry = listGlobalPermissionProfiles();

    expect(registry.profiles).toEqual([]);
    expect(registry.error).toMatch(/Could not read/);
  });

  it("reports a non-object configuration", () => {
    useAgentDir("[]");

    const registry = listGlobalPermissionProfiles();

    expect(registry.profiles).toEqual([]);
    expect(registry.error).toMatch(/must contain a JSON object/);
  });
});
