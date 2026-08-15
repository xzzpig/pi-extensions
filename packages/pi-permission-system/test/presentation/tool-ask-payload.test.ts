import { describe, expect, test } from "vitest";
import { renderLegacyMessage } from "#src/presentation/legacy-message";
import {
  buildToolAskPayload,
  type ToolAskFacts,
} from "#src/presentation/tool-ask-payload";
import type { ToolInputFormatterLookup } from "#src/tool-input-formatter-registry";
import type { PermissionCheckResult } from "#src/types";
import {
  makePermissionCheckResult,
  makeToolPreviewFormatter,
} from "#test/helpers/presentation-fixtures";

function makeFormatter(lookup?: ToolInputFormatterLookup) {
  return makeToolPreviewFormatter({}, lookup);
}

function makeMcpLookup(preview: string): ToolInputFormatterLookup {
  return { get: (name) => (name === "mcp" ? () => preview : undefined) };
}

function toolResult(
  toolName: string,
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return makePermissionCheckResult(toolName, overrides);
}

function mcpResult(
  target: string,
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return makePermissionCheckResult("mcp", { target, ...overrides });
}

/** Build a payload the way the per-tool gate does, defaulting the surface. */
function buildPayload(
  facts: Omit<ToolAskFacts, "surface" | "agentName"> & {
    surface?: string;
    agentName?: string | null;
  },
) {
  return buildToolAskPayload({
    agentName: null,
    surface: facts.check.toolName,
    ...facts,
  });
}

/** The sentence today's consumers still read, rendered from the payload. */
function message(facts: Parameters<typeof buildPayload>[0]): string {
  return renderLegacyMessage(buildPayload(facts));
}

describe("buildToolAskPayload", () => {
  describe("the invariant core", () => {
    test("carries the gate surface, matched rule, and offending command", () => {
      const payload = buildPayload({
        check: toolResult("bash", {
          command: "rm -rf foo",
          matchedPattern: "rm *",
          commandContext: "command_substitution",
        }),
        surface: "bash",
      });

      expect(payload.kind).toBe("bash");
      expect(payload.request).toEqual({
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "bash",
        toolName: "bash",
        invokedToolName: null,
        value: "rm -rf foo",
        matchedPattern: "rm *",
        commandContext: "command_substitution",
        executedUnit: null,
      });
    });

    test("carries the executed unit of a wrapper (#713)", () => {
      const payload = buildPayload({
        check: toolResult("bash", {
          command: "xargs grep foo",
          matchedPattern: "<indirection-bash-wrapper>",
          executedUnit: "grep foo",
        }),
        surface: "bash",
      });

      expect(payload.request.executedUnit).toBe("grep foo");
    });

    test("names the invoked tool when a shell alias re-exposes bash (#574)", () => {
      const payload = buildPayload({
        check: toolResult("bash", { command: "ls" }),
        surface: "bash",
        invokedToolName: "exec_command",
      });

      expect(payload.request.toolName).toBe("bash");
      expect(payload.request.invokedToolName).toBe("exec_command");
    });

    test("omits the invoked tool when it repeats the gated one", () => {
      const payload = buildPayload({
        check: toolResult("read"),
        invokedToolName: "read",
      });

      expect(payload.request.invokedToolName).toBeNull();
    });

    test("leaves the value empty for a bash check with no resolved command", () => {
      expect(buildPayload({ check: toolResult("bash") }).request.value).toBe(
        "",
      );
    });

    test("lands the annotations slot empty", () => {
      expect(buildPayload({ check: toolResult("read") }).annotations).toEqual(
        [],
      );
    });
  });

  describe("bash", () => {
    test("names the agent when one is known", () => {
      expect(
        message({
          check: toolResult("read"),
          agentName: "my-agent",
          input: { path: "/src" },
          formatter: makeFormatter(),
        }),
      ).toContain("Agent 'my-agent'");
    });

    test("formats bash prompt with command and does not use formatter", () => {
      const result = message({
        check: toolResult("bash", { command: "git status" }),
        formatter: makeFormatter(),
      });
      expect(result).toContain("git status");
      expect(result).toContain("Allow this command?");
    });

    test("formats bash prompt with matched pattern", () => {
      expect(
        message({
          check: toolResult("bash", {
            command: "git push",
            matchedPattern: "git *",
          }),
          formatter: makeFormatter(),
        }),
      ).toContain("matched 'git *'");
    });

    test("appends full command when input contains a chain that differs from the sub-command", () => {
      expect(
        message({
          check: toolResult("bash", { command: "rm -rf ." }),
          input: { command: 'echo "hello" && rm -rf .' },
          formatter: makeFormatter(),
        }),
      ).toBe(
        `Current agent requested bash command 'rm -rf .' (full command: 'echo "hello" && rm -rf .'). Allow this command?`,
      );
    });

    test("suppresses full-command suffix when input command matches the sub-command (no chain)", () => {
      const result = message({
        check: toolResult("bash", { command: "git push" }),
        input: { command: "git push" },
        formatter: makeFormatter(),
      });
      expect(result).not.toContain("full command:");
      expect(result).toBe(
        "Current agent requested bash command 'git push'. Allow this command?",
      );
    });

    test.each([
      ["input is undefined", undefined],
      ["input has no command field", { unrelated: "value" }],
      ["input command is empty", { command: "" }],
    ])("suppresses full-command suffix when %s", (_case, input) => {
      expect(
        message({
          check: toolResult("bash", { command: "git push" }),
          input,
          formatter: makeFormatter(),
        }),
      ).not.toContain("full command:");
    });

    test("places full-command suffix after the qualifier and before the terminal sentence", () => {
      expect(
        message({
          check: toolResult("bash", {
            command: "rm -rf foo",
            matchedPattern: "rm *",
          }),
          input: { command: "cd /tmp && rm -rf foo" },
          formatter: makeFormatter(),
        }),
      ).toBe(
        "Current agent requested bash command 'rm -rf foo' (matched 'rm *') (full command: 'cd /tmp && rm -rf foo'). Allow this command?",
      );
    });

    test("formats bash prompt with nested execution context", () => {
      expect(
        message({
          check: toolResult("bash", {
            command: "rm -rf foo",
            matchedPattern: "rm *",
            commandContext: "command_substitution",
          }),
          formatter: makeFormatter(),
        }),
      ).toContain(
        "bash command 'rm -rf foo' (matched 'rm *', inside command substitution).",
      );
    });
  });

  describe("mcp", () => {
    test("formats MCP prompt with target", () => {
      const result = message({
        check: mcpResult("server:query"),
        formatter: makeFormatter(),
      });
      expect(result).toContain("server:query");
      expect(result).toContain("Allow this call?");
    });

    test("formats MCP prompt with matched pattern", () => {
      expect(
        message({
          check: mcpResult("server:query", { matchedPattern: "server:*" }),
          formatter: makeFormatter(),
        }),
      ).toContain("matched 'server:*'");
    });

    test("appends MCP argument summary when the formatter has an mcp formatter registered", () => {
      const result = message({
        check: mcpResult("exa:search"),
        input: { tool: "exa:search", arguments: { query: "typescript" } },
        formatter: makeFormatter(makeMcpLookup('with query: "typescript"')),
      });
      expect(result).toContain("exa:search");
      expect(result).toContain('with query: "typescript"');
      expect(result).toContain("Allow this call?");
    });

    test("MCP prompt is unchanged when the formatter returns undefined (no arguments)", () => {
      const noArgsLookup: ToolInputFormatterLookup = {
        get: (name) => (name === "mcp" ? () => undefined : undefined),
      };
      const result = message({
        check: mcpResult("exa:search"),
        input: { tool: "exa:search" },
        formatter: makeFormatter(noArgsLookup),
      });
      expect(result).toContain("exa:search");
      expect(result).not.toMatch(/with /);
      expect(result).toContain("Allow this call?");
    });

    test("MCP prompt is unchanged when no formatter is provided", () => {
      const result = message({
        check: mcpResult("exa:search"),
        input: { tool: "exa:search", arguments: { query: "test" } },
      });
      expect(result).toContain("exa:search");
      expect(result).not.toMatch(/with /);
      expect(result).toContain("Allow this call?");
    });
  });

  describe("generic tools", () => {
    test("includes real input preview for non-bash non-mcp tools", () => {
      const result = message({
        check: toolResult("read"),
        input: { path: "/src/foo.ts" },
        formatter: makeFormatter(),
      });
      expect(result).toContain("path '/src/foo.ts'");
      expect(result).toContain("Allow this call?");
    });

    test("omits input suffix when formatter returns empty string for input", () => {
      const result = message({
        check: toolResult("task"),
        input: {},
        formatter: makeFormatter(),
      });
      expect(result).toContain("task");
      expect(result).not.toContain("undefined");
    });

    test("omits input suffix when no formatter provided", () => {
      const result = message({
        check: toolResult("task"),
        input: { path: "/src" },
      });
      expect(result).toContain("task");
      expect(result).not.toContain("undefined");
      expect(result).toContain("Allow this call?");
    });
  });
});
