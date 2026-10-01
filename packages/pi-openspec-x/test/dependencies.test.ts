/**
 * Dependency-state tests (design D7; spec "受限模式 fail-closed").
 *
 * The dynamic-import failure path is simulated through the injectable loader —
 * node_modules is never touched. The resources_discover case pins the spec
 * guarantee that a missing pi-sandbox must not block other capabilities: the
 * handler still generates and returns the official-track skills normally.
 */
import type {
  ExtensionAPI,
  ResourcesDiscoverResult,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import { resetOpenspecVersionCacheForTests } from "../src/cli.ts";
import {
  goalXAvailability,
  GOAL_X_DEPENDENCY,
  loadSessionSandboxService,
  noteSandboxUnavailable,
  OpsxDependencyMissingError,
  probeGoalXDependency,
  probeSandboxDependency,
  requireGoalXSupport,
  requireRestrictedModeSupport,
  resetDependencyStateForTests,
  SANDBOX_DEPENDENCY,
  sandboxAvailability,
  type GoalXModuleFacet,
  type SandboxModuleFacet,
  type SandboxModuleLoader,
  type SandboxServiceLike,
} from "../src/dependencies.ts";
import {
  createResourcesDiscoverHandler,
  resetResourcesDiscoverStateForTests,
} from "../src/discover.ts";
import { fakeCliEnv, makeFakeCliDir, makeTempDir } from "./helpers.ts";

beforeEach(() => {
  resetDependencyStateForTests();
  resetResourcesDiscoverStateForTests();
  resetOpenspecVersionCacheForTests();
});

/** A loader whose dynamic import rejects, as when the module is absent. */
const missingModuleLoader: SandboxModuleLoader = async () => {
  throw new Error(
    "Cannot find package '@xzzpig/pi-sandbox' imported from extension",
  );
};

function createFakeService(
  behavior: { ok?: boolean; message?: string } = {},
): SandboxServiceLike & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    async setProfile(profileName) {
      calls.push(profileName);
      return { ok: behavior.ok ?? true, message: behavior.message };
    },
  };
}

function createFakeModule(
  service: SandboxServiceLike | undefined,
): SandboxModuleFacet & {
  seenSessionIds: Array<string | undefined>;
} {
  const seenSessionIds: Array<string | undefined> = [];
  return {
    seenSessionIds,
    registerSandboxProfiles() {},
    getSandboxService(sessionId?: string) {
      seenSessionIds.push(sessionId);
      return service;
    },
  };
}

describe("probeSandboxDependency", () => {
  test("a failing dynamic import is recorded as unavailable, never thrown", async () => {
    const result = await probeSandboxDependency(missingModuleLoader);
    expect(result.available).toBe(false);
    expect(result.reason).toContain("dynamic import failed");
    expect(result.reason).toContain("@xzzpig/pi-sandbox");
    expect(result.module).toBeUndefined();
    expect(sandboxAvailability()).toEqual({
      available: false,
      reason: result.reason,
    });
  });

  test("a module without the expected exports is recorded as incompatible", async () => {
    const result = await probeSandboxDependency(async () => ({ foo: 1 }));
    expect(result.available).toBe(false);
    expect(result.reason).toContain("registerSandboxProfiles");
    expect(result.reason).toContain("incompatible");
  });

  test("a valid module is recorded as available and its facet reused", async () => {
    const module = createFakeModule(createFakeService());
    const result = await probeSandboxDependency(async () => module);
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.module).toBeDefined();
    expect(sandboxAvailability()).toEqual({ available: true });
    expect(requireRestrictedModeSupport()).toBe(result.module);
  });

  test("a fresh session reports 'not probed yet' as the refusal reason", () => {
    expect(sandboxAvailability()).toEqual({
      available: false,
      reason: expect.stringContaining("not been probed"),
    });
  });

  test("noteSandboxUnavailable downgrades a recorded module with the reason", async () => {
    await probeSandboxDependency(async () => createFakeModule(undefined));
    noteSandboxUnavailable(
      "registering the opsx sandbox profiles failed: boom",
    );
    expect(sandboxAvailability()).toEqual({
      available: false,
      reason: expect.stringContaining("boom"),
    });
  });

  test("resetDependencyStateForTests restores the unprobed state", async () => {
    await probeSandboxDependency(missingModuleLoader);
    resetDependencyStateForTests();
    expect(sandboxAvailability().reason).toContain("not been probed");
  });
});

describe("requireRestrictedModeSupport (fail-closed gate)", () => {
  test("missing module: throws the typed error naming the dependency and what keeps working", async () => {
    await probeSandboxDependency(missingModuleLoader);
    expect(() => requireRestrictedModeSupport()).toThrow(
      OpsxDependencyMissingError,
    );
    try {
      requireRestrictedModeSupport();
      expect.unreachable("gate must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OpsxDependencyMissingError);
      const missing = error as OpsxDependencyMissingError;
      expect(missing.name).toBe("OpsxDependencyMissingError");
      expect(missing.dependency).toBe(SANDBOX_DEPENDENCY);
      expect(missing.reason).toContain("dynamic import failed");
      expect(missing.message).toContain("@xzzpig/pi-sandbox");
      expect(missing.message).toMatch(/restricted modes/i);
      expect(missing.message).toMatch(/fail-closed/i);
      expect(missing.message).toMatch(
        /official openspec skills are unaffected/i,
      );
    }
  });

  test("available module: passes through the facet", async () => {
    const module = createFakeModule(createFakeService());
    const probed = await probeSandboxDependency(async () => module);
    expect(requireRestrictedModeSupport()).toBe(probed.module);
  });
});

describe("loadSessionSandboxService", () => {
  test("returns undefined while the dependency is missing", async () => {
    await probeSandboxDependency(missingModuleLoader);
    await expect(loadSessionSandboxService("s-1")).resolves.toBeUndefined();
  });

  test("returns the session service and passes the session id through", async () => {
    const service = createFakeService();
    const module = createFakeModule(service);
    await probeSandboxDependency(async () => module);
    await expect(loadSessionSandboxService("s-1")).resolves.toBe(service);
    expect(module.seenSessionIds).toEqual(["s-1"]);
  });

  test("returns undefined when the lookup throws or the object lacks setProfile", async () => {
    const throwing = createFakeModule(undefined);
    throwing.getSandboxService = () => {
      throw new Error("registry exploded");
    };
    await probeSandboxDependency(async () => throwing);
    await expect(loadSessionSandboxService("s-1")).resolves.toBeUndefined();

    await probeSandboxDependency(async () =>
      createFakeModule({} as SandboxServiceLike),
    );
    await expect(loadSessionSandboxService("s-1")).resolves.toBeUndefined();
  });
});

describe("restricted mode base does not block other capabilities", () => {
  test("resources_discover still generates and returns skills while pi-sandbox is missing", async () => {
    await probeSandboxDependency(missingModuleLoader);
    const sendMessage = () => {};
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const projectDir = makeTempDir("pi-openspec-x-project-");
    const handler = createResourcesDiscoverHandler(
      { sendMessage } as unknown as ExtensionAPI,
      { env: fakeCliEnv(makeFakeCliDir(), { PI_CODING_AGENT_DIR: agentDir }) },
    );
    const result = handler(
      { type: "resources_discover", cwd: projectDir, reason: "startup" },
      {} as never,
    ) as ResourcesDiscoverResult;
    expect(result).toBeDefined();
    expect(result.skillPaths).toHaveLength(1);
    expect(
      fs.existsSync(
        path.join(result.skillPaths![0], "openspec-propose", "SKILL.md"),
      ),
    ).toBe(true);
  });
});

function createFakeGoalXFacet(): GoalXModuleFacet {
  return {
    setGoalAuditorOverride() {},
    clearGoalAuditorOverride() {},
    registerAuditorAgentResolver: () => () => {},
    readChangeBaseline: () => undefined,
    computeChangeDelta: async () => ({
      goalId: "goal-1",
      repos: [],
      empty: true,
      truncated: false,
      diagnostics: [],
    }),
  };
}

describe("probeGoalXDependency (task 6.6 fail-closed)", () => {
  test("a missing pi-goal-x is recorded and requireGoalXSupport throws the typed refusal", async () => {
    // The command-level refusal (/opsx:implement returns the message and
    // starts no flow) is covered in implement-command.test.ts; this test pins
    // the recorded state and the gate itself.
    const result = await probeGoalXDependency(async () => {
      throw new Error("Cannot find package '@xzzpig/pi-goal-x'");
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("expected goal-x to be unavailable");
    expect(result.reason).toContain("dynamic import failed");
    expect(goalXAvailability()).toEqual({
      available: false,
      reason: result.reason,
    });

    try {
      requireGoalXSupport();
      expect.unreachable("gate must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OpsxDependencyMissingError);
      const missing = error as OpsxDependencyMissingError;
      expect(missing.dependency).toBe(GOAL_X_DEPENDENCY);
      expect(missing.message).toContain("/opsx:implement is refused");
      expect(missing.message).toContain("/opsx:plan are unaffected");
    }
  });

  test("a loaded module missing the fork APIs is recorded as incompatible", async () => {
    const result = await probeGoalXDependency(async () => ({
      setGoalAuditorOverride() {},
    }));
    expect(result.available).toBe(false);
    if (result.available) throw new Error("expected goal-x to be incompatible");
    expect(result.reason).toContain("required export(s) are missing");
    expect(result.reason).toContain("computeChangeDelta");
  });

  test("a complete facet is recorded and reused by the gate", async () => {
    const facet = createFakeGoalXFacet();
    const result = await probeGoalXDependency(async () => facet);
    expect(result.available).toBe(true);
    expect(goalXAvailability()).toEqual({ available: true });
    expect(requireGoalXSupport()).toBe(facet);
  });

  test("an unprobed session reports 'not been probed yet'", () => {
    expect(goalXAvailability()).toEqual({
      available: false,
      reason: expect.stringContaining("not been probed"),
    });
  });

  test("resetDependencyStateForTests restores the unprobed goal-x state", async () => {
    await probeGoalXDependency(async () => createFakeGoalXFacet());
    resetDependencyStateForTests();
    expect(goalXAvailability().reason).toContain("not been probed");
  });
});
