/**
 * Integration test for the D4 sandbox profile wiring.
 *
 * Runs against the real workspace-linked @xzzpig/pi-sandbox: extension init
 * must register the three opsx profiles into pi-sandbox's runtime registry so
 * a live SandboxService can select them, a user-defined same-name profile must
 * keep priority, and no registration may ever write a configuration file.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  default as registerSandboxExtension,
  getSandboxService,
  listGlobalSandboxProfiles,
} from "@xzzpig/pi-sandbox";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_ALLOW_WRITE,
  DEFAULT_PLANNER_ALLOW_WRITE,
  DEFAULT_REVIEWER_ALLOW_WRITE,
} from "../src/config.ts";
import piOpenspecX from "../src/index.ts";
import { buildSandboxProfiles } from "../src/sandbox-profiles.ts";

const OPSX_PROFILE_NAMES = ["opsx-agent", "opsx-planner", "opsx-reviewer"];

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

/**
 * The runtime registry is process-global by design; clear it between tests via
 * the documented Symbol.for key so every test registers from a clean slate.
 */
const PROFILE_REGISTRY_KEY = Symbol.for(
  "@xzzpig/pi-sandbox/session-profile-registry",
);

afterEach(() => {
  (
    globalThis as typeof globalThis &
      Record<symbol, Map<string, unknown> | undefined>
  )[PROFILE_REGISTRY_KEY]?.clear();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function createWorkspace(options: { profiles?: Record<string, unknown> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openspec-x-sandbox-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const sandboxJsonPath = path.join(agentDir, "sandbox.json");
  fs.writeFileSync(
    sandboxJsonPath,
    JSON.stringify({ enabled: false, profiles: options.profiles ?? {} }),
  );
  const sandboxJsonBefore = fs.readFileSync(sandboxJsonPath, "utf-8");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { root, cwd, agentDir, sandboxJsonPath, sandboxJsonBefore };
}

function createMockPi() {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const pi = {
    registerFlag() {},
    registerTool() {},
    registerShortcut() {},
    registerCommand() {},
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage() {},
    getAllTools() {
      return [];
    },
    getFlag() {
      return false;
    },
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

function headlessContext(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionContext;
}

/** Load both extensions into mock hosts and start a sandboxed session. */
async function startOpsxSession(
  workspace: ReturnType<typeof createWorkspace>,
  sessionId: string,
) {
  const sandbox = createMockPi();
  registerSandboxExtension(sandbox.pi);
  // The entry point probes pi-sandbox through a lazy dynamic import, so the
  // profile registration completes only once the awaited factory resolves.
  await piOpenspecX(createMockPi().pi);
  const startHandler = sandbox.handlers.get("session_start")?.[0];
  if (!startHandler) {
    throw new Error(
      "the sandbox extension must register a session_start handler",
    );
  }
  await startHandler(
    { reason: "startup" },
    headlessContext(workspace.cwd, sessionId),
  );
  const service = getSandboxService(sessionId);
  expect(
    service,
    "session_start must publish the sandbox service",
  ).toBeDefined();
  return service!;
}

describe("opsx sandbox profiles (D4)", () => {
  it("registers the three opsx profiles and a live session can select them", async () => {
    const workspace = createWorkspace();
    const service = await startOpsxSession(workspace, "opsx-session-1");

    // SandboxService.listProfiles delegates to listGlobalSandboxProfiles; the
    // same surface is checked directly as the equivalent query API.
    expect(service.listProfiles()).toEqual(OPSX_PROFILE_NAMES);
    expect(listGlobalSandboxProfiles(workspace.cwd)).toEqual(
      OPSX_PROFILE_NAMES,
    );

    for (const name of OPSX_PROFILE_NAMES) {
      const selection = await service.setProfile(name);
      expect(
        selection.ok,
        `setProfile('${name}') must succeed: ${selection.message ?? ""}`,
      ).toBe(true);
    }
    expect(service.getProfile()).toBe("opsx-reviewer");

    // Registration is memory-only: the user's configuration is untouched.
    expect(fs.readFileSync(workspace.sandboxJsonPath, "utf-8")).toBe(
      workspace.sandboxJsonBefore,
    );
    expect(fs.existsSync(path.join(workspace.cwd, ".pi", "sandbox.json"))).toBe(
      false,
    );
  });

  it("keeps a user-defined same-name profile in charge over the registration", async () => {
    // The user's own opsx-planner is one the sandbox layer rejects; if the
    // registration had won, selecting it would succeed instead of failing with
    // the user definition's error.
    const workspace = createWorkspace({
      profiles: { "opsx-planner": { enabled: false } },
    });
    const service = await startOpsxSession(workspace, "opsx-session-2");

    const selection = await service.setProfile("opsx-planner");
    expect(selection.ok).toBe(false);
    expect(selection.message ?? "").toMatch(/cannot disable the sandbox/);
    // The remaining registered profiles still resolve.
    expect((await service.setProfile("opsx-reviewer")).ok).toBe(true);

    expect(fs.readFileSync(workspace.sandboxJsonPath, "utf-8")).toBe(
      workspace.sandboxJsonBefore,
    );
  });

  it("builds the three profiles from OpsxConfig with role defaults", () => {
    const overridden = buildSandboxProfiles({
      agentAllowWrite: ["custom-build/**"],
      plannerAllowWrite: ["custom-plan/**"],
      reviewerAllowWrite: ["custom-review/**"],
    });
    expect(Object.keys(overridden).sort()).toEqual(OPSX_PROFILE_NAMES);
    expect(overridden["opsx-agent"]?.filesystem?.allowWrite).toEqual([
      "custom-build/**",
    ]);
    expect(overridden["opsx-planner"]?.filesystem?.allowWrite).toEqual([
      "custom-plan/**",
    ]);
    expect(overridden["opsx-reviewer"]?.filesystem?.allowWrite).toEqual([
      "custom-review/**",
    ]);
    // allowRead is the whole project for every role.
    for (const name of OPSX_PROFILE_NAMES) {
      expect(overridden[name]?.filesystem?.allowRead).toEqual(["."]);
    }

    const defaults = buildSandboxProfiles();
    expect(defaults["opsx-agent"]?.filesystem?.allowWrite).toEqual(
      DEFAULT_AGENT_ALLOW_WRITE,
    );
    expect(defaults["opsx-planner"]?.filesystem?.allowWrite).toEqual(
      DEFAULT_PLANNER_ALLOW_WRITE,
    );
    expect(defaults["opsx-reviewer"]?.filesystem?.allowWrite).toEqual(
      DEFAULT_REVIEWER_ALLOW_WRITE,
    );

    // The built profiles copy their lists, so mutating a result can never
    // corrupt the shared default constants.
    defaults["opsx-planner"]?.filesystem?.allowWrite?.push("mutated/**");
    expect(DEFAULT_PLANNER_ALLOW_WRITE).toEqual(["openspec/**"]);
    expect(
      buildSandboxProfiles()["opsx-planner"]?.filesystem?.allowWrite,
    ).toEqual(["openspec/**"]);
  });
});
