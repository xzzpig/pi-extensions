// Resolve the SDK from this package rather than assuming pnpm's hoisted layout.
// pi-goal-x can require a newer SDK than the workspace's shared catalog.
import { fileURLToPath } from "node:url";

const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const aiEntry = import.meta.resolve("@earendil-works/pi-ai");

export const codingAgentRoot = fileURLToPath(new URL("../", codingAgentEntry));
export const {
	createCodingToolDefinitions: createCodingTools,
	createReadOnlyToolDefinitions: createReadOnlyTools,
} = await import(new URL("./core/tools/index.js", codingAgentEntry));
export const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", codingAgentEntry));
export const { stream: streamResponses } = await import(new URL("./api/openai-responses.js", aiEntry));
