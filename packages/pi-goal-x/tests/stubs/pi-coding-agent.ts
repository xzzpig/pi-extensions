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
