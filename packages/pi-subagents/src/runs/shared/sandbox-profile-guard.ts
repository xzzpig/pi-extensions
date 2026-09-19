import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SANDBOX_DIAGNOSTICS_PATH_ENV } from "./sandbox-startup-diagnostics.ts";

const SANDBOX_PROFILE_ENV = "PI_SUBAGENT_SANDBOX_PROFILE";
const SANDBOX_STARTUP_ACK_PATH_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH";
const SANDBOX_STARTUP_ACK_TOKEN_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN";
const MAX_ACK_BYTES = 4096;

function startupAcknowledgementError(profile: string, ackPath: string | undefined, token: string | undefined): string | undefined {
	if (!ackPath || !token) {
		return `Sandbox profile '${profile}' is missing its required startup acknowledgement channel.`;
	}
	try {
		const stat = fs.lstatSync(ackPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ACK_BYTES) {
			return `Sandbox profile '${profile}' did not produce a valid startup acknowledgement.`;
		}
		const parsed: unknown = JSON.parse(fs.readFileSync(ackPath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return `Sandbox profile '${profile}' did not produce a valid startup acknowledgement.`;
		}
		const acknowledgement = parsed as { version?: unknown; profile?: unknown; token?: unknown };
		if (acknowledgement.version !== 1 || acknowledgement.profile !== profile || acknowledgement.token !== token) {
			return `Sandbox profile '${profile}' did not acknowledge successful startup.`;
		}
		return undefined;
	} catch {
		return `Sandbox profile '${profile}' did not acknowledge successful startup.`;
	}
}

export default function registerSandboxProfileGuard(pi: ExtensionAPI): void {
	// Env values are captured at registration, inside the launch env window; the
	// host restores transient sandbox keys after the session is created.
	const profile = process.env[SANDBOX_PROFILE_ENV];
	if (!profile) return;
	const ackPath = process.env[SANDBOX_STARTUP_ACK_PATH_ENV];
	const token = process.env[SANDBOX_STARTUP_ACK_TOKEN_ENV];
	const diagnosticsPath = process.env[SANDBOX_DIAGNOSTICS_PATH_ENV];
	let validated = false;

	// The guard owns the acknowledgement check, so it is also the component that
	// knows the child was refused before its first turn. Publish that reason for
	// the launcher instead of leaving the caller with an empty session.
	const publishDiagnostic = (reason: string): void => {
		if (!diagnosticsPath) return;
		try {
			fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true, mode: 0o700 });
			fs.writeFileSync(
				diagnosticsPath,
				JSON.stringify({ version: 1, profile, reason }),
				{ mode: 0o600 },
			);
		} catch {
			// The stderr diagnostic below remains the fallback channel.
		}
	};

	const check = (): string | undefined => {
		if (validated) return undefined;
		const failure = startupAcknowledgementError(profile, ackPath, token);
		if (!failure) validated = true;
		return failure;
	};

	const clearAcknowledgement = (): void => {
		if (!ackPath || !validated) return;
		try { fs.rmSync(ackPath, { force: true }); } catch { /* best effort */ }
	};

	pi.on("input", (_event, ctx: ExtensionContext) => {
		const failure = check();
		if (failure) {
			process.stderr.write(`pi-subagents: ${failure}\n`);
			publishDiagnostic(failure);
			if (ctx.hasUI) ctx.ui.notify(failure, "error");
			else process.exitCode = 1;
			return { action: "handled" as const };
		}
		clearAcknowledgement();
		return undefined;
	});
}

export type ProjectScopedProfileKind = "sandbox" | "permission";

/**
 * [fork] Shared project-trust gate for project-scoped sandbox/permission
 * profile selections. Returns the error message to surface when the selection
 * is not permitted under the current project-trust state, or undefined when
 * the launch may proceed. The messages are byte-identical to the original
 * preflight and executor copies that this helper replaces.
 */
export function projectScopedProfileTrustError(options: {
	kind: ProjectScopedProfileKind;
	agentName: string;
	profileName: string;
	/** True when the selection is project-scoped (agent source or override scope). */
	projectScoped: boolean;
	/** Resolved trusted project cwd, or undefined when the project is not trusted. */
	trustedCwd: string | undefined;
	/** cwd that must match the trusted project cwd, already in comparison form. */
	effectiveCwd: string;
	/** "preflight" compares raw cwds; "executor" resolves the child cwd and says "child cwd". */
	messageStyle: "preflight" | "executor";
}): string | undefined {
	if (!options.projectScoped) return undefined;
	const label = options.kind === "sandbox" ? "sandbox profile" : "permission profile";
	if (options.trustedCwd === undefined) {
		return `Agent '${options.agentName}' selects ${label} '${options.profileName}' from project scope, but the project is not trusted. Trust the project and retry.`;
	}
	if (options.trustedCwd === options.effectiveCwd) return undefined;
	if (options.messageStyle === "executor") {
		return `Agent '${options.agentName}' selects ${label} '${options.profileName}' from project scope, but child cwd '${options.effectiveCwd}' does not match the trusted project cwd '${options.trustedCwd}'. Launch from the trusted project cwd and retry.`;
	}
	return `Agent '${options.agentName}' selects ${label} '${options.profileName}' from project scope, but cwd '${options.effectiveCwd}' does not match trusted project cwd '${options.trustedCwd}'. Launch from the trusted project cwd and retry.`;
}
