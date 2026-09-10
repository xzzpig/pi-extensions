import * as fs from "node:fs";

/**
 * A child extension that refuses to start (for example a required sandbox
 * profile that cannot initialize) blocks the first model turn, so the child
 * session ends with no messages and no tool result to inspect. The launcher
 * hands the extension this path through the transient launch environment and
 * reads it back, so the caller sees the real reason instead of an invented
 * empty-output message.
 */
export const SANDBOX_DIAGNOSTICS_PATH_ENV = "PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH";

const MAX_DIAGNOSTIC_BYTES = 8192;

export interface SandboxStartupDiagnostic {
	version: 1;
	profile?: string;
	reason: string;
}

/**
 * Read the startup diagnostic a blocked child extension wrote. The file is
 * treated as untrusted input: only a bounded, well-formed record is accepted.
 */
export function readSandboxStartupDiagnostic(
	diagnosticsPath: string | undefined,
): SandboxStartupDiagnostic | undefined {
	if (!diagnosticsPath) return undefined;
	try {
		const stat = fs.lstatSync(diagnosticsPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DIAGNOSTIC_BYTES) return undefined;
		const parsed: unknown = JSON.parse(fs.readFileSync(diagnosticsPath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as { version?: unknown; profile?: unknown; reason?: unknown };
		if (record.version !== 1) return undefined;
		if (typeof record.reason !== "string" || !record.reason.trim()) return undefined;
		const profile = typeof record.profile === "string" && record.profile.trim() ? record.profile : undefined;
		const diagnostic: SandboxStartupDiagnostic = { version: 1, reason: record.reason.trim() };
		if (profile !== undefined) diagnostic.profile = profile;
		return diagnostic;
	} catch {
		return undefined;
	}
}

/** Best-effort removal so a stale diagnostic cannot describe a later attempt. */
export function clearSandboxStartupDiagnostic(diagnosticsPath: string | undefined): void {
	if (!diagnosticsPath) return;
	try {
		fs.rmSync(diagnosticsPath, { force: true });
	} catch {
		// Best effort: the diagnostics directory lives in the transient temp root.
	}
}
