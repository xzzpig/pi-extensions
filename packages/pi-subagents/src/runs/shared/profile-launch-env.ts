/**
 * [fork] Launch-environment construction for sandbox/permission-profile child
 * launches: the transient env keys the child reads, the pinned permission
 * profile, and the startup-diagnostics channel. Split out of child-launch.ts
 * so the shared launcher keeps only the call site and the final processEnv
 * assembly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { SUBAGENT_SANDBOX_PROFILE_ENV, SUBAGENT_SANDBOX_PROJECT_TRUST_ENV } from "../../shared/sandbox-profile.ts";
import { SUBAGENT_PERMISSION_PROFILE_ENV, SUBAGENT_PERMISSION_PROFILE_PINNED_ENV } from "../../shared/permission-profile.ts";
import { SANDBOX_DIAGNOSTICS_PATH_ENV } from "./sandbox-startup-diagnostics.ts";
import type { PiLaunchToolPlan } from "./child-tool-plan.ts";

const SANDBOX_STARTUP_ACK_PATH_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH";
const SANDBOX_STARTUP_ACK_TOKEN_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN";
// Marks an in-process child so child extensions never mutate the host process
// state (for example a profile-failure exit code) that a separate child process
// would legitimately own.
const IN_PROCESS_CHILD_ENV = "PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD";

/** Structural subset of the child-launch input the profile env needs. */
export interface ProfileLaunchEnvInput {
	cwd: string;
	/** A validated global pi-sandbox profile selected by the agent definition. */
	sandbox?: string;
	/** A validated global pi-permission-system profile selected by the agent definition. */
	permissionProfile?: string;
	/** Parent-authoritative trust state for profile-aware project config merging. */
	projectTrusted?: boolean;
	/** Exact trusted parent cwd; profile project config applies only when the child cwd matches it. */
	trustedProjectCwd?: string;
	host: "parent" | "runner";
}

export interface ProfileLaunchEnv {
	/** Transient env keys the child reads; only a runner-hosted child applies them. */
	childEnv: Record<string, string | undefined> | undefined;
	/** Pinned permission-profile selection; applied to every child launch. */
	profilePin: Record<string, string | undefined>;
	/** Host process env keys to restore once the child session exists. */
	transientProcessEnv: string[];
	/** Path a blocked child extension writes its startup failure to. */
	sandboxDiagnosticsPath?: string;
}

function hasTrustedProfileProjectCwd(input: Pick<ProfileLaunchEnvInput, "cwd" | "projectTrusted" | "trustedProjectCwd">): boolean {
	if (input.projectTrusted !== true || !input.cwd || !input.trustedProjectCwd) return false;
	return path.resolve(input.cwd) === path.resolve(input.trustedProjectCwd);
}

export function buildProfileLaunchEnv(input: ProfileLaunchEnvInput, toolPlan: Pick<PiLaunchToolPlan, "sandboxExtension">): ProfileLaunchEnv {
	// A selected profile is validated by resolvePiLaunchToolPlan; the child
	// receives only the profile identity, trust snapshot, and startup ack
	// channel through its environment. Transient keys are restored after the
	// session is created so the host process never keeps them.
	const sandboxAckPath = toolPlan.sandboxExtension && input.sandbox !== undefined
		? path.join(TEMP_ROOT_DIR, "sandbox-profile-acks", `${randomUUID()}.json`)
		: undefined;
	const sandboxDiagnosticsPath = sandboxAckPath
		? path.join(TEMP_ROOT_DIR, "sandbox-profile-diagnostics", `${randomUUID()}.json`)
		: undefined;
	const sandboxEnv: Record<string, string | undefined> | undefined = sandboxAckPath
		? {
			[SUBAGENT_SANDBOX_PROFILE_ENV]: input.sandbox,
			[SUBAGENT_SANDBOX_PROJECT_TRUST_ENV]: hasTrustedProfileProjectCwd(input) ? "1" : "0",
			[SANDBOX_STARTUP_ACK_PATH_ENV]: sandboxAckPath,
			[SANDBOX_STARTUP_ACK_TOKEN_ENV]: randomUUID(),
			[SANDBOX_DIAGNOSTICS_PATH_ENV]: sandboxDiagnosticsPath,
			...(input.host === "parent" ? { [IN_PROCESS_CHILD_ENV]: "1" } : {}),
		}
		: undefined;
	if (sandboxAckPath) fs.mkdirSync(path.dirname(sandboxAckPath), { recursive: true, mode: 0o700 });

	// A selected permission profile travels as a bare validated name (the rules
	// live in the child's global pi-permission-system config). The key is
	// transient like the sandbox keys: restored on the host once the child
	// session exists.
	const permissionProfileEnv: Record<string, string | undefined> | undefined =
		input.permissionProfile !== undefined
			? { [SUBAGENT_PERMISSION_PROFILE_ENV]: input.permissionProfile }
			: undefined;
	const childEnv: Record<string, string | undefined> | undefined =
		sandboxEnv !== undefined || permissionProfileEnv !== undefined
			? { ...(sandboxEnv ?? {}), ...(permissionProfileEnv ?? {}) }
			: undefined;
	// The profile key is pinned for every launch, `undefined` included: a child
	// that declares no profile must not inherit the host session's role
	// selection, and one that declares a profile must not be overridden by it
	// (the launcher env wins inside pi-permission-system). It is kept out of
	// `childEnv` so a plain in-process child does not also start receiving the
	// binding and MCP values that only a runner-hosted child used to get.
	const profilePin: Record<string, string | undefined> = {
		[SUBAGENT_PERMISSION_PROFILE_ENV]: input.permissionProfile,
		// Present for every child launch: it is what tells pi-permission-system
		// this selection is authoritative for the child (see the constant).
		[SUBAGENT_PERMISSION_PROFILE_PINNED_ENV]: "1",
	};
	const transientProcessEnv = [
		...new Set([
			...(childEnv ? Object.keys(childEnv) : []),
			...Object.keys(profilePin),
		]),
	];
	return {
		childEnv,
		profilePin,
		transientProcessEnv,
		...(sandboxDiagnosticsPath ? { sandboxDiagnosticsPath } : {}),
	};
}
