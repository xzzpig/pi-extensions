import { compile, type Static } from "@earendil-works/pi-schema";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createAuditVerdictTool } from "../extensions/audit-loop.ts";

const tool = createAuditVerdictTool(() => {});
const schema = compile(tool.parameters);

// Compile-time regression: AgentTool receives pi-schema's inferred arguments.
const valid: Static<typeof tool.parameters> = {
  verdict: "pass",
  message: "OK",
};
const invalid: Static<typeof tool.parameters> = {
  // @ts-expect-error Verdict must remain a literal union, not unknown/string.
  verdict: "unknown",
  message: "OK",
};
void invalid;

describe("Pi 1.5 native verdict schema", () => {
  test("preserves required fields and verdict values", () => {
    expect(schema.check(valid)).toBe(true);
    expect(schema.check({ verdict: "pass" })).toBe(false);
    expect(schema.check({ verdict: "unknown", message: "OK" })).toBe(false);
  });

  test("preserves the former open-object contract", () => {
    expect(schema.check({ ...valid, extra: true })).toBe(true);
  });

  test("runs through the host validator without TypeBox metadata", () => {
    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "schema-test",
        name: tool.name,
        arguments: valid,
      }),
    ).toEqual(valid);
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(
      tool.parameters,
    );
  });
});
