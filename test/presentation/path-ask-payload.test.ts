import { describe, expect, test } from "vitest";
import { renderLegacyMessage } from "#src/presentation/legacy-message";
import {
  buildBashExternalDirectoryAskPayload,
  buildExternalDirectoryAskPayload,
  buildPathAskPayload,
} from "#src/presentation/path-ask-payload";

describe("buildPathAskPayload", () => {
  test("carries the typed path as the decision value and the rule that fired", () => {
    const payload = buildPathAskPayload({
      toolName: "read",
      pathValue: "/etc/passwd",
      agentName: "my-agent",
      matchedPattern: "/etc/*",
    });

    expect(payload.kind).toBe("path");
    expect(payload.request).toEqual({
      requester: { agentName: "my-agent", forwarded: false, sessionId: null },
      surface: "path",
      toolName: "read",
      invokedToolName: null,
      value: "/etc/passwd",
      matchedPattern: "/etc/*",
      commandContext: null,
      executedUnit: null,
    });
    expect(payload.evidence).toEqual([]);
  });

  test("renders the path ask", () => {
    expect(
      renderLegacyMessage(
        buildPathAskPayload({
          toolName: "read",
          pathValue: "/etc/passwd",
          agentName: null,
        }),
      ),
    ).toBe(
      "Current agent requested tool 'read' for path '/etc/passwd'. Allow this path access?",
    );
  });
});

describe("buildExternalDirectoryAskPayload", () => {
  test("uses 'Current agent' when no agent name provided", () => {
    const result = renderLegacyMessage(
      buildExternalDirectoryAskPayload({
        toolName: "read",
        pathValue: "/etc/passwd",
        cwd: "/projects/my-app",
        agentName: null,
      }),
    );
    expect(result).toContain("Current agent");
    expect(result).toContain("read");
    expect(result).toContain("/etc/passwd");
    expect(result).toContain("/projects/my-app");
  });

  test("uses agent name when provided", () => {
    const result = renderLegacyMessage(
      buildExternalDirectoryAskPayload({
        toolName: "write",
        pathValue: "/tmp/out.txt",
        cwd: "/projects/my-app",
        agentName: "my-agent",
      }),
    );
    expect(result).toContain("Agent 'my-agent'");
    expect(result).toContain("write");
    expect(result).toContain("/tmp/out.txt");
  });

  test("discloses the resolved path when it differs from the typed path", () => {
    const result = renderLegacyMessage(
      buildExternalDirectoryAskPayload({
        toolName: "read",
        pathValue: "demo-symlink-passwd",
        resolvedPath: "/etc/passwd",
        cwd: "/projects/my-app",
        agentName: null,
      }),
    );
    expect(result).toBe(
      "Current agent requested tool 'read' for path 'demo-symlink-passwd' (resolves to '/etc/passwd') outside working directory '/projects/my-app'. Allow this external directory access?",
    );
  });

  test("omits the disclosure when resolvedPath is undefined", () => {
    const payload = buildExternalDirectoryAskPayload({
      toolName: "read",
      pathValue: "/etc/passwd",
      cwd: "/projects/my-app",
      agentName: null,
    });

    expect(payload.evidence).toEqual([
      { label: "working directory", text: "/projects/my-app", detail: null },
    ]);
    expect(renderLegacyMessage(payload)).not.toContain("resolves to");
  });
});

describe("buildBashExternalDirectoryAskPayload", () => {
  test("includes command, paths, cwd, and agent name", () => {
    const result = renderLegacyMessage(
      buildBashExternalDirectoryAskPayload({
        command: "cat /etc/passwd",
        externalPaths: [{ path: "/etc/passwd" }],
        cwd: "/projects/my-app",
        agentName: "my-agent",
        toolName: "bash",
      }),
    );
    expect(result).toContain("Agent 'my-agent'");
    expect(result).toContain("cat /etc/passwd");
    expect(result).toContain("/etc/passwd");
    expect(result).toContain("/projects/my-app");
  });

  test("uses 'Current agent' when no agent name provided", () => {
    expect(
      renderLegacyMessage(
        buildBashExternalDirectoryAskPayload({
          command: "ls /tmp",
          externalPaths: [{ path: "/tmp" }],
          cwd: "/projects/my-app",
          agentName: null,
          toolName: "bash",
        }),
      ),
    ).toContain("Current agent");
  });

  test("binds each path's canonical alias to its own entry", () => {
    const payload = buildBashExternalDirectoryAskPayload({
      command: "cat a b",
      externalPaths: [
        { path: "/a", resolvedPath: "/private/a" },
        { path: "/b" },
      ],
      cwd: "/repo",
      agentName: null,
      toolName: "bash",
    });

    expect(payload.evidence).toEqual([
      { label: "working directory", text: "/repo", detail: null },
      { label: "external path", text: "/a", detail: "/private/a" },
      { label: "external path", text: "/b", detail: null },
    ]);
    expect(renderLegacyMessage(payload)).toBe(
      "Current agent requested bash command 'cat a b' which references path(s) outside working directory '/repo': /a (resolves to '/private/a'), /b. Allow this external directory access?",
    );
  });
});
