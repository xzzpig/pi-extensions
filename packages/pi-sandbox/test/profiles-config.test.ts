import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG, type SandboxConfigFile } from "../src/config.ts";
import {
  loadConfig,
  mergeConfigLayers,
  mergeProfileLayers,
  mergeProfileObjects,
  validateSandboxProfileName,
} from "../src/profile-config.ts";

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

test("loadConfig warns instead of throwing when an untrusted project defines profiles", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-project-profiles-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ profiles: { strict: {} } }));
    writeFileSync(
      join(cwd, ".pi", "sandbox.json"),
      JSON.stringify({
        profiles: {
          "project-dev": { filesystem: { allowWrite: ["build/"] } },
          extra: { filesystem: { allowWrite: ["out/"] } },
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const warnings: string[] = [];
    // Untrusted: the project registry is ignored and the skip is reported
    // rather than thrown (an ignored definition must not fail every launch).
    const untrusted = loadConfig(cwd, {
      profileName: "strict",
      projectTrusted: false,
      onWarning: (message) => warnings.push(message),
    });
    assert.ok(untrusted.filesystem);
    assert.deepEqual(warnings, [
      "Project defines 2 sandbox profiles that were not applied (project is not trusted).",
    ]);

    // Trusted: the same registry participates, so nothing is skipped.
    const trustedWarnings: string[] = [];
    loadConfig(cwd, {
      profileName: "strict",
      projectTrusted: true,
      onWarning: (message) => trustedWarnings.push(message),
    });
    assert.deepEqual(trustedWarnings, []);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig warns for an untrusted project with no profile selected", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-project-profiles-none-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ profiles: { strict: {} } }));
    writeFileSync(
      join(cwd, ".pi", "sandbox.json"),
      JSON.stringify({ profiles: { "project-dev": {} } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const warnings: string[] = [];
    loadConfig(cwd, { projectTrusted: false, onWarning: (message) => warnings.push(message) });
    assert.deepEqual(warnings, [
      "Project defines 1 sandbox profile that was not applied (project is not trusted).",
    ]);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig resolves a trusted project-only profile for a stamped name", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-project-only-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ profiles: {} }));
    writeFileSync(
      join(cwd, ".pi", "sandbox.json"),
      JSON.stringify({
        profiles: { "project-dev": { filesystem: { allowWrite: ["build/"] } } },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const trusted = loadConfig(cwd, { profileName: "project-dev", projectTrusted: true });
    assert.deepEqual(trusted.filesystem?.allowWrite, ["build/"]);

    // Untrusted: the same name resolves nowhere and fails closed with the
    // trust-aware diagnostic.
    assert.throws(
      () => loadConfig(cwd, { profileName: "project-dev", projectTrusted: false }),
      /defined only in the project sandbox configuration, which is not trusted/,
    );
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

test("mergeProfileObjects replaces allow arrays and unions deny arrays", () => {
  const merged = mergeProfileObjects(
    {
      filesystem: {
        allowWrite: ["/tmp"],
        denyWrite: ["/secrets", "*.env"],
        allowRead: ["~/.config"],
      },
    },
    {
      filesystem: {
        allowWrite: ["build/"],
        denyRead: ["/private"],
      },
    },
    "dev",
  );

  // allow arrays: the project layer replaces the global value.
  assert.deepEqual(merged.filesystem?.allowWrite, ["build/"]);
  assert.deepEqual(merged.filesystem?.allowRead, ["~/.config"]);
  // deny arrays: unioned, so the global deny survives.
  assert.deepEqual(merged.filesystem?.denyWrite, ["/secrets", "*.env"]);
  assert.deepEqual(merged.filesystem?.denyRead, ["/private"]);
});

test("mergeProfileObjects cannot clear a global deny with an empty project array", () => {
  const merged = mergeProfileObjects(
    { filesystem: { denyWrite: ["/secrets"], denyRead: ["/private"] } },
    { filesystem: { denyWrite: [], denyRead: [] } },
    "dev",
  );
  assert.deepEqual(merged.filesystem?.denyWrite, ["/secrets"]);
  assert.deepEqual(merged.filesystem?.denyRead, ["/private"]);
});

test("mergeProfileObjects unions deniedDomains and replaces allow lists", () => {
  const merged = mergeProfileObjects(
    {
      network: {
        allowedDomains: ["npmjs.org"],
        deniedDomains: ["evil.example.com"],
        allowUnixSockets: ["/var/run/docker.sock"],
      },
    },
    {
      network: {
        allowedDomains: ["internal.example.com"],
        deniedDomains: [],
      },
    },
    "dev",
  );
  assert.deepEqual(merged.network?.allowedDomains, ["internal.example.com"]);
  assert.deepEqual(merged.network?.deniedDomains, ["evil.example.com"]);
  assert.deepEqual(merged.network?.allowUnixSockets, ["/var/run/docker.sock"]);
});

test("mergeProfileObjects clamps restricted booleans to the global profile baseline", () => {
  // The global profile does not relax these, so the project layer may not.
  assert.throws(
    () => mergeProfileObjects({}, { allowBrowserProcess: true }, "dev"),
    /Sandbox profile 'dev' cannot enable 'allowBrowserProcess'/,
  );
  assert.throws(
    () =>
      mergeProfileObjects(
        {},
        { enableWeakerNestedSandbox: true, enableWeakerNetworkIsolation: true },
        "dev",
      ),
    /cannot enable 'enableWeakerNestedSandbox'/,
  );
  assert.throws(
    () => mergeProfileObjects({}, { network: { allowLocalBinding: true } }, "dev"),
    /cannot enable 'network.allowLocalBinding'/,
  );
  assert.throws(
    () =>
      mergeProfileObjects(
        {},
        { network: { allowAllUnixSockets: true, allowUnauthenticatedSocksProxy: true } },
        "dev",
      ),
    /cannot enable 'network.allowAllUnixSockets'/,
  );

  // A global profile that already relaxes them keeps them relaxed.
  const relaxed = mergeProfileObjects(
    { allowBrowserProcess: true },
    { allowBrowserProcess: true },
    "dev",
  );
  assert.equal(relaxed.allowBrowserProcess, true);
});

test("mergeProfileObjects cannot lower protectNonexistentFiles", () => {
  assert.throws(
    () =>
      mergeProfileObjects(
        { filesystem: { protectNonexistentFiles: true } },
        { filesystem: { protectNonexistentFiles: false } },
        "dev",
      ),
    /cannot disable 'filesystem\.protectNonexistentFiles'/,
  );

  // A project's literal denyWrite entry keeps the pre-creation hard boundary.
  const literalDeny = mergeProfileObjects(
    {},
    { filesystem: { denyWrite: ["future-secret.env"] } },
    "dev",
  );
  assert.equal(literalDeny.filesystem?.protectNonexistentFiles, true);
});

test("mergeProfileObjects keeps inheritGlobalConfig narrowing sticky", () => {
  assert.equal(
    mergeProfileObjects({ inheritGlobalConfig: false }, {}, "dev").inheritGlobalConfig,
    false,
  );
  assert.equal(
    mergeProfileObjects({}, { inheritGlobalConfig: false }, "dev").inheritGlobalConfig,
    false,
  );
  assert.equal(
    mergeProfileObjects({ inheritGlobalConfig: true }, {}, "dev").inheritGlobalConfig,
    true,
  );
});

test("a trusted project-only profile resolves directly", () => {
  const merged = mergeProfileLayers(
    DEFAULT_CONFIG,
    {},
    {
      profiles: {
        "project-dev": {
          network: { allowedDomains: ["internal.example.com"] },
          filesystem: { allowWrite: ["build/"] },
        },
      },
    },
    "project-dev",
    true,
  );

  assert.deepEqual(merged.network?.allowedDomains, ["internal.example.com"]);
  assert.deepEqual(merged.filesystem?.allowWrite, ["build/"]);
  // The inherited baseline's deny boundary is untouched.
  assert.deepEqual(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem?.denyWrite);
});

test("a same-named trusted project profile merges onto the global profile", () => {
  const merged = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      profiles: {
        dev: {
          filesystem: { allowWrite: ["/tmp"], denyWrite: ["/secrets"] },
          network: { allowedDomains: ["npmjs.org"], deniedDomains: ["evil.example.com"] },
        },
      },
    },
    {
      profiles: {
        dev: {
          filesystem: { allowWrite: ["build/"] },
          network: { allowedDomains: ["internal.example.com"] },
        },
      },
    },
    "dev",
    true,
  );

  // Project allow arrays replace the global profile's values.
  assert.deepEqual(merged.filesystem?.allowWrite, ["build/"]);
  assert.deepEqual(merged.network?.allowedDomains, ["internal.example.com"]);
  // Global profile denies survive the project layer.
  assert.deepEqual(merged.filesystem?.denyWrite?.includes("/secrets"), true);
  assert.deepEqual(merged.network?.deniedDomains, ["evil.example.com"]);
});

test("an untrusted project-only profile fails closed with a trust diagnostic", () => {
  assert.throws(
    () =>
      mergeProfileLayers(
        DEFAULT_CONFIG,
        {},
        { profiles: { "project-dev": { filesystem: { allowWrite: ["build/"] } } } },
        "project-dev",
        false,
      ),
    /defined only in the project sandbox configuration, which is not trusted/,
  );
});

test("an untrusted project's same-named profile is ignored, not merged", () => {
  const merged = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      profiles: {
        dev: { filesystem: { allowWrite: ["/tmp"], denyWrite: ["/secrets"] } },
      },
    },
    {
      profiles: {
        dev: { filesystem: { allowWrite: ["build/"], denyWrite: [] } },
      },
    },
    "dev",
    false,
  );

  // The project layer never contributed: the global profile's own values hold.
  assert.deepEqual(merged.filesystem?.allowWrite, ["/tmp"]);
  assert.deepEqual(merged.filesystem?.denyWrite?.includes("/secrets"), true);
});

test("an untrusted project's malformed registry does not fail a global-name launch", () => {
  const merged = mergeProfileLayers(
    DEFAULT_CONFIG,
    { profiles: { dev: { filesystem: { allowWrite: ["/tmp"] } } } },
    { profiles: "not-a-registry" as unknown as Record<string, never> },
    "dev",
    false,
  );

  assert.deepEqual(merged.filesystem?.allowWrite, ["/tmp"]);
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
