/**
 * Fork-only pure-model coverage for the /goal-tweak presentation: bounded,
 * deterministic body line diff, task identity/hierarchy/order comparison,
 * effective-setting old→new values, and the candidate full text. No terminal
 * renderer is involved, so these tests assert content only — never colors,
 * wrapping, or viewport height.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { GoalRecord, GoalTask } from "../extensions/goal-record.ts";
import { buildTweakPresentation, diffBodyLines } from "../extensions/goal-tweak-diff.ts";
import { projectTweakCandidate } from "../extensions/goal-tweak-projection.ts";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "goal-1",
		objective: "Original objective",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		revision: 1,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-02T00:00:00.000Z",
		...overrides,
	};
}

function withTasks(goal: GoalRecord, tasks: GoalTask[], blockCompletion = false): GoalRecord {
	return {
		...goal,
		taskList: { tasks, blockCompletion, proposedAt: "2026-11-02T00:00:00.000Z" },
	};
}

function task(id: string, title: string, overrides: Partial<GoalTask> = {}): GoalTask {
	return { id, title, status: "pending", ...overrides };
}

const PROJECTION_CONTEXT = {
	disableContracts: false,
	sessionId: "session-1",
	maxAutonomousRuns: 5,
	now: "2026-11-04T00:00:00.000Z",
	schedulerGeneration: "generation-new",
};

/** Rebuild both bodies from a no-omission hunk so content loss is detectable. */
function reconstructOutput(diffLines: readonly string[], old: readonly string[], next: readonly string[]): void {
	const rebuiltOld: string[] = [];
	const rebuiltNew: string[] = [];
	for (const line of diffLines) {
		if (line.startsWith("  ...")) continue;
		if (line.startsWith("- ")) rebuiltOld.push(line.slice(2));
		else if (line.startsWith("+ ")) rebuiltNew.push(line.slice(2));
		else {
			assert.ok(line.startsWith("  "), `unexpected diff line: ${line}`);
			rebuiltOld.push(line.slice(2));
			rebuiltNew.push(line.slice(2));
		}
	}
	assert.deepEqual(rebuiltOld, [...old]);
	assert.deepEqual(rebuiltNew, [...next]);
}

// ── Body diff hunk shape ────────────────────────────────────────────────────

test("a local body change shows three context lines and omits the unchanged remainder", () => {
	const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
	const newLines = [...oldLines];
	newLines[9] = "line 10 changed";
	const before = makeGoal({ objective: oldLines.join("\n") });
	const after = { ...before, objective: newLines.join("\n"), updatedAt: "later" };

	const presentation = buildTweakPresentation(before, after);
	const lines = presentation.diffText.split("\n");

	assert.equal(presentation.hasChanges, true);
	assert.deepEqual(presentation.changedSections, ["Objective"]);
	assert.equal(lines[0], "Objective:");
	assert.ok(lines.includes("- line 10"));
	assert.ok(lines.includes("+ line 10 changed"));
	assert.ok(lines.includes("  line 7"), "three unchanged lines before the change");
	assert.ok(lines.includes("  line 8"));
	assert.ok(lines.includes("  line 9"));
	assert.ok(lines.includes("  line 11"), "three unchanged lines after the change");
	assert.ok(lines.includes("  line 12"));
	assert.ok(lines.includes("  line 13"));
	assert.ok(!presentation.diffText.includes("line 6"), "leading unchanged content is omitted");
	assert.ok(!presentation.diffText.includes("line 14"), "trailing unchanged content is omitted");
	assert.match(presentation.diffText, /^ {2}\.\.\. 6 unchanged lines omitted \.\.\.$/m);
	assert.match(presentation.diffText, /^ {2}\.\.\. 7 unchanged lines omitted \.\.\.$/m);
});

test("nearby change fragments merge into one hunk under the context rule", () => {
	const oldLines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
	const newLines = [...oldLines];
	newLines[7] = "line 8 changed";
	newLines[11] = "line 12 changed";
	const result = diffBodyLines(oldLines.join("\n"), newLines.join("\n"));
	assert.equal(result.coarse, false);
	assert.equal(result.lines.filter((line) => line.includes("unchanged line")).length, 2, "one leading and one trailing omission");
	assert.ok(result.lines.includes("- line 8"));
	assert.ok(result.lines.includes("- line 12"));
	assert.ok(result.lines.includes("  line 9"), "the internal gap is kept because the hunks merge");
});

test("pure insertion and pure deletion are represented without phantom replacements", () => {
	const inserted = diffBodyLines("alpha\nbeta", "alpha\nnew\nbeta");
	assert.deepEqual(inserted.lines, ["  alpha", "+ new", "  beta"]);
	assert.equal(inserted.hasChanges, true);

	const deleted = diffBodyLines("alpha\nold\nbeta", "alpha\nbeta");
	assert.deepEqual(deleted.lines, ["  alpha", "- old", "  beta"]);
	assert.equal(deleted.hasChanges, true);
});

test("Chinese, blank, and repeated lines keep their exact content and deterministic ordering", () => {
	const oldLines = ["标题", "", "重复", "重复", "保留", "重复"];
	const newLines = ["标题", "", "重复", "新增", "保留", "重复", "重复"];
	const first = diffBodyLines(oldLines.join("\n"), newLines.join("\n"));
	const second = diffBodyLines(oldLines.join("\n"), newLines.join("\n"));

	assert.deepEqual(first, second, "identical input yields an identical diff");
	assert.equal(first.hasChanges, true);
	assert.equal(first.coarse, false);
	reconstructOutput(first.lines, oldLines, newLines);
});

test("a long single line stays one logical line with no wrapping or truncation", () => {
	const oldLine = "旧".repeat(2500);
	const newLine = "新".repeat(2500);
	const result = diffBodyLines(oldLine, newLine);
	assert.deepEqual(result.lines, ["- " + oldLine, "+ " + newLine]);
	const presentation = buildTweakPresentation(makeGoal({ objective: oldLine }), {
		...makeGoal({ objective: oldLine }),
		objective: newLine,
	});
	assert.equal(presentation.diffText.split("\n").length, 3);
	assert.equal(presentation.diffText.split("\n")[1], "- " + oldLine);
	assert.equal(presentation.diffText.split("\n")[2], "+ " + newLine);
});

test("identical bodies are not a change and do not fabricate diff lines", () => {
	const body = "第一行\n\nlong ".repeat(50);
	assert.deepEqual(diffBodyLines(body, body), { lines: [], hasChanges: false, coarse: false });
});

// ── Bounded fallback ────────────────────────────────────────────────────────

test("the cell budget falls back to an accurate remove-all/add-all without dropping lines", () => {
	const oldLines = Array.from({ length: 40 }, (_, index) => `old-${index}`);
	const newLines = Array.from({ length: 40 }, (_, index) => `new-${index}`);
	const result = diffBodyLines(oldLines.join("\n"), newLines.join("\n"), { maxDiffCells: 25 });
	assert.equal(result.coarse, true);
	assert.equal(result.hasChanges, true);
	assert.deepEqual(
		result.lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
		oldLines,
		"every old line is still present",
	);
	assert.deepEqual(
		result.lines.filter((line) => line.startsWith("+ ")).map((line) => line.slice(2)),
		newLines,
		"every new line is still present",
	);
	assert.match(result.lines[0]!, /large change/);
});

test("default large-body comparison falls back but still exposes every changed line", () => {
	const oldLines = Array.from({ length: 700 }, (_, index) => `before-${index}`);
	const newLines = Array.from({ length: 700 }, (_, index) => `after-${index}`);
	const result = diffBodyLines(oldLines.join("\n"), newLines.join("\n"));
	assert.equal(result.coarse, true, "700×700 exceeds the bounded LCS table");
	assert.equal(result.lines.filter((line) => line.startsWith("- ")).length, 700);
	assert.equal(result.lines.filter((line) => line.startsWith("+ ")).length, 700);
});

test("prefix and suffix trimming keeps a small change in a large body bounded without a coarse dump", () => {
	const oldLines = Array.from({ length: 900 }, (_, index) => `line ${index + 1}`);
	const newLines = [...oldLines];
	newLines[450] = "line 451 changed";
	const result = diffBodyLines(oldLines.join("\n"), newLines.join("\n"));
	assert.equal(result.coarse, false);
	assert.ok(result.lines.includes("- line 451"));
	assert.ok(result.lines.includes("+ line 451 changed"));
	assert.match(result.lines[0]!, /unchanged lines omitted/);
});

// ── Task identity, hierarchy, order, and progress ──────────────────────────

test("the task id is the identity: a rename of the same id is a modification, a new id is add/remove", () => {
	const before = withTasks(makeGoal(), [task("same-id", "Same title")]);
	const renamed = withTasks(before, [task("same-id", "New title")]);
	const renamedDiff = buildTweakPresentation(before, renamed).diffText;
	assert.match(renamedDiff, /^ {2}~ same-id: title: "Same title" -> "New title"$/m);
	assert.doesNotMatch(renamedDiff, /^ {2}[-+] same-id:/m);

	const reidentified = withTasks(before, [task("new-id", "Same title")]);
	const reidentifiedDiff = buildTweakPresentation(before, reidentified).diffText;
	assert.match(reidentifiedDiff, /^ {2}- same-id: "Same title" \(parent: \(none\), order: 1\)$/m);
	assert.match(reidentifiedDiff, /^ {2}\+ new-id: "Same title" \(parent: \(none\), order: 1\)$/m);
	assert.doesNotMatch(reidentifiedDiff, /same-id: title:/);
});

test("moving a parent shows the parent change but does not rebuild its unchanged children", () => {
	const childOne = task("child-1", "Child one");
	const childTwo = task("child-2", "Child two");
	const parent = task("parent", "Parent", { subtasks: [childOne, childTwo] });
	const sibling = task("sibling", "Sibling");
	const before = withTasks(makeGoal(), [parent, sibling]);

	const movedParent = task("parent", "Parent", { subtasks: [childOne, childTwo] });
	const movedSibling = task("sibling", "Sibling", { subtasks: [movedParent] });
	const after = withTasks(before, [movedSibling]);
	const presentation = buildTweakPresentation(before, after);

	assert.match(presentation.diffText, /^ {2}~ parent: parent: \(none\) -> sibling$/m);
	assert.match(presentation.diffText, /^ {2}~ sibling: order: 2 -> 1$/m);
	assert.doesNotMatch(presentation.diffText, /~ child-1:/);
	assert.doesNotMatch(presentation.diffText, /~ child-2:/);
	assert.doesNotMatch(presentation.diffText, /[-+] child-[12]:/, "children were not deleted or added");
});

test("sibling reordering reports order changes only for the moved siblings", () => {
	const before = withTasks(makeGoal(), [task("a", "A"), task("b", "B"), task("c", "C")]);
	const after = withTasks(before, [task("b", "B"), task("a", "A"), task("c", "C")]);
	const presentation = buildTweakPresentation(before, after);
	assert.deepEqual(presentation.changedSections, ["Tasks"]);
	assert.match(presentation.diffText, /^ {2}~ a: order: 1 -> 2$/m);
	assert.match(presentation.diffText, /^ {2}~ b: order: 2 -> 1$/m);
	assert.doesNotMatch(presentation.diffText, /~ c:/);
});

test("retained task progress and evidence stay out of the diff but remain in the full text", () => {
	const before = withTasks(
		makeGoal({ currentTaskId: "b" }),
		[
			task("a", "Task A", { status: "complete", evidence: "tests pass", completedAt: "2026-11-03T00:00:00.000Z" }),
			task("b", "Task B"),
		],
		true,
	);
	const after = withTasks(
		{ ...before, currentTaskId: "b" },
		[
			task("a", "Task A retitled", { status: "complete", evidence: "tests pass", completedAt: "2026-11-03T00:00:00.000Z" }),
			task("b", "Task B"),
		],
		true,
	);
	const presentation = buildTweakPresentation(before, after);
	assert.match(presentation.diffText, /^ {2}~ a: title: "Task A" -> "Task A retitled"$/m);
	assert.doesNotMatch(presentation.diffText, /~ a: status:/);
	assert.doesNotMatch(presentation.diffText, /~ a: evidence:/);
	assert.doesNotMatch(presentation.diffText, /status: complete -> pending/);
	assert.match(presentation.fullText, /^ {2}\[complete\] a: Task A retitled$/m);
	assert.match(presentation.fullText, /^ {4}evidence: tests pass$/m);
});

test("a removed current task and a removed task are both reported", () => {
	const before = withTasks(makeGoal({ currentTaskId: "b" }), [task("a", "A"), task("b", "B")]);
	const after = withTasks({ ...before, currentTaskId: undefined }, [task("a", "A")]);
	const presentation = buildTweakPresentation(before, after);
	assert.match(presentation.diffText, /^ {2}- b: "B" \(parent: \(none\), order: 2\)$/m);
	assert.match(presentation.diffText, /^ {2}~ Current task: b -> \(none\)$/m);
});

test("task contracts, lightweight flags, and blockCompletion compare as effective values", () => {
	const before = withTasks(makeGoal(), [task("a", "A")], false);
	const after = withTasks(
		before,
		[task("a", "A", { verificationContract: "tests pass", lightweightSubtasks: true })],
		true,
	);
	const presentation = buildTweakPresentation(before, after);
	assert.match(presentation.diffText, /^ {2}~ a: verification contract: \(none\) -> "tests pass"$/m);
	assert.match(presentation.diffText, /^ {2}~ a: lightweight subtasks: no -> yes$/m);
	assert.match(
		presentation.diffText,
		/^Task completion: does not block goal completion -> blocks goal completion until all tasks are complete$/m,
	);
});

test("an explicit empty task list removes every task in one display", () => {
	const before = withTasks(makeGoal({ currentTaskId: "a" }), [task("a", "A")], true);
	const after: GoalRecord = {
		...before,
		currentTaskId: undefined,
		taskList: { tasks: [], blockCompletion: false, proposedAt: "2026-11-04T00:00:00.000Z" },
	};
	const presentation = buildTweakPresentation(before, after);
	assert.match(presentation.diffText, /^ {2}- a: "A" \(parent: \(none\), order: 1\)$/m);
	assert.match(presentation.diffText, /^ {2}~ Current task: a -> \(none\)$/m);
	assert.match(presentation.fullText, /^Tasks:\n {2}none$/m);
});

// ── Settings ───────────────────────────────────────────────────────────────

test("a budget-only tweak shows only the budget old→new line and no unrelated content", () => {
	const before = makeGoal({ tokenBudget: 100 });
	const after = { ...before, tokenBudget: undefined };
	const presentation = buildTweakPresentation(before, after);
	assert.deepEqual(presentation.changedSections, ["Settings"]);
	assert.equal(
		presentation.diffText,
		"Settings:\n  ~ Token budget (lifetime spending cap): 100 tokens -> none",
	);
	assert.doesNotMatch(presentation.diffText, /Objective:|Tasks:|Status:|Independent auditor:|Automatic continuation:/);
});

test("adding a budget and toggling the auditor in both directions shows exact old and new values", () => {
	const withoutBudget = makeGoal();
	const withBudget = { ...withoutBudget, tokenBudget: 250 };
	assert.match(
		buildTweakPresentation(withoutBudget, withBudget).diffText,
		/^ {2}~ Token budget \(lifetime spending cap\): none -> 250 tokens$/m,
	);

	const auditorOn = makeGoal({ skipAuditor: undefined });
	const auditorOff = { ...auditorOn, skipAuditor: true };
	assert.match(
		buildTweakPresentation(auditorOn, auditorOff).diffText,
		/^ {2}~ Independent auditor: enabled -> disabled$/m,
	);
	assert.match(
		buildTweakPresentation(auditorOff, auditorOn).diffText,
		/^ {2}~ Independent auditor: disabled -> enabled$/m,
	);
});

test("lifecycle status, current task, and autoContinue changes are shown together on resume", () => {
	const before = makeGoal({
		status: "paused",
		autoContinue: false,
		currentTaskId: "a",
	});
	const after = {
		...before,
		status: "active" as const,
		autoContinue: true,
		currentTaskId: undefined,
	};
	const presentation = buildTweakPresentation(before, after);
	assert.deepEqual(presentation.changedSections, ["Settings"]);
	assert.match(presentation.diffText, /^ {2}~ Status: paused -> active$/m);
	assert.match(presentation.diffText, /^ {2}~ Current task: a -> \(none\)$/m);
	assert.match(presentation.diffText, /^ {2}~ Automatic continuation: disabled -> enabled$/m);
	assert.doesNotMatch(presentation.diffText, /Token budget|Independent auditor/);
});

// ── Full text and no-change behavior ───────────────────────────────────────

test("the full text is the effective candidate content and excludes bookkeeping telemetry", () => {
	const candidate = withTasks(
		makeGoal({
			objective: "Ship the model lane\n  second line",
			verificationContract: "Unit tests pass",
			tokenBudget: 500,
			skipAuditor: false,
			status: "active",
			currentTaskId: "b",
			autoContinue: true,
			usage: { tokensUsed: 999, activeSeconds: 1234 },
			revision: 42,
			updatedAt: "2026-11-04T00:00:00.000Z",
		}),
		[
			task("a", "Draft diff", {
				status: "complete",
				evidence: "node --test passes",
				verificationContract: "tests",
				lightweightSubtasks: true,
				completedAt: "2026-11-03T00:00:00.000Z",
				subtasks: [task("a1", "Context hunk", { status: "skipped", skipReason: "covered" })],
			}),
			task("b", "Wire seam"),
		],
		true,
	);
	const presentation = buildTweakPresentation(makeGoal(), candidate);
	assert.equal(
		presentation.fullText,
		[
			"Objective:",
			"  Ship the model lane",
			"    second line",
			"",
			"Verification contract: Unit tests pass",
			"",
			"Tasks:",
			"  [complete] a: Draft diff (lightweight subtasks)",
			"    verification contract: tests",
			"    evidence: node --test passes",
			"    [skipped] a1: Context hunk",
			"      skip reason: covered",
			"  [pending] b: Wire seam",
			"",
			"Task completion: blocks goal completion until all tasks are complete",
			"",
			"Settings:",
			"  Token budget (lifetime spending cap): 500 tokens",
			"  Independent auditor: enabled",
			"  Status: active",
			"  Current task: b",
			"  Automatic continuation: enabled",
		].join("\n"),
	);
	assert.doesNotMatch(presentation.fullText, /tokensUsed|activeSeconds|revision|updatedAt|completedAt/);
});

test("bookkeeping-only differences are an explicit no-change presentation with the candidate full text", () => {
	const before = withTasks(makeGoal({ currentTaskId: "a" }), [
		task("a", "A", { status: "complete", evidence: "kept", completedAt: "2026-11-02T00:00:00.000Z" }),
	]);
	const after = withTasks(
		{
			...before,
			usage: { tokensUsed: 500, activeSeconds: 60 },
			revision: 9,
			updatedAt: "2026-11-05T00:00:00.000Z",
			scheduler: {
				version: 1,
				owner: "session",
				generation: "new-generation",
				used: 4,
				phase: "idle",
				repairUsed: false,
			},
		},
		[
			task("a", "A", {
				status: "complete",
				evidence: "kept",
				completedAt: "2026-11-04T00:00:00.000Z",
				skippedAt: "2026-11-04T00:00:00.000Z",
			}),
		],
	);
	const presentation = buildTweakPresentation(before, after);
	assert.equal(presentation.hasChanges, false);
	assert.deepEqual(presentation.changedSections, []);
	assert.equal(presentation.diffText, "No actual changes: the candidate matches the current goal.");
	assert.equal(presentation.summary, presentation.diffText);
	assert.match(presentation.fullText, /\[complete\] a: A/);
	assert.match(presentation.fullText, /evidence: kept/);
});

test("control sequences in goals are neutralized in both the diff and the full text", () => {
	const before = makeGoal({ objective: "\u001b[31mred\u001b[0m\nbell\u0007" });
	const after = { ...before, objective: "\u001b[32mgreen\u001b[0m\ntext\u0007" };
	const presentation = buildTweakPresentation(before, after);
	assert.ok(!presentation.diffText.includes("\u001b"), "the diff contains no raw escape byte");
	assert.ok(!presentation.fullText.includes("\u001b"), "the full text contains no raw escape byte");
	assert.ok(!presentation.diffText.includes("\u0007"), "the diff contains no raw bell byte");
	assert.match(presentation.diffText, /\\x1b\[32mgreen\\x1b\[0m/);
	assert.match(presentation.fullText, /\\x1b\[32mgreen\\x1b\[0m/);
});

test("wide characters are compared as their logical lines without width-driven changes", () => {
	const wide = "目标".repeat(200);
	const identical = buildTweakPresentation(makeGoal({ objective: wide }), makeGoal({ objective: wide }));
	assert.equal(identical.hasChanges, false);
	const result = diffBodyLines(wide, wide + "新增");
	assert.equal(result.lines.length, 2, "one changed logical line becomes one remove and one add");
	assert.equal(result.lines[0], "- " + wide);
	assert.equal(result.lines[1], "+ " + wide + "新增");
});

// ── Projection equivalence (the candidate feeds both views unchanged) ──────

test("a projected resume candidate presents the same fields the submit path would persist", () => {
	const before = withTasks(
		makeGoal({
			status: "paused",
			autoContinue: false,
			pauseReason: "waiting",
			tokenBudget: 100,
			usage: { tokensUsed: 20, activeSeconds: 10 },
			currentTaskId: "a",
			scheduler: { version: 1, owner: "session-1", generation: "old", used: 1, phase: "idle", repairUsed: false },
		}),
		[task("a", "A")],
	);
	const projection = projectTweakCandidate(
		before,
		{ objective: "Revised objective", tokenBudget: null, auditorEnabled: true },
		PROJECTION_CONTEXT,
	);
	assert.equal(projection.resumed, true);
	const presentation = buildTweakPresentation(before, projection.candidate);
	assert.deepEqual(presentation.changedSections, ["Objective", "Settings"]);
	assert.match(presentation.diffText, /^- Original objective$/m);
	assert.match(presentation.diffText, /^\+ Revised objective$/m);
	assert.match(presentation.diffText, /^ {2}~ Token budget \(lifetime spending cap\): 100 tokens -> none$/m);
	assert.match(presentation.diffText, /^ {2}~ Status: paused -> active$/m);
	assert.match(presentation.diffText, /^ {2}~ Automatic continuation: disabled -> enabled$/m);
	assert.doesNotMatch(presentation.diffText, /Tasks:/, "omitted tasks are not a task change");
	assert.match(presentation.fullText, /\[pending\] a: A/);
});

test("tasks are never derived from the tweak objective text", () => {
	const before = makeGoal();
	const projection = projectTweakCandidate(
		before,
		{ objective: "1. first step\n2. second step", auditorEnabled: true },
		PROJECTION_CONTEXT,
	);
	const presentation = buildTweakPresentation(before, projection.candidate);
	assert.deepEqual(presentation.changedSections, ["Objective"]);
	assert.doesNotMatch(presentation.diffText, /Tasks:/);
	assert.match(presentation.fullText, /^Tasks:\n {2}none$/m);
});

test("new and removed tasks expose their verification contract and lightweight rule in the diff", () => {
	const before = withTasks(makeGoal(), [task("old", "removed", { verificationContract: "old proof", lightweightSubtasks: true })]);
	const after = withTasks(makeGoal(), [task("new", "added", { verificationContract: "new proof", lightweightSubtasks: true })]);
	const text = buildTweakPresentation(before, after).diffText;
	assert.match(text, /- old verification contract: "old proof"/);
	assert.match(text, /\+ new verification contract: "new proof"/);
	assert.match(text, /\+ new lightweight subtasks: yes/);
});

test("very tall insertion and one-to-many LCS do not exceed JavaScript argument limits", () => {
	const objective = Array.from({ length: 130_000 }, (_, index) => `row-${index}`).join("\n");
	for (const old of ["", "old"]) {
		const presentation = buildTweakPresentation(makeGoal({ objective: old }), makeGoal({ objective }));
		assert.match(presentation.diffText, /\+ row-0/);
		assert.match(presentation.diffText, /\+ row-129999/);
	}
});
