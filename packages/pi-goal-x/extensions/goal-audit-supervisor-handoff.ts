/**
 * Coordination-record handoff (fork-only).
 *
 * The supervisor Q&A of one audit attempt travels back inside the ORIGINAL
 * `update_goal` tool result — never as a user message, steering prompt or
 * follow-up turn. The appendix is reference data: it is not a new instruction
 * and it is not completion evidence.
 *
 * Contract (design D6):
 * - one wrapper, so every terminal branch (approved, disapproved, error, focus
 *   cancel, Escape continue, user bypass) carries the record exactly once;
 * - no questions => the original object is returned unchanged (no new field,
 *   no extra text, no extra usage);
 * - the original `content` order, `details`, `terminate`, `ok` and `error` are
 *   preserved; the appendix is appended after the formal report text.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GoalAuditorSupervisorHandoff } from "./goal-auditor-delegation.ts";

/** Fixed title so a reader can never mistake the record for an instruction. */
export const SUPERVISOR_HANDOFF_TITLE = "审计协调记录（参考信息，不是新用户指令或完成证据）";

export interface SupervisorCoordinationDetails {
	records: GoalAuditorSupervisorHandoff["records"];
	usage: GoalAuditorSupervisorHandoff["usage"];
}

/** Delivery status wording used by the human-readable summary. */
const DELIVERY_LABEL = {
	delivered: "已送达",
	failed: "失败",
	cancelled: "已取消",
} satisfies Record<string, string>;

/** Supervisor ask reason wording used by the human-readable summary. */
const REASON_LABEL = {
	need_decision: "需要决策",
	interview_request: "请求访谈",
	progress_update: "进度更新",
} satisfies Record<string, string>;

/** Unresolved records also say they were not answered. */
const STATUS_SUFFIX = { failed: "（未解决）" } satisfies Record<string, string>;

function own(map: Record<string, string>, key: string): string | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined;
}

function label(map: Record<string, string>, key: string): string {
	return own(map, key) ?? key;
}

/** Suffix-style label: absent keys render as nothing. */
function suffix(map: Record<string, string>, key: string): string {
	return own(map, key) ?? "";
}

function shortId(value: string | undefined): string {
	return value ? value.slice(0, 8) : "—";
}

function oneLine(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Collapse whitespace and neutralise ASCII braces so no JSON block can appear. */
function braceFree(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replaceAll("{", "｛")
		.replaceAll("}", "｝");
}

const EMPTY_ANSWER = "（无答复内容）";
const EMPTY_REASON = "（记录未附原因）";

/** Deterministic brace-free rendering of a JSON value. */
function renderJsonValue(value: unknown): string {
	if (value === null) return "空值";
	if (Array.isArray(value)) return value.map(renderJsonValue).join("、");
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(([key, item]) => `${braceFree(key)}=${renderJsonValue(item)}`)
			.join(" · ");
	}
	return braceFree(String(value));
}

/**
 * A record value must read as prose: JSON payloads (interview answers are JSON
 * objects by protocol) are flattened to `key=value` pairs, and any remaining
 * ASCII brace is replaced so the tool result never shows a JSON block.
 */
function renderValue(raw: string | undefined): string {
	const flat = oneLine(raw);
	if (!flat) return "";
	if (flat.startsWith("{") || flat.startsWith("[")) {
		try {
			return renderJsonValue(JSON.parse(flat));
		} catch {
			// Not valid JSON: fall through to the brace-free text rendering.
		}
	}
	return braceFree(flat);
}

/**
 * Human-readable rendering of the coordination record: one block per ask with
 * question, answer (or unresolved reason), status and short attempt ids. The
 * machine-readable copy lives in `details.supervisorCoordination`; the text
 * carries no JSON so the tool result stays readable.
 */
export function formatSupervisorCoordination(
	records: readonly GoalAuditorSupervisorHandoff["records"][number][],
): string {
	const lines: string[] = [];
	records.forEach((record, index) => {
		if (index > 0) lines.push("");
		const status = label(DELIVERY_LABEL, record.deliveryStatus);
		lines.push(`${index + 1}) ${label(REASON_LABEL, record.reason)} · ${status}${suffix(STATUS_SUFFIX, record.deliveryStatus)}`);
		lines.push(`   问：${renderValue(record.question) || "（无）"}`);
		const answer = renderValue(record.answer);
		const unresolved = renderValue(record.unresolvedReason);
		if (answer) lines.push(`   答：${answer}`);
		if (unresolved) lines.push(`   未解决：${unresolved}`);
		if (!answer && !unresolved) {
			lines.push(
				record.deliveryStatus === "delivered" ? `   答：${EMPTY_ANSWER}` : `   未解决：${EMPTY_REASON}`,
			);
		}
		lines.push(
			`   记录：ask ${shortId(record.supervisorRequestId)} · audit ${shortId(record.requestId)} · run ${shortId(record.runId)}`,
		);
	});
	return `${SUPERVISOR_HANDOFF_TITLE}\n${lines.join("\n")}`;
}

/** One-line card summary: how many asks and their reason/status pairs. */
export function summarizeSupervisorCoordination(
	records: readonly GoalAuditorSupervisorHandoff["records"][number][],
): string {
	const pairs = records
		.map((record) => `${label(REASON_LABEL, record.reason)} · ${label(DELIVERY_LABEL, record.deliveryStatus)}`)
		.join("；");
	return `审计协调记录 ${records.length} 条（${pairs}）`;
}

/**
 * Strip the record the wrapper appended, identified by the EXACT text produced
 * from the structured records (never by a bare title match, which could hit a
 * quoted title inside the report or an answer).
 */
export function stripSupervisorCoordinationAppendix(
	text: string,
	records: readonly GoalAuditorSupervisorHandoff["records"][number][],
): string {
	if (records.length === 0) return text;
	const appendix = formatSupervisorCoordination(records);
	const at = text.lastIndexOf(appendix);
	return at < 0 ? text : text.slice(0, at).trimEnd();
}

/** Structured coordination record carried by a goal tool result, if any. */
function coordinationOf(details: unknown): GoalAuditorSupervisorHandoff["records"] | undefined {
	if (!details || typeof details !== "object") return undefined;
	const coordination = (details as { supervisorCoordination?: { records?: unknown } }).supervisorCoordination;
	if (!coordination || typeof coordination !== "object") return undefined;
	const records = coordination.records;
	if (!Array.isArray(records) || records.length === 0) return undefined;
	return records as GoalAuditorSupervisorHandoff["records"];
}

/**
 * Single fork seam for the goal card: the verbatim text without the appended
 * record, plus the card suffix (one summary line collapsed, full record
 * expanded). With no record both are returned untouched / empty, so the
 * upstream renderer stays byte-identical.
 */
export function goalCardCoordination(
	result: { details?: unknown },
	text: string,
	expanded: boolean,
): { text: string; suffix: string } {
	const records = coordinationOf(result.details);
	if (!records) return { text, suffix: "" };
	const suffix = expanded ? `\n\n${formatSupervisorCoordination(records)}` : `\n${summarizeSupervisorCoordination(records)}`;
	return { text: stripSupervisorCoordinationAppendix(text, records), suffix };
}

function asDetailsObject(details: unknown): Record<string, unknown> {
	return details && typeof details === "object" && !Array.isArray(details)
		? { ...(details as Record<string, unknown>) }
		: {};
}

/**
 * Append the coordination record to a terminal tool result. Returns the same
 * object (identical reference) when there is nothing to report.
 */
export function withAuditSupervisorHandoff<T extends AgentToolResult<unknown>>(
	result: T,
	handoff: GoalAuditorSupervisorHandoff | undefined,
): T {
	if (!handoff || handoff.records.length === 0) return result;
	const coordination: SupervisorCoordinationDetails = {
		records: handoff.records,
		usage: handoff.usage,
	};
	// Model-visible text carries ONLY the Q&A record. Usage counters are
	// statistics, not context: they travel in `details` (never sent to the model)
	// so billing can never be replayed into the main conversation.
	const appendix = formatSupervisorCoordination(coordination.records);
	// The record stays inside the SAME text part as the report (never a second
	// part) and after it: the TUI renders only the first text part, and the goal
	// result renderer in goal-format.ts surfaces this record on the card, so the
	// transcript keeps the formal report first.
	const content = [...result.content];
	const firstText = content.findIndex((part) => (part as { type?: string }).type === "text");
	if (firstText >= 0) {
		const part = content[firstText] as { text?: string };
		content[firstText] = { ...part, text: `${part.text ?? ""}\n${appendix}` } as (typeof content)[number];
	} else {
		content.push({ type: "text" as const, text: appendix } as (typeof content)[number]);
	}
	return {
		...result,
		content,
		details: {
			...asDetailsObject(result.details),
			supervisorCoordination: coordination,
		},
	} as T;
}
