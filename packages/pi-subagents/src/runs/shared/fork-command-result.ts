import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** Pi 1 reports shell failures as results; the command controller owns a rejected failure path. */
export function requireSuccessfulCommandResult<T extends AgentToolResult<unknown>>(result: T): T {
	if ((result as T & { isError?: boolean }).isError === true) {
		const message = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		throw new Error(message || "Command failed.");
	}
	return result;
}
