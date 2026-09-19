import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";

import { SandboxManager } from "@xzzpig/sandbox-runtime";
import assert from "node:assert/strict";

import type { SandboxConfig } from "../src/config.ts";

import { DEFAULT_CONFIG, mergeConfigLayers } from "../src/config.ts";
import { canonicalizePath } from "../src/policy.ts";
import { mergeProfileLayers } from "../src/profile-config.ts";
import {
  buildRuntimeConfig,
  createSandboxedBashOps,
  extractBlockedWritePath,
  resolveAllowances,
  supportsNodeEnvProxy,
  type SandboxCommandOutcome,
} from "../src/sandbox-runtime.ts";
import {
  collectBlockedWritePaths,
  extractDeniedWritePathFromOutput,
  hasSandboxWriteDenialText,
  sandboxWriteDenialNotice,
} from "../src/write-denial.ts";

function createExecTestContext(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-exec-"));

  // Exercise exec without an OS sandbox session: identity wrap, no SSH proxy.
  mock.method(SandboxManager, "wrapWithSandbox", async (command: string) => command);
  t.after(() => {
    mock.restoreAll();
    rmSync(cwd, { recursive: true, force: true });
  });

  return { cwd };
}

test("default denyWrite drops non-existent literal entries when the opt-out is active", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-sb-denytest-"));
  const originalCwd = process.cwd();
  process.chdir(tmp);
  try {
    // No .env in the project: the built-in default literal entry is dropped so
    // bwrap does not materialize a placeholder mount point for it. Glob
    // patterns pass through untouched.
    const runtime = buildRuntimeConfig(DEFAULT_CONFIG);
    assert.equal(runtime.filesystem?.denyWrite?.includes(canonicalizePath(".env")), false);
    assert.deepEqual(runtime.filesystem?.denyWrite, [".env.*", "*.pem", "*.key"]);

    // An existing .env keeps full write protection.
    writeFileSync(join(tmp, ".env"), "TEST=1");
    const withEnv = buildRuntimeConfig(DEFAULT_CONFIG);
    assert.equal(withEnv.filesystem?.denyWrite?.includes(canonicalizePath(".env")), true);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("user-configured denyWrite literals are filtered when non-existent (false)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-sb-denyuser-"));
  const originalCwd = process.cwd();
  process.chdir(tmp);
  try {
    // Default (false): a user-configured literal path that does not exist is
    // dropped entirely — no placeholder, no protection.
    const runtime = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(runtime.filesystem?.denyWrite, []);

    // An existing user-configured entry keeps full write protection.
    writeFileSync(join(tmp, "custom.key"), "k");
    const withExisting = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(withExisting.filesystem?.denyWrite, [canonicalizePath("custom.key")]);

    // Explicit true: legacy behavior — non-existent user denies stay in place
    // and are protected via placeholder mounts.
    const protectAll = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        protectNonexistentFiles: true,
        denyWrite: ["secrets/does-not-exist.env", "custom.key"],
      },
    });
    assert.deepEqual(protectAll.filesystem?.denyWrite, [
      canonicalizePath("secrets/does-not-exist.env"),
      canonicalizePath("custom.key"),
    ]);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("profile hard denyWrite rules retain nonexistent literal paths in runtime sandbox config", () => {
  const profileConfig = mergeProfileLayers(
    DEFAULT_CONFIG,
    {
      profiles: {
        strict: {
          filesystem: { denyWrite: ["future-secret.env"] },
        },
      },
    },
    {},
    "strict",
  );

  assert.equal(profileConfig.filesystem?.protectNonexistentFiles, true);
  const runtime = buildRuntimeConfig(profileConfig);
  assert.ok(runtime.filesystem?.denyWrite?.includes(canonicalizePath("future-secret.env")));
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

test("DEFAULT_CONFIG disables placeholder protection for non-existent dangerous files", () => {
  // pi-sandbox wants encoding tools (git status, lint glob scans, …) to see the
  // real directory during a sandboxed run, so the default is the opposite of the
  // runtime default (true).
  assert.equal(DEFAULT_CONFIG.filesystem?.protectNonexistentFiles, false);
});

test("protectNonexistentFiles survives mergeConfigLayers and can be set to true", () => {
  const mergedDefault = mergeConfigLayers(DEFAULT_CONFIG, {}, {});
  assert.equal(mergedDefault.filesystem?.protectNonexistentFiles, false);

  const mergedTrue = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { protectNonexistentFiles: true } },
    {},
  );
  assert.equal(mergedTrue.filesystem?.protectNonexistentFiles, true);

  const mergedProjectOverride = mergeConfigLayers(
    DEFAULT_CONFIG,
    {},
    { filesystem: { protectNonexistentFiles: true } },
  );
  assert.equal(mergedProjectOverride.filesystem?.protectNonexistentFiles, true);

  const runtime = buildRuntimeConfig(mergedTrue, {
    domains: [],
    readPaths: [],
    writePaths: [],
  });
  assert.equal(runtime.filesystem?.protectNonexistentFiles, true);
});

test("buildRuntimeConfig passes network.disabled through to the runtime config", () => {
  const disabled: SandboxConfig = {
    ...DEFAULT_CONFIG,
    network: {
      ...DEFAULT_CONFIG.network,
      allowedDomains: ["example.com"],
      deniedDomains: [],
      disabled: true,
    },
  };

  const runtime = buildRuntimeConfig(disabled);
  assert.equal(runtime.network?.disabled, true);
  assert.deepEqual(runtime.network?.allowedDomains, ["example.com"]);

  // Default config leaves the flag unset, preserving today's behavior.
  const enabled = buildRuntimeConfig(DEFAULT_CONFIG);
  assert.equal(enabled.network?.disabled, undefined);
});

test("collectBlockedWritePaths parses monitor violations within the time window", () => {
  const queries: string[] = [];
  const now = Date.now();
  const manager = {
    getSandboxViolationStore: () => ({
      getViolationsForCommand: (command: string) => {
        queries.push(command);
        return [
          // Before the window: a leftover from an earlier identical command.
          { line: "deny open /var/log/old", command, timestamp: new Date(now - 1) },
          { line: "deny mkdir /var/tmp/my dir", command, timestamp: new Date(now) },
          // Duplicated inside the window: deduplicated by path.
          { line: "deny open /etc/hosts", command, timestamp: new Date(now + 1) },
          { line: "deny open /etc/hosts", command, timestamp: new Date(now + 2) },
          { line: "deny open /etc/passwd", command, timestamp: new Date(now + 3) },
          // Not a violation line: dropped rather than guessed.
          { line: "allow open /etc/hosts", command, timestamp: new Date(now + 4) },
        ];
      },
    }),
  };

  assert.deepEqual(collectBlockedWritePaths(manager, "npm install", now), [
    { syscall: "mkdir", path: "/var/tmp/my dir" },
    { syscall: "open", path: "/etc/hosts" },
    { syscall: "open", path: "/etc/passwd" },
  ]);
  assert.deepEqual(queries, ["npm install"]);
});

test("createSandboxedBashOps reports monitor violations for the executed command", async (t) => {
  const { cwd } = createExecTestContext(t);
  // exec samples its start time after this test line, so violations must be
  // stamped in the future to land inside the collection window.
  const violationTime = new Date(Date.now() + 60_000);
  mock.method(SandboxManager, "getSandboxViolationStore", () => ({
    getViolationsForCommand: (command: string) =>
      command === "echo blocked-write"
        ? [{ line: "deny open /etc/hosts", command, timestamp: violationTime }]
        : [],
  }));

  const outcomes: SandboxCommandOutcome[] = [];
  const ops = createSandboxedBashOps(SandboxManager, undefined, false, (outcome) =>
    outcomes.push(outcome),
  );
  const { exitCode } = await ops.exec("echo blocked-write", cwd, { onData: () => {} });

  assert.equal(exitCode, 0);
  assert.deepEqual(outcomes, [
    { command: "echo blocked-write", blockedWrites: [{ syscall: "open", path: "/etc/hosts" }] },
  ]);
});

test("createSandboxedBashOps reports an empty outcome without violations", async (t) => {
  const { cwd } = createExecTestContext(t);
  mock.method(SandboxManager, "getSandboxViolationStore", () => ({
    getViolationsForCommand: () => [],
  }));

  const outcomes: SandboxCommandOutcome[] = [];
  const ops = createSandboxedBashOps(SandboxManager, undefined, false, (outcome) =>
    outcomes.push(outcome),
  );
  const { exitCode } = await ops.exec("exit 0", cwd, { onData: () => {} });

  assert.equal(exitCode, 0);
  assert.deepEqual(outcomes, [{ command: "exit 0", blockedWrites: [] }]);
});

test("createSandboxedBashOps skips violation collection without a callback", async (t) => {
  const { cwd } = createExecTestContext(t);
  mock.method(SandboxManager, "getSandboxViolationStore", () => {
    throw new Error("store must not be queried without a callback");
  });

  assert.deepEqual(
    await createSandboxedBashOps(SandboxManager, undefined, false).exec("exit 0", cwd, {
      onData: () => {},
    }),
    { exitCode: 0 },
  );
});

test("sandboxWriteDenialNotice attributes blocked writes to the sandbox", () => {
  const fallback = sandboxWriteDenialNotice({});
  assert.match(fallback, /OS-level sandbox, not by the filesystem/);
  assert.match(fallback, /Do not diagnose this as a broken or read-only disk/);
  assert.match(fallback, /The write target is outside this session's allowWrite paths\./);
  assert.match(fallback, /sandbox-allow write <path>/);

  const listed = sandboxWriteDenialNotice({
    blockedWrites: [
      { syscall: "open", path: "/etc/hosts" },
      { syscall: "mkdir", path: "/var/tmp/a b" },
    ],
  });
  assert.match(listed, /Blocked writes:/);
  assert.match(listed, /deny open \/etc\/hosts/);
  assert.match(listed, /deny mkdir \/var\/tmp\/a b/);

  const extracted = sandboxWriteDenialNotice({ outputExtractedPath: "/private/file" });
  assert.match(extracted, /Blocked path: "\/private\/file"\./);

  const declined = sandboxWriteDenialNotice({ promptDeclinedPath: "/etc/hosts" });
  assert.match(declined, /dismissed or timed out/);
  assert.match(declined, /do not retry the same write unprompted/);

  const configDenied = sandboxWriteDenialNotice({
    blockedWrites: [{ syscall: "open", path: "/etc/hosts" }],
    allDeniedByConfig: true,
  });
  assert.match(configDenied, /explicitly denied by the sandbox's denyWrite config/);
  assert.match(configDenied, /run \/sandbox to see the configuration/);

  const stillFailing = sandboxWriteDenialNotice({ allowedStillFailingPath: "/var/tmp/new.txt" });
  assert.match(stillFailing, /was allowed for this session but the write still fails/);
  assert.match(stillFailing, /paths that already exist/);
  assert.match(stillFailing, /"\/sandbox-allow write \/var\/tmp"/);
});

test("hasSandboxWriteDenialText matches only OS denial text", () => {
  assert.equal(hasSandboxWriteDenialText("bash: line 1: /x: Read-only file system"), true);
  assert.equal(hasSandboxWriteDenialText("Error: EROFS: read-only filesystem, open '/x'"), true);
  assert.equal(hasSandboxWriteDenialText("tee: /x: Operation not permitted"), true);
  assert.equal(hasSandboxWriteDenialText("cat: /x: Permission denied"), false);
  assert.equal(hasSandboxWriteDenialText("cat: /x: No such file or directory"), false);
  assert.equal(hasSandboxWriteDenialText("all good"), false);
});

test("extractDeniedWritePathFromOutput recovers blocked paths in degraded mode", () => {
  // bash redirection (the reported Linux/WSL2 EROFS case)
  assert.equal(
    extractDeniedWritePathFromOutput("bash: line 1: /var/tmp/x.txt: Read-only file system"),
    "/var/tmp/x.txt",
  );
  assert.equal(
    extractDeniedWritePathFromOutput("tee: /etc/hosts: Read-only file system"),
    "/etc/hosts",
  );
  assert.equal(
    extractDeniedWritePathFromOutput("zsh:1: read-only file system: /etc/hosts"),
    "/etc/hosts",
  );
  assert.equal(
    extractDeniedWritePathFromOutput("sh: 1: cannot create /etc/hosts: Read-only file system"),
    "/etc/hosts",
  );
  assert.equal(
    extractDeniedWritePathFromOutput("touch: cannot touch '/etc/hosts': Read-only file system"),
    "/etc/hosts",
  );
  assert.equal(
    extractDeniedWritePathFromOutput("Error: EROFS: read-only filesystem, open '/project/new.txt'"),
    "/project/new.txt",
  );
  // Non-denial errors stay untouched
  assert.equal(extractDeniedWritePathFromOutput("cat: /x: Permission denied"), null);
  assert.equal(extractDeniedWritePathFromOutput("cat: /x: No such file or directory"), null);
});
