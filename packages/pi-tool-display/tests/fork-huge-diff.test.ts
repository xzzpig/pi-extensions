import assert from "node:assert/strict";
import test from "node:test";
import { renderEditDiffResult } from "../src/diff-renderer.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

test("collapsed split renderer handles 130,000 actual edit rows without argument overflow", () => {
  const diff =
    "@@ -0,0 +1,130000 @@\n" +
    Array.from({ length: 130_000 }, (_, i) => `+line ${i}`).join("\n");
  const result = renderEditDiffResult(
    { diff },
    { expanded: false, filePath: "fixture.txt" },
    { ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "split" },
    theme,
    "",
  ).render(120);
  assert.ok(result.length <= 30, `collapsed output had ${result.length} rows`);
  assert.match(result.join("\n"), /more|hidden|remaining|lines|collapsed/i);
});
