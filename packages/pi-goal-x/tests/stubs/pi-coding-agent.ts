/**
 * Test adapter for the tiny runtime-valued SDK surface used by pi-goal-x.
 * The unbundled compatibility suite still imports the real package.
 */
export function defineTool<T>(definition: T): T {
	return definition;
}

export function createExtensionRuntime(): Record<string, never> {
	return {};
}

export const SessionManager = {
	inMemory: (cwd: string) => ({ cwd }),
};

export const SettingsManager = {
	inMemory: (settings: unknown) => ({ settings }),
};

export async function createAgentSession(): Promise<never> {
	throw new Error("Real agent sessions are disabled in bundled tests; inject a session fixture.");
}

export function getMarkdownTheme(): Record<string, never> {
	return {};
}

/**
 * The bundled stub cannot honestly replay provider sessions, so the fast
 * runner captures the real public builder before installing this stub (see
 * scripts/test-adapter-hooks.mjs). Real replay semantics stay the SDK's job;
 * this export only forwards to that captured function.
 */
const REAL_SDK_KEY = Symbol.for("@xzzpig/pi-goal-x/real-pi-coding-agent");

type RealBuildSessionContext = (
	entries: readonly unknown[],
	leafId?: string | null,
	byId?: Map<string, unknown>,
) => { messages: unknown[]; thinkingLevel: string; model: { provider: string; modelId: string } | null };

export function buildSessionContext(
	entries: readonly unknown[],
	leafId?: string | null,
	byId?: Map<string, unknown>,
): { messages: unknown[]; thinkingLevel: string; model: { provider: string; modelId: string } | null } {
	const captured = (globalThis as unknown as Record<symbol, { buildSessionContext?: RealBuildSessionContext; error?: string } | undefined>)[REAL_SDK_KEY];
	if (typeof captured?.buildSessionContext !== "function") {
		throw new Error(
			`The bundled test stub cannot build a session context${captured?.error ? ` (${captured.error})` : ""}; run the unbundled SDK suite for real replay.`,
		);
	}
	return captured.buildSessionContext(entries, leafId, byId);
}

export class UserMessageComponent {
	text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(_width?: number): string[] {
		return [this.text];
	}
}

export class AssistantMessageComponent {
	message?: { content?: Array<{ type: string; text?: string; thinking?: string }> };

	constructor(message?: { content?: Array<{ type: string; text?: string; thinking?: string }> }) {
		this.message = message;
	}

	render(_width?: number): string[] {
		return (this.message?.content ?? [])
			.map((content) => content.text ?? content.thinking ?? "")
			.filter(Boolean);
	}
}
