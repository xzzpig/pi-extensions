import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  renderEditDiffResult,
  renderWriteDiffResult,
} from "../src/diff-renderer.ts";
import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  type DiffViewMode,
} from "../src/types.ts";

/** Captured from upstream commit 91cef7580078371f8dc49a8607222807ad6a424d before shared extraction. */
const baseline = JSON.parse(
  readFileSync(
    new URL("./fixtures/fork-shared-diff-baseline.json", import.meta.url),
    "utf8",
  ),
) as {
  diff: string;
  cases: Array<{
    mode: DiffViewMode;
    width: number;
    wrap: boolean;
    edit: string[];
    write: string[];
  }>;
};
const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

test("shared diff migration preserves upstream edit/write rendered rows", () => {
  for (const item of baseline.cases) {
    const config = {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      diffViewMode: item.mode,
      diffWordWrap: item.wrap,
    };
    const options = { expanded: true, filePath: "a.txt" };
    const context = `${item.mode} width=${item.width} wrap=${item.wrap}`;
    assert.deepEqual(
      renderEditDiffResult(
        { diff: baseline.diff },
        options,
        config,
        theme,
        "",
      ).render(item.width),
      item.edit,
      `edit: ${context}`,
    );
    const writeOptions = {
      ...options,
      previousContent: "a\n旧\n" + "长".repeat(35),
      fileExistedBeforeWrite: true,
    };
    assert.deepEqual(
      renderWriteDiffResult(
        "a\n新\n" + "长".repeat(30),
        writeOptions,
        config,
        theme,
        "",
      ).render(item.width),
      item.write,
      `write: ${context}`,
    );
  }
});
