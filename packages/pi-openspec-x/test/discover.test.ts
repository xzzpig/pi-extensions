import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
} from "@earendil-works/pi-coding-agent";
import {
  resetOpenspecVersionCacheForTests,
  type SpawnSyncLike,
} from "../src/cli.ts";
import {
  CLI_MISSING_NOTICE_CUSTOM_TYPE,
  createResourcesDiscoverHandler,
  resetResourcesDiscoverStateForTests,
} from "../src/discover.ts";
import { OPENSPEC_SKILL_NAMES } from "../src/skills.ts";
import {
  OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME,
  OPSX_PLAN_VERDICT_TOOL_NAME,
} from "../src/plan-gate.ts";
import {
  REPORT_GAP_ANALYSIS_TOOL_NAME,
  REPORT_PLAN_REVIEW_TOOL_NAME,
  REPORT_WORK_TOOL_NAME,
} from "../src/report-tools.ts";
import {
  findStaticSkillConflicts,
  STATIC_CONFLICT_CUSTOM_TYPE,
  staticConflictMessage,
} from "../src/static-conflict.ts";
import {
  FAKE_CLI_VERSION,
  fakeCliEnv,
  makeFakeCliDir,
  makeTempDir,
} from "./helpers.ts";

beforeEach(() => {
  resetResourcesDiscoverStateForTests();
  resetOpenspecVersionCacheForTests();
});

function makeHarness() {
  const sendMessage = vi.fn();
  const pi = { sendMessage } as unknown as ExtensionAPI & {
    sendMessage: typeof sendMessage;
  };
  const ctx = { cwd: "/irrelevant" } as ExtensionContext;
  const event = (
    cwd: string,
    reason: "startup" | "reload",
  ): ResourcesDiscoverEvent => ({
    type: "resources_discover",
    cwd,
    reason,
  });
  return { pi, sendMessage, ctx, event };
}

interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
}

function callsOfType(
  sendMessage: ReturnType<typeof vi.fn>,
  customType: string,
): Array<[SentMessage, unknown?]> {
  return sendMessage.mock.calls
    .filter((call) => (call[0] as SentMessage).customType === customType)
    .map((call) => [call[0] as SentMessage, call[1] as unknown]);
}

describe("resources_discover handler (real fake CLI)", () => {
  test("startup: returns the generated skills dir and writes all skill files", () => {
    const { pi, sendMessage, ctx, event } = makeHarness();
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const projectDir = makeTempDir("pi-openspec-x-project-");
    const handler = createResourcesDiscoverHandler(pi, {
      env: fakeCliEnv(makeFakeCliDir(), { PI_CODING_AGENT_DIR: agentDir }),
    });

    const result = handler(
      event(projectDir, "startup"),
      ctx,
    ) as ResourcesDiscoverResult;
    const expectedDir = path.join(
      agentDir,
      "cache",
      "pi-openspec-x",
      "skills",
      FAKE_CLI_VERSION,
    );

    expect(result).toEqual({ skillPaths: [expectedDir] });
    for (const name of OPENSPEC_SKILL_NAMES) {
      expect(fs.existsSync(path.join(expectedDir, name, "SKILL.md"))).toBe(
        true,
      );
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("reload: the second invocation does not run the CLI again (spawn count stays flat)", () => {
    const { pi, ctx, event } = makeHarness();
    const agentDir = makeTempDir("pi-openspec-x-agent-");
    const projectDir = makeTempDir("pi-openspec-x-project-");
    const env = fakeCliEnv(makeFakeCliDir());
    const spawnImpl = vi.fn<SpawnSyncLike>((file, args, options) =>
      spawnSync(file, args, options),
    );
    const handler = createResourcesDiscoverHandler(pi, {
      env,
      agentDir,
      spawnImpl,
    });

    const first = handler(
      event(projectDir, "startup"),
      ctx,
    ) as ResourcesDiscoverResult;
    const callsAfterFirst = spawnImpl.mock.calls.length;
    expect(callsAfterFirst).toBe(2); // --version + schemas --json

    const second = handler(
      event(projectDir, "reload"),
      ctx,
    ) as ResourcesDiscoverResult;
    expect(spawnImpl.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  test("missing CLI: returns empty skillPaths, does not throw, and sends the notice exactly once", () => {
    const { pi, sendMessage, ctx, event } = makeHarness();
    const projectDir = makeTempDir("pi-openspec-x-project-");
    const handler = createResourcesDiscoverHandler(pi, {
      env: { PATH: "" },
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });

    const first = handler(
      event(projectDir, "startup"),
      ctx,
    ) as ResourcesDiscoverResult;
    expect(first).toEqual({ skillPaths: [] });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const notice = sendMessage.mock.calls[0]?.[0] as {
      customType: string;
      content: string;
      display: boolean;
    };
    expect(notice.customType).toBe(CLI_MISSING_NOTICE_CUSTOM_TYPE);
    expect(notice.display).toBe(true);
    expect(notice.content).toContain("openspec");

    const second = handler(
      event(projectDir, "reload"),
      ctx,
    ) as ResourcesDiscoverResult;
    expect(second).toEqual({ skillPaths: [] });
    expect(sendMessage).toHaveBeenCalledTimes(1); // one-time flag held
  });
});

describe("static same-name skill detection (handler wiring)", () => {
  function makeProjectWithStaticSkill(): {
    projectDir: string;
    staticDir: string;
  } {
    const projectDir = makeTempDir("pi-openspec-x-conflict-");
    const staticDir = path.join(
      projectDir,
      ".pi",
      "skills",
      "openspec-propose",
    );
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(
      path.join(staticDir, "SKILL.md"),
      "static official skill\n",
      "utf-8",
    );
    return { projectDir, staticDir };
  }

  test("a static openspec-propose dir triggers one notice listing the path, and the file survives", () => {
    const { pi, sendMessage, ctx, event } = makeHarness();
    const { projectDir, staticDir } = makeProjectWithStaticSkill();
    const handler = createResourcesDiscoverHandler(pi, {
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });

    handler(event(projectDir, "startup"), ctx);

    const conflictCalls = callsOfType(sendMessage, STATIC_CONFLICT_CUSTOM_TYPE);
    expect(conflictCalls).toHaveLength(1);
    const message = conflictCalls[0]?.[0] as { content: string };
    expect(message.content).toContain(staticDir);
    expect(message.content).toContain("removing the directories listed above");
    expect(conflictCalls[0]?.[1]).toEqual({ deliverAs: "followUp" });
    // The extension never deletes project files.
    expect(fs.readFileSync(path.join(staticDir, "SKILL.md"), "utf-8")).toBe(
      "static official skill\n",
    );

    handler(event(projectDir, "reload"), ctx);
    expect(callsOfType(sendMessage, STATIC_CONFLICT_CUSTOM_TYPE)).toHaveLength(
      1,
    ); // once per cwd
  });

  test("a project without static openspec skills gets no conflict notice", () => {
    const { pi, sendMessage, ctx, event } = makeHarness();
    const projectDir = makeTempDir("pi-openspec-x-clean-");
    const handler = createResourcesDiscoverHandler(pi, {
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });

    handler(event(projectDir, "startup"), ctx);
    expect(callsOfType(sendMessage, STATIC_CONFLICT_CUSTOM_TYPE)).toHaveLength(
      0,
    );
  });

  test("all five generated skill names are checked for conflicts", () => {
    const { pi, sendMessage, ctx, event } = makeHarness();
    const projectDir = makeTempDir("pi-openspec-x-conflict-all-");
    const created = OPENSPEC_SKILL_NAMES.map((name) => {
      const dir = path.join(projectDir, ".pi", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    });
    const handler = createResourcesDiscoverHandler(pi, {
      env: fakeCliEnv(makeFakeCliDir()),
      agentDir: makeTempDir("pi-openspec-x-agent-"),
    });

    handler(event(projectDir, "startup"), ctx);
    const message = (callsOfType(
      sendMessage,
      STATIC_CONFLICT_CUSTOM_TYPE,
    )[0]?.[0] ?? {}) as { content: string };
    for (const dir of created) {
      expect(message.content).toContain(dir);
    }
  });
});

describe("unit surface of the conflict helpers", () => {
  test("findStaticSkillConflicts only reports existing directories", () => {
    const projectDir = makeTempDir("pi-openspec-x-detect-");
    const present = path.join(
      projectDir,
      ".pi",
      "skills",
      "openspec-archive-change",
    );
    fs.mkdirSync(present, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "skills", "not-a-skill"),
      "file, not dir\n",
      "utf-8",
    );

    expect(findStaticSkillConflicts(projectDir)).toEqual([present]);
  });

  test("staticConflictMessage includes every path and the no-delete reassurance", () => {
    const message = staticConflictMessage([
      "/p/.pi/skills/openspec-propose",
      "/p/.pi/skills/openspec-explore",
    ]);
    expect(message).toContain("/p/.pi/skills/openspec-propose");
    expect(message).toContain("/p/.pi/skills/openspec-explore");
    expect(message).toContain("never deletes");
  });
});

describe("extension entry point wiring", () => {
  // The entry point also lazily probes @xzzpig/pi-sandbox (D4 sandbox
  // profile registration) and @xzzpig/pi-subagents (D3 runtime agents),
  // whose dependency graphs dominate the first import under vitest; the
  // default 5s timeout is too tight on slower hosts.
  test(
    "default export registers the reporting tools and the event handlers",
    { timeout: 20_000 },
    async () => {
      const { default: piOpenspecX } = await import("../src/index.ts");
      const on = vi.fn(() => () => {});
      const registerTool = vi.fn();
      const registerCommand = vi.fn();
      const registerEntryRenderer = vi.fn();
      await piOpenspecX({
        on,
        registerTool,
        registerCommand,
        registerEntryRenderer,
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI);
      // session_start three times: the agents registration retry (D3), the
      // stale-identity cleanup (mode.ts) and the goal-base recovery notice
      // (task 6.4); resources_discover once; turn_end three times (plan flow
      // 7.1, implement flow 8.3, status snapshot 9.1); tool_result once (the
      // implement flow's same-turn S1 override install, the implement flow's
      // lifecycle tool observer, and the enforced tick gate).
      expect(on).toHaveBeenCalledTimes(11);
      expect(on).toHaveBeenCalledWith(
        "resources_discover",
        expect.any(Function),
      );
      expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
      expect(on).toHaveBeenCalledWith("turn_end", expect.any(Function));
      // The /opsx:plan command registers at init (task 7.1).
      expect(registerCommand).toHaveBeenCalledWith(
        "opsx:plan",
        expect.objectContaining({ handler: expect.any(Function) }),
      );
      // The flow entry renderers register at init (task 9.1; six types).
      expect(registerEntryRenderer).toHaveBeenCalledTimes(7);
      // The three child reporting tools (D3) plus the two parent gate tools
      // (tasks 7.2/7.3) register at init.
      expect(registerTool).toHaveBeenCalledTimes(5);
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: REPORT_GAP_ANALYSIS_TOOL_NAME }),
      );
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: REPORT_PLAN_REVIEW_TOOL_NAME }),
      );
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: REPORT_WORK_TOOL_NAME }),
      );
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME,
        }),
      );
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: OPSX_PLAN_VERDICT_TOOL_NAME,
        }),
      );
    },
  );
});
