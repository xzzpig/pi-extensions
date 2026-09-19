import { describe, expect, it } from "vitest";
import { unifiedConfigSchema } from "#src/config/config-schema";

// Fork-only tests: profiles registry schema support (upstream
// `config-schema.test.ts` covers the unextended schema).

describe("profiles registry schema", () => {
  it("accepts a global config with a valid profiles registry", () => {
    const result = unifiedConfigSchema.safeParse({
      permission: { "*": "ask" },
      profiles: {
        reviewer: {
          permission: { "*": "ask", read: "allow", write: "deny" },
        },
        "yolo-dev": {
          permission: { "*": "allow", bash: { "git push *": "ask" } },
        },
      },
    });
    expect(result.success ? [] : result.error.issues).toEqual([]);
    if (!result.success) return;
    expect(result.data.profiles?.reviewer?.permission).toEqual({
      "*": "ask",
      read: "allow",
      write: "deny",
    });
  });

  it("accepts a profile with a universal fallback and empty permission", () => {
    const result = unifiedConfigSchema.safeParse({
      profiles: {
        empty: {},
        fallbackOnly: { permission: { "*": "deny" } },
      },
    });
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("rejects profile names that are not safe identifiers", () => {
    for (const badName of ["../escape", "a/b", "has space", "-lead"]) {
      const result = unifiedConfigSchema.safeParse({
        profiles: { [badName]: { permission: { "*": "ask" } } },
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects profile entries with unknown keys (rules only)", () => {
    const result = unifiedConfigSchema.safeParse({
      profiles: {
        reviewer: { permission: { "*": "ask" }, yoloMode: true },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects profile rulesets with invalid action values", () => {
    const result = unifiedConfigSchema.safeParse({
      profiles: { reviewer: { permission: { read: "maybe" } } },
    });
    expect(result.success).toBe(false);
  });
});
