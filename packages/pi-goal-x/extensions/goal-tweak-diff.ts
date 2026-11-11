import type { GoalRecord, GoalTask, GoalTaskList } from "./goal-record.ts";

/**
 * Pure, deterministic presentation model for /goal-tweak.
 *
 * `buildTweakPresentation` compares the authoritative before-goal with the
 * effective candidate (the record `projectTweakCandidate` returns) and
 * produces the same diff/full text for the dialog, tool result, and stored
 * result details. It never reads current state, never formats for a specific
 * terminal width, and never uses color.
 */

export interface TweakPresentationOptions {
	/** Unchanged lines kept around each body change (default 3). */
	contextLines?: number;
	/** Maximum LCS cells before the accurate coarse fallback (default 400_000). */
	maxDiffCells?: number;
}

export interface BodyLineDiff {
	/** Prefixed diff lines: "  " context, "- " removed, "+ " added, omission hints. */
	lines: string[];
	hasChanges: boolean;
	/** True when the bounded line algorithm fell back to remove-all/add-all. */
	coarse: boolean;
}

export interface TweakPresentation {
	hasChanges: boolean;
	/** One-line collapsed summary. */
	summary: string;
	/** Changed section labels in fixed display order. */
	changedSections: string[];
	/** Color-free semantic diff text; an explicit no-change sentence when equal. */
	diffText: string;
	/** Complete candidate content: objective, contract, task tree, effective settings. */
	fullText: string;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_CELLS = 400_000;
const NO_CHANGES_TEXT = "No actual changes: the candidate matches the current goal.";

interface LineOp {
	kind: "equal" | "remove" | "add";
	text: string;
}

interface FlatTaskNode {
	task: GoalTask;
	parentId?: string;
	order: number;
	depth: number;
}

interface SettingChange {
	label: string;
	before: string;
	after: string;
}

/**
 * Diff two plain-text bodies line by line. Lines are compared verbatim
 * (trailing CRLF endings normalized away); no wrapping or width logic runs
 * here. The LCS table is capped, and a budget overrun falls back to showing
 * every middle old line as removed and every middle new line as added, so a
 * bounded result never hides a change.
 */
export function diffBodyLines(
	before: string,
	after: string,
	options: TweakPresentationOptions = {},
): BodyLineDiff {
	const contextLines = boundedInteger(options.contextLines, DEFAULT_CONTEXT_LINES, 0);
	const maxDiffCells = boundedInteger(options.maxDiffCells, DEFAULT_MAX_DIFF_CELLS, 1);
	const oldLines = splitLogicalLines(before);
	const newLines = splitLogicalLines(after);
	const { ops, coarse } = buildLineOps(oldLines, newLines, maxDiffCells);
	const hasChanges = ops.some((op) => op.kind !== "equal");
	if (!hasChanges) return { lines: [], hasChanges: false, coarse };
	return { lines: renderLineOps(ops, contextLines, coarse), hasChanges: true, coarse };
}

/**
 * Build the full tweak presentation. `before` is the authoritative goal and
 * `candidate` is the effective record the same proposal would persist;
 * timestamps, revision, usage, and scheduler bookkeeping are excluded by
 * construction (only business fields are compared).
 */
export function buildTweakPresentation(
	before: GoalRecord,
	candidate: GoalRecord,
	options: TweakPresentationOptions = {},
): TweakPresentation {
	const changedSections: string[] = [];
	const diffLines: string[] = [];
	const body = diffBodyLines(before.objective, candidate.objective, options);
	if (body.hasChanges) {
		changedSections.push("Objective");
		diffLines.push("Objective:");
		for (const line of body.lines) diffLines.push(line);
	}

	const beforeContract = normalizedContract(before.verificationContract);
	const afterContract = normalizedContract(candidate.verificationContract);
	if (beforeContract !== afterContract) {
		changedSections.push("Verification contract");
		diffLines.push(
			"Verification contract:",
			`  - ${displayContract(beforeContract)}`,
			`  + ${displayContract(afterContract)}`,
		);
	}

	const taskLines = diffTaskStructure(before.taskList, candidate.taskList);
	if (taskLines.length > 0) {
		changedSections.push("Tasks");
		diffLines.push("Tasks:", ...taskLines);
	}

	const beforeBlocks = before.taskList?.blockCompletion === true;
	const afterBlocks = candidate.taskList?.blockCompletion === true;
	if (beforeBlocks !== afterBlocks) {
		changedSections.push("Task completion");
		diffLines.push(`Task completion: ${blockLabel(beforeBlocks)} -> ${blockLabel(afterBlocks)}`);
	}

	const settingLines = diffSettings(before, candidate);
	if (settingLines.length > 0) {
		changedSections.push("Settings");
		diffLines.push("Settings:", ...settingLines);
	}

	const hasChanges = changedSections.length > 0;
	return {
		hasChanges,
		summary: hasChanges ? `Modified: ${changedSections.join(", ")}.` : NO_CHANGES_TEXT,
		changedSections,
		diffText: hasChanges ? diffLines.join("\n") : NO_CHANGES_TEXT,
		fullText: renderFullText(candidate),
	};
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

function splitLogicalLines(text: string): string[] {
	if (text === "") return [];
	return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function buildLineOps(oldLines: string[], newLines: string[], maxDiffCells: number): { ops: LineOp[]; coarse: boolean } {
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix
		&& suffix < newLines.length - prefix
		&& oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) suffix++;

	const middleOld = oldLines.slice(prefix, oldLines.length - suffix);
	const middleNew = newLines.slice(prefix, newLines.length - suffix);
	const ops: LineOp[] = [];
	for (let index = 0; index < prefix; index++) {
		ops.push({ kind: "equal", text: oldLines[index]! });
	}

	let coarse = false;
	if (middleOld.length === 0) {
		for (let index = 0; index < middleNew.length; index++) {
			ops.push({ kind: "add", text: middleNew[index]! });
		}
	} else if (middleNew.length === 0) {
		for (let index = 0; index < middleOld.length; index++) {
			ops.push({ kind: "remove", text: middleOld[index]! });
		}
	} else if ((middleOld.length + 1) * (middleNew.length + 1) > maxDiffCells) {
		coarse = true;
		for (let index = 0; index < middleOld.length; index++) {
			ops.push({ kind: "remove", text: middleOld[index]! });
		}
		for (let index = 0; index < middleNew.length; index++) {
			ops.push({ kind: "add", text: middleNew[index]! });
		}
	} else {
		for (const op of lcsOps(middleOld, middleNew)) ops.push(op);
	}

	for (let index = 0; index < suffix; index++) {
		const oldIndex = oldLines.length - suffix + index;
		ops.push({ kind: "equal", text: oldLines[oldIndex]! });
	}
	return { ops, coarse };
}

function lcsOps(oldLines: string[], newLines: string[]): LineOp[] {
	const ops: LineOp[] = [];
	const width = newLines.length + 1;
	const table = new Int32Array((oldLines.length + 1) * width);
	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
			const cell = oldIndex * width + newIndex;
			if (oldLines[oldIndex] === newLines[newIndex]) {
				table[cell] = table[(oldIndex + 1) * width + newIndex + 1]! + 1;
			} else {
				const skipOld = table[(oldIndex + 1) * width + newIndex]!;
				const skipNew = table[oldIndex * width + newIndex + 1]!;
				table[cell] = skipOld >= skipNew ? skipOld : skipNew;
			}
		}
	}

	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldLines.length && newIndex < newLines.length) {
		if (oldLines[oldIndex] === newLines[newIndex]) {
			ops.push({ kind: "equal", text: oldLines[oldIndex]! });
			oldIndex++;
			newIndex++;
		} else if (table[(oldIndex + 1) * width + newIndex]! >= table[oldIndex * width + newIndex + 1]!) {
			ops.push({ kind: "remove", text: oldLines[oldIndex]! });
			oldIndex++;
		} else {
			ops.push({ kind: "add", text: newLines[newIndex]! });
			newIndex++;
		}
	}
	while (oldIndex < oldLines.length) {
		ops.push({ kind: "remove", text: oldLines[oldIndex]! });
		oldIndex++;
	}
	while (newIndex < newLines.length) {
		ops.push({ kind: "add", text: newLines[newIndex]! });
		newIndex++;
	}
	return ops;
}

function renderLineOps(ops: LineOp[], contextLines: number, coarse: boolean): string[] {
	const changedIndexes: number[] = [];
	for (let index = 0; index < ops.length; index++) {
		if (ops[index]!.kind !== "equal") changedIndexes.push(index);
	}
	const groups: Array<{ start: number; end: number }> = [];
	for (const changed of changedIndexes) {
		const last = groups.at(-1);
		// Overlapping/touching context regions merge into one hunk.
		if (last && changed - last.end - 1 <= contextLines * 2) last.end = changed;
		else groups.push({ start: changed, end: changed });
	}

	const lines: string[] = [];
	if (coarse) lines.push("  (large change: old and new lines are shown as removed and added instead of matched context)");
	let cursor = 0;
	for (const group of groups) {
		const start = Math.max(0, group.start - contextLines);
		const end = Math.min(ops.length, group.end + contextLines + 1);
		if (start > cursor) lines.push(omissionHint(start - cursor));
		for (let index = start; index < end; index++) lines.push(formatOp(ops[index]!));
		cursor = end;
	}
	if (cursor < ops.length) lines.push(omissionHint(ops.length - cursor));
	return lines;
}

function formatOp(op: LineOp): string {
	const marker = op.kind === "remove" ? "- " : op.kind === "add" ? "+ " : "  ";
	return marker + sanitizeForDisplay(op.text);
}

function omissionHint(count: number): string {
	return `  ... ${count} unchanged line${count === 1 ? "" : "s"} omitted ...`;
}

function diffTaskStructure(before: GoalTaskList | undefined, after: GoalTaskList | undefined): string[] {
	const beforeNodes = flattenTaskTree(before);
	const afterNodes = flattenTaskTree(after);
	const beforeById = new Map<string, FlatTaskNode>();
	for (const node of beforeNodes) if (!beforeById.has(node.task.id)) beforeById.set(node.task.id, node);
	const afterById = new Map<string, FlatTaskNode>();
	for (const node of afterNodes) if (!afterById.has(node.task.id)) afterById.set(node.task.id, node);

	const lines: string[] = [];
	const emitted = new Set<string>();
	for (const node of beforeNodes) {
		if (afterById.has(node.task.id) || emitted.has(node.task.id)) continue;
		emitted.add(node.task.id);
		lines.push(formatRemovedTask(node), ...taskAttributes(node, "-"));
	}
	for (const node of afterNodes) {
		if (beforeById.has(node.task.id) || emitted.has(node.task.id)) continue;
		emitted.add(node.task.id);
		lines.push(formatAddedTask(node), ...taskAttributes(node, "+"));
	}
	for (const node of beforeNodes) {
		const next = afterById.get(node.task.id);
		if (!next || emitted.has(node.task.id)) continue;
		emitted.add(node.task.id);
		lines.push(...diffTaskFields(node, next));
	}
	return lines;
}

function flattenTaskTree(taskList: GoalTaskList | undefined): FlatTaskNode[] {
	const nodes: FlatTaskNode[] = [];
	const walk = (tasks: readonly GoalTask[], parentId: string | undefined, depth: number): void => {
		tasks.forEach((task, index) => {
			nodes.push({ task, parentId, order: index + 1, depth });
			if (task.subtasks && task.subtasks.length > 0) walk(task.subtasks, task.id, depth + 1);
		});
	};
	if (taskList) walk(taskList.tasks, undefined, 0);
	return nodes;
}

function taskAttributes(node: FlatTaskNode, marker: string): string[] {
	const lines: string[] = [];
	if (node.task.verificationContract) lines.push(`  ${marker} ${sanitizeInline(node.task.id)} verification contract: ${displayContract(node.task.verificationContract)}`);
	if (node.task.lightweightSubtasks) lines.push(`  ${marker} ${sanitizeInline(node.task.id)} lightweight subtasks: yes`);
	if (node.task.evidence) lines.push(`  ${marker} ${sanitizeInline(node.task.id)} evidence: ${displayText(node.task.evidence)}`);
	return lines;
}

function formatRemovedTask(node: FlatTaskNode): string {
	const progress = node.task.status === "pending" ? "" : ` [${node.task.status}]`;
	return `  - ${sanitizeInline(node.task.id)}: ${JSON.stringify(sanitizeInline(node.task.title))}${progress} (parent: ${sanitizeInline(node.parentId ?? "(none)")}, order: ${node.order})`;
}

function formatAddedTask(node: FlatTaskNode): string {
	const progress = node.task.status === "pending" ? "" : ` [${node.task.status}]`;
	return `  + ${sanitizeInline(node.task.id)}: ${JSON.stringify(sanitizeInline(node.task.title))}${progress} (parent: ${sanitizeInline(node.parentId ?? "(none)")}, order: ${node.order})`;
}

function diffTaskFields(before: FlatTaskNode, after: FlatTaskNode): string[] {
	const lines: string[] = [];
	const changed = (label: string, oldValue: string, newValue: string): void => {
		if (oldValue !== newValue) lines.push(`  ~ ${sanitizeInline(before.task.id)}: ${label}: ${oldValue} -> ${newValue}`);
	};
	changed("title", JSON.stringify(sanitizeInline(before.task.title)), JSON.stringify(sanitizeInline(after.task.title)));
	changed("parent", sanitizeInline(before.parentId ?? "(none)"), sanitizeInline(after.parentId ?? "(none)"));
	changed("order", String(before.order), String(after.order));
	changed(
		"verification contract",
		displayContract(normalizedContract(before.task.verificationContract)),
		displayContract(normalizedContract(after.task.verificationContract)),
	);
	changed(
		"lightweight subtasks",
		yesNoLabel(before.task.lightweightSubtasks === true),
		yesNoLabel(after.task.lightweightSubtasks === true),
	);
	changed("status", before.task.status, after.task.status);
	changed("evidence", displayText(before.task.evidence), displayText(after.task.evidence));
	changed("skip reason", displayText(before.task.skipReason), displayText(after.task.skipReason));
	return lines;
}

function diffSettings(before: GoalRecord, after: GoalRecord): string[] {
	const changes: SettingChange[] = [];
	if (before.tokenBudget !== after.tokenBudget) {
		changes.push({ label: "Token budget (lifetime spending cap)", before: formatBudget(before.tokenBudget), after: formatBudget(after.tokenBudget) });
	}
	const beforeAuditor = !(before.skipAuditor === true);
	const afterAuditor = !(after.skipAuditor === true);
	if (beforeAuditor !== afterAuditor) {
		changes.push({ label: "Independent auditor", before: booleanLabel(beforeAuditor), after: booleanLabel(afterAuditor) });
	}
	if (before.status !== after.status) {
		changes.push({ label: "Status", before: before.status, after: after.status });
	}
	const beforeCurrent = sanitizeInline(before.currentTaskId ?? "(none)");
	const afterCurrent = sanitizeInline(after.currentTaskId ?? "(none)");
	if (beforeCurrent !== afterCurrent) {
		changes.push({ label: "Current task", before: beforeCurrent, after: afterCurrent });
	}
	if (before.autoContinue !== after.autoContinue) {
		changes.push({ label: "Automatic continuation", before: booleanLabel(before.autoContinue), after: booleanLabel(after.autoContinue) });
	}
	return changes.map((change) => `  ~ ${change.label}: ${change.before} -> ${change.after}`);
}

function renderFullText(goal: GoalRecord): string {
	const lines: string[] = ["Objective:"];
	const objectiveLines = splitLogicalLines(goal.objective);
	if (objectiveLines.length === 0) lines.push("  (empty)");
	else for (const line of objectiveLines) lines.push("  " + sanitizeForDisplay(line));

	const fullContract = normalizedContract(goal.verificationContract);
	lines.push("", `Verification contract: ${fullContract === undefined ? "(none)" : sanitizeInline(fullContract)}`);
	lines.push("", "Tasks:");
	const nodes = flattenTaskTree(goal.taskList);
	if (nodes.length === 0) {
		lines.push("  none");
	} else {
		for (const node of nodes) {
			const indent = "  ".repeat(node.depth + 1);
			const lightweight = node.task.lightweightSubtasks === true ? " (lightweight subtasks)" : "";
			lines.push(`${indent}[${node.task.status}] ${sanitizeInline(node.task.id)}: ${sanitizeInline(node.task.title)}${lightweight}`);
			const contract = normalizedContract(node.task.verificationContract);
			if (contract !== undefined) lines.push(`${indent}  verification contract: ${sanitizeInline(contract)}`);
			if (node.task.evidence) lines.push(`${indent}  evidence: ${sanitizeInline(node.task.evidence)}`);
			if (node.task.skipReason) lines.push(`${indent}  skip reason: ${sanitizeInline(node.task.skipReason)}`);
		}
	}
	lines.push("", `Task completion: ${blockLabel(goal.taskList?.blockCompletion === true)}`);
	lines.push("", "Settings:");
	lines.push(`  Token budget (lifetime spending cap): ${formatBudget(goal.tokenBudget)}`);
	lines.push(`  Independent auditor: ${booleanLabel(!(goal.skipAuditor === true))}`);
	lines.push(`  Status: ${goal.status}`);
	lines.push(`  Current task: ${sanitizeInline(goal.currentTaskId ?? "(none)")}`);
	lines.push(`  Automatic continuation: ${booleanLabel(goal.autoContinue)}`);
	return lines.join("\n");
}

function blockLabel(blocks: boolean): string {
	return blocks ? "blocks goal completion until all tasks are complete" : "does not block goal completion";
}

function booleanLabel(value: boolean): string {
	return value ? "enabled" : "disabled";
}

function yesNoLabel(value: boolean): string {
	return value ? "yes" : "no";
}

function formatBudget(budget: number | undefined): string {
	return budget === undefined ? "none" : `${budget} tokens`;
}

function normalizedContract(value: string | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function displayContract(value: string | undefined): string {
	return value === undefined ? "(none)" : JSON.stringify(sanitizeInline(value));
}

function displayText(value: string | undefined): string {
	return typeof value === "string" && value.trim() ? JSON.stringify(sanitizeInline(value)) : "(none)";
}

/** Keep helper-injected control sequences from acting as terminal instructions. */
function sanitizeForDisplay(line: string): string {
	let safe = "";
	for (const char of line) {
		const code = char.codePointAt(0) ?? 0;
		// CRLF is normalized by splitLogicalLines; a stray CR is not content.
		if (code === 0x0d) continue;
		if (code === 0x09 || code === 0x0a) {
			safe += char;
		} else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			safe += "\\x" + code.toString(16).padStart(2, "0");
		} else {
			safe += char;
		}
	}
	return safe;
}

function sanitizeInline(value: string): string {
	return sanitizeForDisplay(value).split("\n").join("\\n");
}
