import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { events, makeAgentConfigs } from "../support/helpers.ts";
import { installSingleExecutionHooks, mockPi, tempDir } from "../support/single-execution-fixture.ts";

const blockedMessage = "Tool budget hard limit reached after 1 tool call (hard 0). The 'bash' tool is blocked so you can finalize from the context you already have.";

describe("fork tool-result budget completion", () => {
	installSingleExecutionHooks();

	for (const eventType of ["tool_result_end", "message_end"] as const) {
		it(`uses ${eventType} message.toolName before an overlapping pending read and deduplicates delivery`, async () => {
			const blocked = { role: "toolResult", toolCallId: "blocked-bash", toolName: "bash", isError: true, content: [{ type: "text", text: blockedMessage }] };
			mockPi.onCall({ steps: [{ jsonl: [
				{ type: "tool_execution_start", toolCallId: "pending-read", toolName: "read", args: { path: "notes.md" } },
				{ type: eventType, message: blocked },
				{ type: eventType === "message_end" ? "tool_result_end" : "message_end", message: blocked },
				{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "pending-read", toolName: "read", isError: false, content: [{ type: "text", text: "notes" }] } },
				events.assistantMessage("Bash was blocked."),
			] }] });
			const result = await runSync(tempDir, makeAgentConfigs(["worker"]), "worker", "Inspect the notes.", {
				toolBudget: { hard: 0, block: "*" },
				acceptance: false,
			});
			assert.equal(result.toolBudgetBlocked, true);
			assert.equal(result.toolBudget?.blockedTool, "bash");
			assert.equal(result.messages?.filter((message) => message.role === "toolResult" && message.toolCallId === "blocked-bash").length, 1);
		});
	}

	it("does not classify a read quoting another tool's budget message as blocked", async () => {
		mockPi.onCall({ steps: [{ jsonl: [
			{ type: "tool_execution_start", toolCallId: "pending-read", toolName: "read", args: { path: "notes.md" } },
			{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "pending-read", toolName: "read", isError: false, content: [{ type: "text", text: blockedMessage }] } },
			events.assistantMessage("The notes quote a budget message."),
		] }] });
		const result = await runSync(tempDir, makeAgentConfigs(["worker"]), "worker", "Inspect the notes.", {
			toolBudget: { hard: 0, block: "*" },
				acceptance: false,
		});
		assert.equal(result.toolBudgetBlocked, undefined);
	});
});
