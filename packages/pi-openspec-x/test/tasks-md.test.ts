/**
 * Tests for the tasks.md parser (task 6.2). Pins openspec's exact tracking
 * rule so the goal task mirror can never disagree with `openspec apply` about
 * what is done, plus the id/section/verification extraction the objective
 * assembler consumes.
 */
import { describe, expect, it } from "vitest";

import {
  duplicateTaskIds,
  goalStatusForTask,
  parseTasksMarkdown,
  type OpsxTask,
} from "../src/tasks-md.ts";

describe("parseTasksMarkdown", () => {
  it("parses ids, titles, sections, and the openspec done rule", () => {
    const tasks = parseTasksMarkdown(
      [
        "# Tasks",
        "",
        "## 1. Setup",
        "",
        "- [ ] 1.1 Create the module and verify the files exist",
        "- [x] 1.2 Add the dependency and verify install succeeds",
        "",
        "## 2. Core",
        "",
        "- [ x] 2.1 Implement the parser and verify the unit tests pass",
        "- [X] 2.2 Wire the command and verify the smoke test passes",
      ].join("\n"),
    );

    expect(tasks.map((task) => task.id)).toEqual(["1.1", "1.2", "2.1", "2.2"]);
    expect(tasks.map((task) => task.done)).toEqual([false, true, true, true]);
    expect(tasks[0]?.section).toBe("1. Setup");
    expect(tasks[2]?.section).toBe("2. Core");
    expect(tasks[0]?.title).toBe(
      "Create the module and verify the files exist",
    );
  });

  it("treats every non-x box marker as unfinished and ignores non-checkbox lines", () => {
    const tasks = parseTasksMarkdown(
      [
        "Prose that is not tracked.",
        "- [~] 1.1 Skipped marker still tracked as unfinished",
        "- [-] 1.2 Another unfinished marker",
        "- [] 1.3 Empty box",
        "- [ ] 1.4 Ordinary unfinished",
        "- [text](https://example.com) is a link, not a task",
      ].join("\n"),
    );

    expect(tasks.map((task) => task.id)).toEqual(["1.1", "1.2", "1.3", "1.4"]);
    expect(tasks.every((task) => !task.done)).toBe(true);
  });

  it("splits an explicit verification marker into the task's contract", () => {
    const tasks = parseTasksMarkdown(
      [
        "- [ ] 1.1 创建模块；验证：`pnpm test` 全绿",
        "- [ ] 1.2 Wire the command. Verification: the smoke test passes",
      ].join("\n"),
    );

    expect(tasks[0]).toMatchObject({
      id: "1.1",
      title: "创建模块",
      verificationContract: "`pnpm test` 全绿",
    });
    expect(tasks[1]).toMatchObject({
      id: "1.2",
      title: "Wire the command.",
      verificationContract: "the smoke test passes",
    });
  });

  it("keeps the description whole when a verification marker has no contract", () => {
    const tasks = parseTasksMarkdown("- [ ] 1.1 验证：done\n");
    expect(tasks[0]?.title).toBe("验证：done");
    expect(tasks[0]?.verificationContract).toBeUndefined();
  });

  it("synthesizes a stable id for a checkbox without an id prefix", () => {
    const tasks = parseTasksMarkdown(
      "- [ ] No numeric prefix here\n- [ ] 2.2 Has one\n",
    );
    expect(tasks.map((task) => task.id)).toEqual(["task-1", "2.2"]);
  });

  it("skips empty-description checkboxes and handles CRLF", () => {
    const tasks = parseTasksMarkdown("- []\r\n- [ ] 1.1 Real task\r\n");
    expect(tasks.map((task) => task.id)).toEqual(["1.1"]);
  });

  it("returns an empty list for a tasks.md with no tracked tasks", () => {
    expect(
      parseTasksMarkdown("# Tasks\n\n## 1. Group\n\nNo checkboxes yet.\n"),
    ).toEqual([]);
  });

  it("maps done to the binary goal status and reports duplicate ids", () => {
    const tasks: OpsxTask[] = [
      { id: "1.1", title: "a", done: true },
      { id: "1.2", title: "b", done: false },
    ];
    expect(goalStatusForTask(tasks[0]!)).toBe("complete");
    expect(goalStatusForTask(tasks[1]!)).toBe("pending");

    expect(duplicateTaskIds(tasks)).toEqual([]);
    expect(
      duplicateTaskIds([...tasks, { id: "1.1", title: "dup", done: false }]),
    ).toEqual(["1.1"]);
  });
});
