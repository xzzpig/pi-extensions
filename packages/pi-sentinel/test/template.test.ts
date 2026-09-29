import { describe, expect, test } from "vitest";
import {
  collectTemplatePaths,
  renderAuditMessage,
  renderTemplate,
  SCOPE_SEPARATOR,
  truncateText,
  unresolvedPaths,
} from "../extensions/template.ts";

describe("template rendering", () => {
  test("dot paths reference event data (command content)", () => {
    const rendered = renderTemplate("检查命令：{{input.command}}", {
      input: { command: "rm -rf /tmp/build" },
    });
    expect(rendered).toBe("检查命令：rm -rf /tmp/build");
  });

  test("{{json input}} serializes the whole input object", () => {
    const rendered = renderTemplate("{{json input}}", {
      input: { command: "ls", flags: ["-a"] },
    });
    expect(JSON.parse(rendered)).toEqual({ command: "ls", flags: ["-a"] });
  });

  test("unknown paths render empty and are reported as unresolved", () => {
    const eventData = { input: { command: "ls" } };
    expect(renderTemplate("x={{input.nonexistent}}y", eventData)).toBe("x=y");
    expect(unresolvedPaths("x={{input.nonexistent}}y", eventData)).toEqual([
      "input.nonexistent",
    ]);
    expect(unresolvedPaths("{{input.command}}", eventData)).toEqual([]);
  });

  test("data references and this-relative paths are not reported as unresolved", () => {
    const eventData = { input: { command: "ls" } };
    expect(
      unresolvedPaths(
        "{{@root}} {{@root.foo}} {{@index}} {{this.x}}",
        eventData,
      ),
    ).toEqual([]);
    expect(unresolvedPaths("{{input.command}}", eventData)).toEqual([]);
  });

  test("command text with && and < is not escaped", () => {
    const rendered = renderTemplate("{{input.command}}", {
      input: { command: "test -f a && grep '<x>' a" },
    });
    expect(rendered).toBe("test -f a && grep '<x>' a");
    expect(rendered).not.toContain("&amp;");
    expect(rendered).not.toContain("&lt;");
  });

  test("{{#if}} conditionals and {{#each}} loops work", () => {
    const rendered = renderTemplate(
      "{{#if isError}}ERROR{{else}}OK{{/if}}:{{#each messages}}[{{role}}]{{/each}}",
      { isError: true, messages: [{ role: "user" }, { role: "assistant" }] },
    );
    expect(rendered).toBe("ERROR:[user][assistant]");
  });

  test("truncate and now helpers", () => {
    expect(
      renderTemplate("{{truncate content 4}}", { content: "abcdefghij" }),
    ).toBe("abcd...[截断 6 字符]");
    expect(renderTemplate("{{truncate content 4}}", { content: "ab" })).toBe(
      "ab",
    );
    const now = renderTemplate("{{now}}", {});
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("template diagnostics and message assembly", () => {
  test("helper names are not reported as variables", () => {
    expect(
      collectTemplatePaths("{{json input}} {{truncate content 5}} {{now}}"),
    ).toEqual(["input", "content"]);
  });

  test("identifiers inside each/with are not checked against the event root", () => {
    expect(
      unresolvedPaths("{{#each messages}}{{role}}{{/each}}", { messages: [] }),
    ).toEqual([]);
    expect(
      unresolvedPaths("{{#each messages}}{{tool}}{{/each}}", { messages: [] }),
    ).toEqual([]);
  });

  test("renderAuditMessage appends the scope block and reports unresolved paths", () => {
    const message = renderAuditMessage({
      prompt: "检查 {{tool}} 与 {{input.nope}}",
      eventData: { tool: "bash" },
      scopeText: '{"tool":"bash"}',
    });

    expect(message.unresolved).toEqual(["input.nope"]);
    expect(message.text).toBe(
      `检查 bash 与 \n\n${SCOPE_SEPARATOR}\n{"tool":"bash"}`,
    );
  });

  test("truncateText marks the removed character count", () => {
    expect(truncateText("hello", 5)).toBe("hello");
    expect(truncateText("hello world", 5)).toBe("hello...[截断 6 字符]");
  });
});
