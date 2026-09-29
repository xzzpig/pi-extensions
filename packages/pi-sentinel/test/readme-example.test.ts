import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  validateDefaults,
  validateFleetKeybindings,
  validateRule,
} from "../extensions/config.ts";

const packageRoot = join(import.meta.dirname, "..");

function readJsonBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const fence = /```json\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    blocks.push(JSON.parse(match[1]));
  }
  return blocks;
}

function validateConfigObject(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null)
    return ["config must be an object"];
  const config = raw as Record<string, unknown>;

  if (config.defaults !== undefined) {
    errors.push(...validateDefaults(config.defaults, "readme").warnings);
  }
  if (config.fleetKeybindings !== undefined) {
    errors.push(
      ...validateFleetKeybindings(config.fleetKeybindings, "readme").warnings,
    );
  }
  if (config.rules !== undefined) {
    if (!Array.isArray(config.rules)) {
      errors.push("rules must be an array");
    } else {
      config.rules.forEach((rule, index) => {
        const result = validateRule(rule);
        if (!result.ok) errors.push(`rule #${index}: ${result.error}`);
      });
    }
  }
  return errors;
}

describe("documented configuration examples", () => {
  test("the fixed fixture passes the config validator", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(packageRoot, "test", "fixtures", "sentinel.example.json"),
        "utf8",
      ),
    );
    expect(validateConfigObject(fixture)).toEqual([]);
  });

  test("every JSON example in the README passes the config validator", () => {
    const markdown = readFileSync(join(packageRoot, "README.md"), "utf8");
    const blocks = readJsonBlocks(markdown);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const errors = validateConfigObject(block);
      if (typeof block === "object" && block !== null && "name" in block) {
        const result = validateRule(block);
        expect(result.ok, JSON.stringify(errors)).toBe(true);
      } else {
        expect(errors, JSON.stringify(block)).toEqual([]);
      }
    }
  });
});
