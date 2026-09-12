import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { describe, expect, it } from "vitest";

import {
  findRoleAgent,
  isAgentDiscoveryUnavailable,
  listRoleAgents,
} from "../src/discovery.ts";

const pi = { on() {}, registerTool() {} } as unknown as ExtensionAPI;

describe("role agent discovery", () => {
  it("reports a missing pi-subagents instead of throwing", async () => {
    const result = await listRoleAgents(
      pi,
      "/tmp/pi-agent-role-project",
      async () => ({
        error:
          "pi-agent-role needs @xzzpig/pi-subagents to list agents. Install it and run /reload.",
      }),
    );

    expect(isAgentDiscoveryUnavailable(result)).toBe(true);
    if (isAgentDiscoveryUnavailable(result)) {
      expect(result.error).toMatch(/pi-subagents/);
    }
  });

  it("reports an incompatible module shape as unavailable", async () => {
    const result = await listRoleAgents(
      pi,
      "/tmp/pi-agent-role-project",
      async () => ({
        error:
          "pi-agent-role needs @xzzpig/pi-subagents to list agents. Install it and run /reload.",
      }),
    );

    expect(isAgentDiscoveryUnavailable(result)).toBe(true);
  });

  it("maps discovery results into pickable candidates", async () => {
    const result = await listRoleAgents(
      pi,
      "/tmp/pi-agent-role-project",
      async () => ({
        discoverAgentsWithRuntime: () => ({
          agents: [
            {
              name: "worker",
              description: "Implements tasks",
              aliases: ["coder"],
              source: "builtin",
              sandbox: "strict",
              permissionProfile: "locked",
            },
            {
              name: "project-helper",
              description: "Project agent",
              source: "project",
              override: { scope: "project" },
            },
            {
              name: "legacy",
              description: "Disabled",
              source: "user",
              disabled: true,
            },
          ],
          agentDiagnostics: [
            {
              source: "project",
              name: "broken",
              error: "Invalid sandbox profile",
            },
          ],
          projectAgentsDir: "/tmp/pi-agent-role-project/.pi/agents",
        }),
      }),
    );

    expect(isAgentDiscoveryUnavailable(result)).toBe(false);
    if (isAgentDiscoveryUnavailable(result)) return;

    expect(result.agents.map((agent) => agent.name)).toEqual([
      "worker",
      "project-helper",
    ]);
    expect(result.agents[0]).toMatchObject({
      name: "worker",
      aliases: ["coder"],
      sandboxProfile: "strict",
      permissionProfile: "locked",
      projectScoped: false,
    });
    expect(result.agents[1]?.projectScoped).toBe(true);
    expect(result.diagnostics).toEqual(["broken: Invalid sandbox profile"]);
    expect(result.projectAgentsDir).toBe(
      "/tmp/pi-agent-role-project/.pi/agents",
    );
  });

  it("resolves a candidate by name or alias", () => {
    const agents = [
      {
        name: "worker",
        description: "",
        aliases: ["coder"],
        source: "builtin",
        projectScoped: false,
      },
      {
        name: "reviewer",
        description: "",
        aliases: [],
        source: "builtin",
        projectScoped: false,
      },
    ];

    expect(findRoleAgent(agents, "worker")?.name).toBe("worker");
    expect(findRoleAgent(agents, " coder ")?.name).toBe("worker");
    expect(findRoleAgent(agents, "missing")).toBeUndefined();
  });
});
