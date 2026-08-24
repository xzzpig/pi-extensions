import { describe, expect, it } from "vitest";
import { ensureTranscriptTheme } from "../src/transcript.ts";

// Vitest isolates the module registry per test file, so the module-level
// guard flag inside transcript.ts starts unarmed here — this exercises the
// genuine "nothing initialized yet" branch of ensureTranscriptTheme.
describe("ensureTranscriptTheme (fresh registry)", () => {
  it("initializes the shared theme when nothing is active yet", () => {
    const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
    const oldKey = Symbol.for("@mariozechner/pi-coding-agent:theme");
    const globals = globalThis as unknown as Record<PropertyKey, unknown>;
    const original = globals[key];
    const originalOld = globals[oldKey];
    try {
      delete globals[key];
      delete globals[oldKey];
      expect(globals[key]).toBeUndefined();
      ensureTranscriptTheme();
      // initTheme() writes both the current and legacy sharing keys.
      expect(globals[key]).toBeDefined();
      expect(globals[oldKey]).toBeDefined();
    } finally {
      globals[key] = original;
      globals[oldKey] = originalOld;
    }
  });
});
