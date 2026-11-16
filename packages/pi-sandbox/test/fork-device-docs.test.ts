import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilesystemConfigSchema } from "@xzzpig/sandbox-runtime";
import assert from "node:assert/strict";

import { getConfigPaths, type SandboxConfigFile } from "../src/config.ts";
import { loadConfig, validateProfileConfig } from "../src/profile-config.ts";

const markdown = readFileSync(new URL("../FORK-DEVICE-E2E.md", import.meta.url), "utf8");
function example(name: string): SandboxConfigFile {
  const match = markdown.match(
    new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\s*([\\s\\S]*?)\`\`\``),
  );
  assert.ok(match, `missing complete JSON documentation example: ${name}`);
  const config = JSON.parse(match[1]) as SandboxConfigFile;
  if (config.filesystem)
    assert.equal(
      FilesystemConfigSchema.partial().strict().safeParse(config.filesystem).success,
      true,
    );
  for (const [profileName, profile] of Object.entries(config.profiles ?? {}))
    validateProfileConfig(profile, profileName);
  return config;
}

async function fixture(
  run: (f: {
    root: string;
    global(config: SandboxConfigFile): void;
    project(config: SandboxConfigFile): void;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "pi-device-docs-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  mkdirSync(join(root, ".pi"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  const profile = process.env.PI_SUBAGENT_SANDBOX_PROFILE;
  try {
    process.env.PI_CODING_AGENT_DIR = agent;
    delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    const paths = getConfigPaths(root);
    assert.equal(paths.globalPath, join(agent, "sandbox.json"));
    assert.equal(paths.projectPath, join(root, ".pi/sandbox.json"));
    run({
      root,
      global: (config) => writeFileSync(paths.globalPath, JSON.stringify(config)),
      project: (config) => writeFileSync(paths.projectPath, JSON.stringify(config)),
    });
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    if (profile === undefined) delete process.env.PI_SUBAGENT_SANDBOX_PROFILE;
    else process.env.PI_SUBAGENT_SANDBOX_PROFILE = profile;
    rmSync(root, { recursive: true, force: true });
  }
}

test("documented global/project files and trust outcomes match the actual loader", async () => {
  await fixture((f) => {
    f.global(example("device-global"));
    f.project(example("device-project"));
    for (const trust of [true, false, undefined]) {
      assert.deepEqual(
        loadConfig(f.root, { projectTrusted: trust }).filesystem?.allowDevices,
        trust === true ? ["/dev/kvm", "/dev/net/tun"] : ["/dev/kvm"],
      );
    }
  });
});

test("documented profile inheritance, replacement, clearing and clean baseline are executable examples", async () => {
  await fixture((f) => {
    f.global(example("device-profiles"));
    for (const [name, expected] of [
      ["device-inherit", ["/dev/kvm"]],
      ["device-replace", ["/dev/net/tun"]],
      ["device-off", []],
      ["device-clean", []],
    ] as const) {
      assert.deepEqual(
        loadConfig(f.root, { profileName: name, projectTrusted: true }).filesystem?.allowDevices ??
          [],
        expected,
      );
    }
  });
});

test("documented trusted same-name project profile replaces, omits or clears its devices", async () => {
  await fixture((f) => {
    f.global(example("device-profiles"));
    f.project(example("device-project-profiles"));
    for (const trust of [true, false, undefined]) {
      assert.deepEqual(
        loadConfig(f.root, { profileName: "device-replace", projectTrusted: trust }).filesystem
          ?.allowDevices,
        trust === true ? ["/dev/kvm"] : ["/dev/net/tun"],
      );
    }
    f.project({ profiles: { "device-replace": { filesystem: {} } } });
    assert.deepEqual(
      loadConfig(f.root, { profileName: "device-replace", projectTrusted: true }).filesystem
        ?.allowDevices,
      ["/dev/net/tun"],
    );
    f.project({ profiles: { "device-replace": { filesystem: { allowDevices: [] } } } });
    assert.deepEqual(
      loadConfig(f.root, { profileName: "device-replace", projectTrusted: true }).filesystem
        ?.allowDevices,
      [],
    );
  });
});
