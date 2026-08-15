import { describe, expect, it } from "vitest";
import { renderLegacyMessage } from "#src/presentation/legacy-message";
import type {
  PromptEvidence,
  PromptPayload,
  PromptPayloadKind,
  PromptRequestFacts,
} from "#src/presentation/prompt-payload";

/**
 * Build a payload directly, without a gate.
 *
 * `renderLegacyMessage` reads nothing but the payload, so these cases are the
 * proof that the payload carries everything today's prompt sentence says.
 */
function payload(
  kind: PromptPayloadKind,
  request: Partial<PromptRequestFacts> = {},
  evidence: PromptEvidence[] = [],
): PromptPayload {
  return {
    kind,
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "bash",
      toolName: null,
      invokedToolName: null,
      value: "",
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
      ...request,
    },
    evidence,
    annotations: [],
  };
}

function evidence(
  label: string,
  text: string,
  detail: string | null = null,
): PromptEvidence {
  return { label, text, detail };
}

describe("renderLegacyMessage", () => {
  describe("the requesting subject", () => {
    it("names the agent when one is known", () => {
      expect(
        renderLegacyMessage(
          payload("skill", {
            requester: {
              agentName: "my-agent",
              forwarded: false,
              sessionId: null,
            },
            value: "librarian",
          }),
        ),
      ).toBe(
        "Agent 'my-agent' requested skill 'librarian'. Allow loading this skill?",
      );
    });

    it("falls back to 'Current agent' when none is", () => {
      expect(
        renderLegacyMessage(payload("skill", { value: "librarian" })),
      ).toBe(
        "Current agent requested skill 'librarian'. Allow loading this skill?",
      );
    });
  });

  describe("bash", () => {
    it("renders the command alone", () => {
      expect(renderLegacyMessage(payload("bash", { value: "rm -rf /" }))).toBe(
        "Current agent requested bash command 'rm -rf /'. Allow this command?",
      );
    });

    it("appends the matched pattern", () => {
      expect(
        renderLegacyMessage(
          payload("bash", { value: "rm -rf /", matchedPattern: "rm *" }),
        ),
      ).toBe(
        "Current agent requested bash command 'rm -rf /' (matched 'rm *'). Allow this command?",
      );
    });

    it("folds the execution context into the qualifier", () => {
      expect(
        renderLegacyMessage(
          payload("bash", {
            value: "rm c",
            matchedPattern: "rm *",
            commandContext: "command_substitution",
          }),
        ),
      ).toBe(
        "Current agent requested bash command 'rm c' (matched 'rm *', inside command substitution). Allow this command?",
      );
    });

    it("appends the full command when the unit is only part of it", () => {
      expect(
        renderLegacyMessage(
          payload("bash", { value: "rm x" }, [
            evidence("full command", "cd /repo && rm x"),
          ]),
        ),
      ).toBe(
        "Current agent requested bash command 'rm x' (full command: 'cd /repo && rm x'). Allow this command?",
      );
    });

    it("does not yet render the executed unit", () => {
      expect(
        renderLegacyMessage(
          payload("bash", {
            value: "xargs grep foo",
            executedUnit: "grep foo",
          }),
        ),
      ).toBe(
        "Current agent requested bash command 'xargs grep foo'. Allow this command?",
      );
    });
  });

  describe("mcp", () => {
    it("renders the target alone", () => {
      expect(renderLegacyMessage(payload("mcp", { value: "exa:search" }))).toBe(
        "Current agent requested MCP target 'exa:search'. Allow this call?",
      );
    });

    it("appends the matched pattern and the input preview", () => {
      expect(
        renderLegacyMessage(
          payload("mcp", { value: "exa:search", matchedPattern: "exa:*" }, [
            evidence("input", "with input {}"),
          ]),
        ),
      ).toBe(
        "Current agent requested MCP target 'exa:search' (matched 'exa:*') with input {}. Allow this call?",
      );
    });
  });

  describe("tool", () => {
    it("renders the tool name alone", () => {
      expect(renderLegacyMessage(payload("tool", { value: "task" }))).toBe(
        "Current agent requested tool 'task'. Allow this call?",
      );
    });

    it("appends the matched pattern and the input preview", () => {
      expect(
        renderLegacyMessage(
          payload("tool", { value: "read", matchedPattern: "read" }, [
            evidence("input", "for path '/foo.ts'"),
          ]),
        ),
      ).toBe(
        "Current agent requested tool 'read' (matched 'read') for path '/foo.ts'. Allow this call?",
      );
    });
  });

  describe("path", () => {
    it("names the tool and the path", () => {
      expect(
        renderLegacyMessage(
          payload("path", { toolName: "read", value: "/etc/hosts" }),
        ),
      ).toBe(
        "Current agent requested tool 'read' for path '/etc/hosts'. Allow this path access?",
      );
    });
  });

  describe("external_directory", () => {
    it("names the working directory the path escapes", () => {
      expect(
        renderLegacyMessage(
          payload("external_directory", { toolName: "read", value: "/tmp/x" }, [
            evidence("working directory", "/repo"),
          ]),
        ),
      ).toBe(
        "Current agent requested tool 'read' for path '/tmp/x' outside working directory '/repo'. Allow this external directory access?",
      );
    });

    it("discloses a canonical alias distinct from the typed path", () => {
      expect(
        renderLegacyMessage(
          payload("external_directory", { toolName: "read", value: "/tmp/x" }, [
            evidence("resolves to", "/private/tmp/x"),
            evidence("working directory", "/repo"),
          ]),
        ),
      ).toBe(
        "Current agent requested tool 'read' for path '/tmp/x' (resolves to '/private/tmp/x') outside working directory '/repo'. Allow this external directory access?",
      );
    });
  });

  describe("bash_external_directory", () => {
    it("lists every external path the command references", () => {
      expect(
        renderLegacyMessage(
          payload(
            "bash_external_directory",
            { value: "cat /etc/hosts /tmp/x" },
            [
              evidence("working directory", "/repo"),
              evidence("external path", "/etc/hosts", "/private/etc/hosts"),
              evidence("external path", "/tmp/x"),
            ],
          ),
        ),
      ).toBe(
        "Current agent requested bash command 'cat /etc/hosts /tmp/x' which references path(s) outside working directory '/repo': /etc/hosts (resolves to '/private/etc/hosts'), /tmp/x. Allow this external directory access?",
      );
    });
  });

  describe("skill_read", () => {
    it("names the skill and the path it was reached through", () => {
      expect(
        renderLegacyMessage(
          payload("skill_read", { value: "librarian" }, [
            evidence("read path", "/skills/librarian/SKILL.md"),
          ]),
        ),
      ).toBe(
        "Current agent requested access to skill 'librarian' via '/skills/librarian/SKILL.md'. Allow this read?",
      );
    });
  });

  describe("forwarded", () => {
    it("prefixes the child's ask with its provenance", () => {
      expect(
        renderLegacyMessage(
          payload(
            "forwarded",
            {
              requester: {
                agentName: "child",
                forwarded: true,
                sessionId: "sess-1",
              },
            },
            [evidence("requested", "Current agent requested tool 'read'.")],
          ),
        ),
      ).toBe(
        [
          "Subagent 'child' requested permission.",
          "Session ID: sess-1",
          "",
          "Current agent requested tool 'read'.",
        ].join("\n"),
      );
    });

    it.each([
      ["an absent requester", null],
      ["an empty requester, as a version-skewed request carries it", ""],
    ])("says 'unknown' for %s", (_case, identity) => {
      expect(
        renderLegacyMessage(
          payload(
            "forwarded",
            {
              requester: {
                agentName: identity,
                forwarded: true,
                sessionId: identity,
              },
            },
            [evidence("requested", "Allow?")],
          ),
        ),
      ).toBe(
        [
          "Subagent 'unknown' requested permission.",
          "Session ID: unknown",
          "",
          "Allow?",
        ].join("\n"),
      );
    });
  });
});
