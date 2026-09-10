import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  DEFAULT_CONFIG,
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  getConfigPaths,
  mergeConfigLayers,
  mergeProfileLayers,
  loadConfig,
  type SandboxConfigFile,
  validateSandboxProfileName,
} from "../src/config.ts";

test("omitted settings use their defaults", () => {
  const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, {});

  assert.equal(DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS, 600);
  assert.equal(merged.permissionPromptTimeoutSeconds, DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS);
  assert.equal(merged.sandboxUserShell, true);
});

test("network.disabled merges as a scalar with project overriding global", () => {
  const absent = mergeConfigLayers(DEFAULT_CONFIG, {}, {});
  assert.equal(absent.network?.disabled, undefined);

  const globalOnly = mergeConfigLayers(
    DEFAULT_CONFIG,
    { network: { allowedDomains: [], deniedDomains: [], disabled: true } },
    {},
  );
  assert.equal(globalOnly.network?.disabled, true);

  const projectWins = mergeConfigLayers(
    DEFAULT_CONFIG,
    { network: { allowedDomains: [], deniedDomains: [], disabled: true } },
    { network: { disabled: false } },
  );
  assert.equal(projectWins.network?.disabled, false);
});

test("mergeConfigLayers combines configured arrays and deduplicates entries", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      network: {
        allowedDomains: ["global.example.com", "shared.example.com"],
        deniedDomains: ["blocked.example.com"],
        allowUnixSockets: ["/global.sock"],
      },
      filesystem: {
        allowRead: ["/global", "/shared"],
        denyWrite: ["global.key"],
      },
    },
    {
      network: {
        allowedDomains: ["project.example.com", "shared.example.com"],
        deniedDomains: ["project-blocked.example.com"],
        allowUnixSockets: ["/project.sock"],
      },
      filesystem: {
        allowRead: ["/project", "/shared"],
        denyWrite: ["project.key"],
      },
    },
  );

  assert.deepEqual(merged.network?.allowedDomains, [
    "global.example.com",
    "shared.example.com",
    "project.example.com",
  ]);
  assert.deepEqual(merged.network?.deniedDomains, [
    "blocked.example.com",
    "project-blocked.example.com",
  ]);
  assert.deepEqual(merged.network?.allowUnixSockets, ["/global.sock", "/project.sock"]);
  assert.deepEqual(merged.filesystem?.allowRead, ["/global", "/shared", "/project"]);
  assert.deepEqual(merged.filesystem?.denyWrite, ["global.key", "project.key"]);
});

test("mergeConfigLayers ignores malformed permission arrays", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { denyWrite: "*.key" as unknown as string[] } },
    {},
  );

  assert.deepEqual(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem?.denyWrite);
});

test("mergeConfigLayers uses defaults only for arrays not configured by either file", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      enabled: false,
      sandboxUserShell: false,
      permissionPromptTimeoutSeconds: 30,
      filesystem: { allowWrite: [] },
    },
    {
      enabled: true,
      sandboxUserShell: true,
      permissionPromptTimeoutSeconds: 0,
      allowBrowserProcess: true,
    },
  );

  assert.equal(merged.enabled, true);
  assert.equal(merged.sandboxUserShell, true);
  assert.equal(merged.permissionPromptTimeoutSeconds, 0);
  assert.equal(merged.allowBrowserProcess, true);
  assert.deepEqual(merged.filesystem?.allowWrite, []);
  assert.deepEqual(merged.filesystem?.allowRead, DEFAULT_CONFIG.filesystem?.allowRead);
  assert.deepEqual(merged.network?.allowedDomains, DEFAULT_CONFIG.network?.allowedDomains);
});

test("getConfigPaths uses Pi's configured agent directory", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
  try {
    assert.deepEqual(getConfigPaths("/workspace"), {
      globalPath: "/tmp/custom-pi-agent/sandbox.json",
      projectPath: "/workspace/.pi/sandbox.json",
    });
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("profile layers inherit global config by default and replace allow lists", () => {
  const merged = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      network: {
        allowedDomains: ["global.example.com"],
        deniedDomains: ["global-denied.example.com"],
      },
      filesystem: {
        allowRead: ["/global-read"],
        allowWrite: ["/global-write"],
        denyWrite: ["global.secret"],
      },
      profiles: {
        reviewer: {
          network: { allowedDomains: ["profile.example.com"] },
          filesystem: {
            allowRead: ["/profile-read"],
            allowWrite: [],
            denyWrite: ["profile.secret"],
          },
        },
      },
    },
    {
      network: { allowedDomains: ["project.example.com"] },
      filesystem: {
        allowRead: ["/project-read"],
        allowWrite: ["/project-write"],
        denyWrite: ["project.secret"],
      },
    },
    "reviewer",
    true,
  );

  assert.deepEqual(merged.network?.allowedDomains, ["profile.example.com"]);
  assert.deepEqual(merged.filesystem?.allowRead, ["/profile-read"]);
  assert.deepEqual(merged.filesystem?.allowWrite, []);
  assert.deepEqual(merged.network?.deniedDomains, ["global-denied.example.com"]);
  assert.deepEqual(merged.filesystem?.denyWrite, [
    "global.secret",
    "project.secret",
    "profile.secret",
  ]);
});

test("profile inheritGlobalConfig false ignores global settings but keeps trusted project layer and global hard denies", () => {
  const merged = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      network: {
        allowedDomains: ["global.example.com"],
        deniedDomains: ["global-blocked.example.com"],
      },
      filesystem: {
        allowWrite: ["/global-write"],
        denyWrite: ["global.secret"],
      },
      profiles: {
        isolated: {
          inheritGlobalConfig: false,
          network: { allowedDomains: ["isolated.example.com"] },
          filesystem: { allowWrite: [] },
        },
      },
    },
    {
      network: { allowedDomains: ["project.example.com"] },
      filesystem: { allowWrite: ["/project-write"] },
    },
    "isolated",
  );

  assert.deepEqual(merged.network?.allowedDomains, ["isolated.example.com"]);
  assert.deepEqual(merged.network?.deniedDomains, ["global-blocked.example.com"]);
  assert.deepEqual(merged.filesystem?.allowWrite, []);
  assert.deepEqual(merged.filesystem?.denyWrite, ["global.secret"]);
});

test("ordinary config merging ignores the profile registry", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      profiles: {
        reviewer: { filesystem: { allowWrite: [] } },
      },
    },
    {},
  );

  assert.equal("profiles" in merged, false);
  assert.deepEqual(merged.filesystem?.allowWrite, DEFAULT_CONFIG.filesystem?.allowWrite);
});

test("profile layers require explicit project trust by default", () => {
  const globalConfig = {
    profiles: {
      strict: {},
    },
  } satisfies SandboxConfigFile;
  const projectConfig = {
    filesystem: {
      denyWrite: ["project.secret"],
    },
  } satisfies SandboxConfigFile;

  const untrusted = mergeProfileLayers(DEFAULT_CONFIG, globalConfig, projectConfig, "strict");
  const trusted = mergeProfileLayers(DEFAULT_CONFIG, globalConfig, projectConfig, "strict", true);

  assert.equal(untrusted.filesystem?.denyWrite?.includes("project.secret"), false);
  assert.equal(trusted.filesystem?.denyWrite?.includes("project.secret"), true);
});

test("loadConfig defaults selected profiles to global-only project trust", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-profile-trust-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ profiles: { strict: {} } }));
    writeFileSync(
      join(cwd, ".pi", "sandbox.json"),
      JSON.stringify({ filesystem: { denyWrite: ["project.secret"] } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const untrusted = loadConfig(cwd, { profileName: "strict" });
    const trusted = loadConfig(cwd, { profileName: "strict", projectTrusted: true });

    assert.equal(untrusted.filesystem?.denyWrite?.includes("project.secret"), false);
    assert.equal(trusted.filesystem?.denyWrite?.includes("project.secret"), true);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile definitions reject malformed runtime fields", () => {
  const invalidProfiles: Array<{ profile: unknown; expected: RegExp }> = [
    {
      profile: { network: { httpProxyPort: "invalid" } },
      expected: /network contains an invalid sandbox runtime value/,
    },
    {
      profile: { network: { parentProxy: { http: 123 } } },
      expected: /network contains an invalid sandbox runtime value/,
    },
    {
      profile: { network: { tlsTerminate: { caCertPath: "/tmp/ca.pem" } } },
      expected: /network contains an invalid sandbox runtime value/,
    },
    {
      profile: { network: { mitmProxy: { socketPath: "", domains: [] } } },
      expected: /network contains an invalid sandbox runtime value/,
    },
    { profile: { network: { sshProxy: "yes" } }, expected: /sshProxy' must be a boolean/ },
    {
      profile: { filesystem: { protectNonexistentFiles: "yes" } },
      expected: /protectNonexistentFiles' must be a boolean/,
    },
    { profile: { allowBrowserProcess: "yes" }, expected: /allowBrowserProcess' must be a boolean/ },
    {
      profile: { ignoreViolations: { bash: "not-an-array" } },
      expected: /ignoreViolations must map command patterns to arrays of paths/,
    },
  ];

  for (const { profile, expected } of invalidProfiles) {
    assert.throws(
      () =>
        mergeProfileLayers(
          DEFAULT_CONFIG,
          { profiles: { broken: profile } } as unknown as SandboxConfigFile,
          {},
          "broken",
        ),
      expected,
    );
  }
});

test("untrusted project config is excluded for a selected profile", () => {
  const merged = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      profiles: {
        isolated: {
          inheritGlobalConfig: false,
          network: { allowedDomains: ["isolated.example.com"] },
        },
      },
    },
    {
      network: { allowedDomains: ["untrusted.example.com"] },
      filesystem: { allowWrite: ["/untrusted"] },
    },
    "isolated",
    false,
  );

  assert.deepEqual(merged.network?.allowedDomains, ["isolated.example.com"]);
  assert.deepEqual(merged.filesystem?.allowWrite, DEFAULT_CONFIG.filesystem?.allowWrite);
});

test("profile names and definitions fail closed when invalid or missing", () => {
  assert.throws(
    () => validateSandboxProfileName("../escape"),
    /must contain only letters, digits, underscores, or hyphens/,
  );
  assert.throws(
    () => mergeProfileLayers(DEFAULT_CONFIG, {}, {}, "missing"),
    /Sandbox profile 'missing' is not defined/,
  );
  assert.throws(
    () => mergeProfileLayers(DEFAULT_CONFIG, { profiles: { available: {} } }, {}, "missing"),
    /Add it to the global 'profiles' map\. Available profiles: available/,
  );
  assert.throws(
    () =>
      mergeProfileLayers(
        DEFAULT_CONFIG,
        { profiles: { broken: { inheritGlobalConfig: "yes" as unknown as boolean } } },
        {},
        "broken",
      ),
    /inheritGlobalConfig must be a boolean/,
  );
  assert.throws(
    () =>
      mergeProfileLayers(
        DEFAULT_CONFIG,
        { profiles: { broken: { filesystem: { allowWrite: "/tmp" as unknown as string[] } } } },
        {},
        "broken",
      ),
    /allowWrite' must be an array of strings/,
  );
});

test("profiles cannot weaken inherited protection for nonexistent denied write targets", () => {
  assert.throws(
    () =>
      mergeProfileLayers(
        DEFAULT_CONFIG,
        {
          filesystem: {
            protectNonexistentFiles: true,
            denyWrite: ["future-secret.env"],
          },
          profiles: {
            strict: {
              filesystem: { protectNonexistentFiles: false },
            },
          },
        },
        {},
        "strict",
      ),
    /cannot disable 'filesystem\.protectNonexistentFiles'/,
  );

  const tightened = mergeProfileLayers(
    DEFAULT_CONFIG,
    { profiles: { strict: { filesystem: { protectNonexistentFiles: true } } } },
    {},
    "strict",
  );
  assert.equal(tightened.filesystem?.protectNonexistentFiles, true);

  const profileHardDeny = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      filesystem: { denyWrite: ["global-future-secret.env"] },
      profiles: { strict: {} },
    },
    {},
    "strict",
  );
  assert.equal(profileHardDeny.filesystem?.protectNonexistentFiles, true);

  assert.throws(
    () =>
      mergeProfileLayers(
        DEFAULT_CONFIG,
        {
          filesystem: { protectNonexistentFiles: true, denyWrite: ["global-future-secret.env"] },
          profiles: {
            strict: { inheritGlobalConfig: false, filesystem: { protectNonexistentFiles: false } },
          },
        },
        { filesystem: { protectNonexistentFiles: false } },
        "strict",
        true,
      ),
    /cannot disable 'filesystem\.protectNonexistentFiles'/,
  );
});

test("selected profiles reject malformed hard-deny layers instead of dropping them", () => {
  assert.throws(
    () =>
      mergeProfileLayers(
        DEFAULT_CONFIG,
        {
          network: { deniedDomains: "blocked.example.com" as unknown as string[] },
          profiles: { strict: {} },
        },
        {},
        "strict",
      ),
    /Global sandbox configuration\.network\.deniedDomains must be an array of strings/,
  );
  assert.throws(
    () =>
      mergeProfileLayers(
        DEFAULT_CONFIG,
        { profiles: { strict: {} } },
        { filesystem: { denyWrite: "*.secret" as unknown as string[] } },
        "strict",
        true,
      ),
    /Project sandbox configuration\.filesystem\.denyWrite must be an array of strings/,
  );
});

test("permission writers only persist the property being changed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");

  addReadPathToConfig(configPath, "/read");
  addWritePathToConfig(configPath, "/write");
  addDomainToConfig(configPath, "example.com");

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written, {
    network: { allowedDomains: ["example.com"] },
    filesystem: {
      allowRead: ["/read"],
      allowWrite: ["/write"],
    },
  });
});
