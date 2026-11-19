import type { DiffTextEntry } from "@xzzpig/pi-components/diff";
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

/** UI-only structure is deliberately separate from the persisted presentation. */
export interface TweakComparison {
	presentation: TweakPresentation;
	entries: DiffTextEntry[];
	/** Explicit UI escaping is never persisted in the legacy presentation. */
	fullUiText: string;
}

interface DiffProjection {
	lines: string[];
	entries: DiffTextEntry[];
}

function diffMeta(content: string): DiffTextEntry {
	return { kind: "meta", content, hunkIndex: 1 };
}

function diffLine(lineKind: "add" | "remove" | "context", content: string): DiffTextEntry {
	return { kind: "line", lineKind, content, hunkIndex: 1 };
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
	uiBefore?: string;
	uiAfter?: string;
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
	return projectBodyDiff(before, after, options).body;
}

function projectBodyDiff(before: string, after: string, options: TweakPresentationOptions): { body: BodyLineDiff; entries: DiffTextEntry[] } {
	const contextLines = boundedInteger(options.contextLines, DEFAULT_CONTEXT_LINES, 0);
	const maxDiffCells = boundedInteger(options.maxDiffCells, DEFAULT_MAX_DIFF_CELLS, 1);
	const { ops, coarse } = buildLineOps(splitLogicalLines(before), splitLogicalLines(after), maxDiffCells);
	const hasChanges = ops.some((op) => op.kind !== "equal");
	if (!hasChanges) return { body: { lines: [], hasChanges: false, coarse }, entries: [] };
	const projection = renderLineOps(ops, contextLines, coarse);
	return { body: { lines: projection.lines, hasChanges: true, coarse }, entries: projection.entries };
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
	return buildTweakComparison(before, candidate, options).presentation;
}

/** Compare once, projecting the saved text and ephemeral UI rows from the same changes. */
export function buildTweakComparison(
	before: GoalRecord,
	candidate: GoalRecord,
	options: TweakPresentationOptions = {},
): TweakComparison {
	const changedSections: string[] = [];
	const diffLines: string[] = [];
	const entries: DiffTextEntry[] = [];
	const body = projectBodyDiff(before.objective, candidate.objective, options);
	if (body.body.hasChanges) {
		changedSections.push("Objective");
		diffLines.push("Objective:");
		entries.push(diffMeta("Objective:"));
		for (const line of body.body.lines) diffLines.push(line);
		for (const entry of body.entries) entries.push(entry);
	}

	const beforeContract = normalizedContract(before.verificationContract);
	const afterContract = normalizedContract(candidate.verificationContract);
	if (beforeContract !== afterContract) {
		changedSections.push("Verification contract");
		const oldLegacy = displayContract(beforeContract), newLegacy = displayContract(afterContract);
		const oldUi = displayUiContract(beforeContract), newUi = displayUiContract(afterContract);
		diffLines.push("Verification contract:", `  - ${oldLegacy}`, `  + ${newLegacy}`);
		entries.push(diffMeta("Verification contract:"), diffLine("remove", oldUi), diffLine("add", newUi));
	}

	const tasks = diffTaskStructure(before.taskList, candidate.taskList);
	if (tasks.lines.length > 0) {
		changedSections.push("Tasks");
		diffLines.push("Tasks:");
		for (const line of tasks.lines) diffLines.push(line);
	}
	if (tasks.entries.length > 0) {
		entries.push(diffMeta("Tasks:"));
		for (const entry of tasks.entries) entries.push(entry);
	}

	const beforeBlocks = before.taskList?.blockCompletion === true;
	const afterBlocks = candidate.taskList?.blockCompletion === true;
	if (beforeBlocks !== afterBlocks) {
		changedSections.push("Task completion");
		diffLines.push(`Task completion: ${blockLabel(beforeBlocks)} -> ${blockLabel(afterBlocks)}`);
		entries.push(diffMeta("Task completion:"), diffLine("remove", blockLabel(beforeBlocks)), diffLine("add", blockLabel(afterBlocks)));
	}

	const settings = diffSettings(before, candidate);
	const legacySettings = settings.filter((change) => change.before !== change.after);
	if (legacySettings.length > 0) {
		changedSections.push("Settings");
		diffLines.push("Settings:", ...legacySettings.map((change) => `  ~ ${change.label}: ${change.before} -> ${change.after}`));
	}
	if (settings.length > 0) {
		entries.push(diffMeta("Settings:"));
		for (const change of settings) entries.push(diffMeta(change.label + ":"), diffLine("remove", change.uiBefore ?? change.before), diffLine("add", change.uiAfter ?? change.after));
	}

	const hasChanges = changedSections.length > 0;
	return {
		presentation: {
			hasChanges,
			summary: hasChanges ? `Modified: ${changedSections.join(", ")}.` : NO_CHANGES_TEXT,
			changedSections,
			diffText: hasChanges ? diffLines.join("\n") : NO_CHANGES_TEXT,
			fullText: renderFullText(candidate),
		},
		entries: entries.length > 0 ? entries : [diffMeta(NO_CHANGES_TEXT)],
		fullUiText: renderFullText(candidate, true),
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

function renderLineOps(ops: LineOp[], contextLines: number, coarse: boolean): DiffProjection {
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
	const entries: DiffTextEntry[] = [];
	const addMeta = (value: string): void => { lines.push(value); entries.push(diffMeta(value)); };
	if (coarse) addMeta("  (large change: old and new lines are shown as removed and added instead of matched context)");
	let cursor = 0;
	for (const group of groups) {
		const start = Math.max(0, group.start - contextLines);
		const end = Math.min(ops.length, group.end + contextLines + 1);
		if (start > cursor) addMeta(omissionHint(start - cursor));
		for (let index = start; index < end; index++) {
			const op = ops[index]!;
			lines.push(formatOp(op));
			entries.push(diffLine(op.kind === "equal" ? "context" : op.kind, sanitizeBodyUi(op.text)));
		}
		cursor = end;
	}
	if (cursor < ops.length) addMeta(omissionHint(ops.length - cursor));
	return { lines, entries };
}

function formatOp(op: LineOp): string {
	const marker = op.kind === "remove" ? "- " : op.kind === "add" ? "+ " : "  ";
	return marker + sanitizeForDisplay(op.text);
}

function omissionHint(count: number): string {
	return `  ... ${count} unchanged line${count === 1 ? "" : "s"} omitted ...`;
}

function diffTaskStructure(before: GoalTaskList | undefined, after: GoalTaskList | undefined): DiffProjection {
	const beforeNodes = flattenTaskTree(before);
	const afterNodes = flattenTaskTree(after);
	const beforeById = new Map<string, FlatTaskNode>();
	for (const node of beforeNodes) if (!beforeById.has(node.task.id)) beforeById.set(node.task.id, node);
	const afterById = new Map<string, FlatTaskNode>();
	for (const node of afterNodes) if (!afterById.has(node.task.id)) afterById.set(node.task.id, node);

	const lines: string[] = [];
	const entries: DiffTextEntry[] = [];
	const emitted = new Set<string>();
	const addTask = (node: FlatTaskNode, kind: "remove" | "add"): void => {
		const marker = kind === "remove" ? "-" : "+";
		// A different ID is an addition/deletion, never a paired rename.
		entries.push(diffMeta(`${sanitizeForUi(node.task.id)} (${kind === "remove" ? "removed" : "added"}):`));
		const values = [formatTask(node), ...taskAttributes(node)];
		const uiValues = [formatTask(node, true), ...taskAttributes(node, true)];
		for (const value of values) lines.push(`  ${marker} ${value}`);
		for (const value of uiValues) entries.push(diffLine(kind, value));
	};
	for (const node of beforeNodes) {
		if (afterById.has(node.task.id) || emitted.has(node.task.id)) continue;
		emitted.add(node.task.id);
		addTask(node, "remove");
	}
	for (const node of afterNodes) {
		if (beforeById.has(node.task.id) || emitted.has(node.task.id)) continue;
		emitted.add(node.task.id);
		addTask(node, "add");
	}
	for (const node of beforeNodes) {
		const next = afterById.get(node.task.id);
		if (!next || emitted.has(node.task.id)) continue;
		emitted.add(node.task.id);
		lines.push(...diffTaskFields(node, next, entries));
	}
	return { lines, entries };
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

function taskAttributes(node: FlatTaskNode, ui = false): string[] {
	const lines: string[] = [];
	const id = (ui ? sanitizeForUi : sanitizeInline)(node.task.id);
	if (node.task.verificationContract) lines.push(`${id} verification contract: ${(ui ? displayUiContract : displayContract)(node.task.verificationContract)}`);
	if (node.task.lightweightSubtasks) lines.push(`${id} lightweight subtasks: yes`);
	if (node.task.evidence) lines.push(`${id} evidence: ${(ui ? displayUiText : displayText)(node.task.evidence)}`);
	if (ui && node.task.skipReason) lines.push(`${id} skip reason: ${displayUiText(node.task.skipReason)}`);
	return lines;
}

function formatTask(node: FlatTaskNode, ui = false): string {
	const progress = node.task.status === "pending" ? "" : ` [${node.task.status}]`;
	const inline = ui ? sanitizeForUi : sanitizeInline;
	const parent = ui && node.parentId !== undefined ? JSON.stringify(inline(node.parentId)) : inline(node.parentId ?? "(none)");
	return `${inline(node.task.id)}: ${JSON.stringify(inline(node.task.title))}${progress} (parent: ${parent}, order: ${node.order})`;
}

function diffTaskFields(before: FlatTaskNode, after: FlatTaskNode, entries: DiffTextEntry[]): string[] {
	const lines: string[] = [];
	const changed = (label: string, oldValue: string, newValue: string, detail?: { changed: boolean; oldUi: string; newUi: string }): void => {
		if (oldValue !== newValue) lines.push(`  ~ ${sanitizeInline(before.task.id)}: ${label}: ${oldValue} -> ${newValue}`);
		if (detail?.changed ?? oldValue !== newValue) {
			entries.push(diffMeta(`${sanitizeForUi(before.task.id)}: ${label}:`), diffLine("remove", detail?.oldUi ?? oldValue), diffLine("add", detail?.newUi ?? newValue));
		}
	};
	changed("title", JSON.stringify(sanitizeInline(before.task.title)), JSON.stringify(sanitizeInline(after.task.title)), {
		changed: before.task.title !== after.task.title, oldUi: JSON.stringify(sanitizeForUi(before.task.title)), newUi: JSON.stringify(sanitizeForUi(after.task.title)),
	});
	changed("parent", sanitizeInline(before.parentId ?? "(none)"), sanitizeInline(after.parentId ?? "(none)"), {
		changed: before.parentId !== after.parentId, oldUi: before.parentId === undefined ? "(none)" : JSON.stringify(sanitizeForUi(before.parentId)), newUi: after.parentId === undefined ? "(none)" : JSON.stringify(sanitizeForUi(after.parentId)),
	});
	changed("order", String(before.order), String(after.order));
	changed(
		"verification contract",
		displayContract(normalizedContract(before.task.verificationContract)),
		displayContract(normalizedContract(after.task.verificationContract)),
		{ changed: normalizedContract(before.task.verificationContract) !== normalizedContract(after.task.verificationContract),
			oldUi: displayUiContract(normalizedContract(before.task.verificationContract)), newUi: displayUiContract(normalizedContract(after.task.verificationContract)) },
	);
	changed(
		"lightweight subtasks",
		yesNoLabel(before.task.lightweightSubtasks === true),
		yesNoLabel(after.task.lightweightSubtasks === true),
	);
	changed("status", before.task.status, after.task.status);
	for (const [label, oldRaw, newRaw] of [["evidence", before.task.evidence, after.task.evidence], ["skip reason", before.task.skipReason, after.task.skipReason]] as const) {
		const oldValue = normalizedContract(oldRaw), newValue = normalizedContract(newRaw);
		changed(label, displayText(oldRaw), displayText(newRaw), { changed: oldValue !== newValue || (oldValue !== undefined && newValue !== undefined && oldRaw !== newRaw),
			oldUi: displayUiText(oldRaw), newUi: displayUiText(newRaw) });
	}
	return lines;
}

function diffSettings(before: GoalRecord, after: GoalRecord): SettingChange[] {
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
	if (before.currentTaskId !== after.currentTaskId) {
		const formatUi = (id: string | undefined) => id === undefined ? "(none)" : JSON.stringify(sanitizeForUi(id));
		const uiBefore = formatUi(before.currentTaskId), uiAfter = formatUi(after.currentTaskId);
		changes.push({ label: "Current task", before: beforeCurrent,
			after: afterCurrent, uiBefore, uiAfter });
	}
	if (before.autoContinue !== after.autoContinue) {
		changes.push({ label: "Automatic continuation", before: booleanLabel(before.autoContinue), after: booleanLabel(after.autoContinue) });
	}
	return changes;
}

function renderFullText(goal: GoalRecord, ui = false): string {
	const inline = ui ? sanitizeForUi : sanitizeInline;
	const lines: string[] = ["Objective:"];
	const objectiveLines = splitLogicalLines(goal.objective);
	if (objectiveLines.length === 0) lines.push(ui ? "  ⟦EMPTY OBJECTIVE⟧" : "  (empty)");
	else for (let index = 0; index < objectiveLines.length; index++) {
		const line = objectiveLines[index]!;
		const content = ui ? sanitizeBodyUi(line).replace(/ +$/g, spaces => "⟦SPACE⟧".repeat(spaces.length)) : sanitizeForDisplay(line);
		lines.push("  " + content + (ui && index < objectiveLines.length - 1 ? "⏎" : ""));
	}

	const fullContract = normalizedContract(goal.verificationContract);
	// Keep the stored fullText format, but distinguish missing from literal values in the dialog.
	const contractDisplay = ui ? displayUiContract(fullContract) : fullContract === undefined ? "(none)" : inline(fullContract);
	lines.push("", `Verification contract: ${contractDisplay}`);
	lines.push("", "Tasks:");
	const nodes = flattenTaskTree(goal.taskList);
	if (nodes.length === 0) {
		lines.push("  none");
	} else {
		for (const node of nodes) {
			const indent = "  ".repeat(node.depth + 1);
			const lightweight = node.task.lightweightSubtasks === true ? " (lightweight subtasks)" : "";
			const title = ui ? JSON.stringify(inline(node.task.title)) : inline(node.task.title);
			lines.push(`${indent}[${node.task.status}] ${inline(node.task.id)}: ${title}${lightweight}`);
			const contract = normalizedContract(node.task.verificationContract);
			if (contract !== undefined) lines.push(`${indent}  verification contract: ${inline(contract)}`);
			if (node.task.evidence) lines.push(`${indent}  evidence: ${inline(node.task.evidence)}`);
			if (node.task.skipReason) lines.push(`${indent}  skip reason: ${inline(node.task.skipReason)}`);
		}
	}
	lines.push("", `Task completion: ${blockLabel(goal.taskList?.blockCompletion === true)}`);
	lines.push("", "Settings:");
	lines.push(`  Token budget (lifetime spending cap): ${formatBudget(goal.tokenBudget)}`);
	lines.push(`  Independent auditor: ${booleanLabel(!(goal.skipAuditor === true))}`);
	lines.push(`  Status: ${goal.status}`);
	const current = ui && goal.currentTaskId !== undefined ? JSON.stringify(inline(goal.currentTaskId)) : inline(goal.currentTaskId ?? "(none)");
	lines.push(`  Current task: ${current}`);
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

function displayUiContract(value: string | undefined): string {
	return value === undefined ? "(none)" : JSON.stringify(sanitizeForUi(value));
}

function displayUiText(value: string | undefined): string {
	return typeof value === "string" && value.trim() ? JSON.stringify(sanitizeForUi(value)) : "(none)";
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

/** UI-only escaping makes raw tabs/newlines and their literal spellings distinct. */
function sanitizeForUi(value: string): string {
	const escaped = value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
	return sanitizeForDisplay(escaped).split("\n").join("\\n");
}

/** Body lines display ordinary backslashes literally. Controls use explicit
 * labels so tabs/CR remain distinguishable without altering normal paths. */
function sanitizeBodyUi(value: string): string {
	const escaped = value.replaceAll("⟦", "⟦⟦").replaceAll("⏎", "⟦U+23CE⟧").replaceAll("\r", "⟦CR⟧").replaceAll("\t", "⟦TAB⟧")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\p{White_Space}/gu, char => char === " " || char === "\n" ? char : `⟦U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`);
	return sanitizeForDisplay(escaped);
}
