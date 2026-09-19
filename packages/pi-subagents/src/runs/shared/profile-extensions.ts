/**
 * [fork] Sandbox/permission-profile child-extension resolution. Split out of
 * child-tool-plan.ts so the shared tool planner keeps only the call site: the
 * profile validation, the sandbox extension lookup, and the permission-system
 * fallback for profile-only agents live here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";
import { validateSandboxProfileName } from "../../shared/sandbox-profile.ts";
import { validatePermissionProfileName } from "../../shared/permission-profile.ts";
import type { ResolvedSubagentCapabilityCeiling } from "./capability-ceiling.ts";
import { resolvePermissionSystemExtension } from "./child-tool-plan.ts";

export function resolveSandboxExtensionForProfile(profileName: string): string {
	validateSandboxProfileName(profileName, "sandbox profile");
	return resolveSandboxExtension();
}

function resolveSandboxExtension(): string {
	const agentDir = getAgentDir();
	const candidates = [
		path.join(agentDir, "npm", "node_modules", "@xzzpig", "pi-sandbox"),
		path.join(agentDir, "npm", "node_modules", "pi-sandbox"),
		path.join(agentDir, "extensions", "pi-sandbox"),
	];
	const errors: Error[] = [];
	let foundPackage = false;
	for (const extDir of candidates) {
		if (!fs.existsSync(extDir)) continue;
		foundPackage = true;
		const pkgPath = path.join(extDir, "package.json");
		if (!fs.existsSync(pkgPath)) {
			errors.push(new Error(`Sandbox package manifest is missing at ${pkgPath}.`));
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("manifest root must be an object");
			}
			const manifest = parsed as { name?: unknown; pi?: { extensions?: unknown } };
			if (manifest.name !== "@xzzpig/pi-sandbox" && manifest.name !== "pi-sandbox") {
				throw new Error(`Sandbox package manifest at ${pkgPath} must declare name '@xzzpig/pi-sandbox' or 'pi-sandbox'.`);
			}
			const extensions = manifest.pi?.extensions;
			const entry = Array.isArray(extensions) ? extensions[0] : undefined;
			if (typeof entry !== "string" || !entry.trim()) {
				throw new Error(`Sandbox package manifest at ${pkgPath} must declare pi.extensions[0] as a non-empty string.`);
			}
			if (path.isAbsolute(entry)) {
				throw new Error(`Sandbox extension entry ${JSON.stringify(entry)} in ${pkgPath} must be relative to the package directory.`);
			}
			const resolved = path.resolve(extDir, entry);
			const relative = path.relative(extDir, resolved);
			if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				throw new Error(`Sandbox extension entry ${JSON.stringify(entry)} in ${pkgPath} must remain inside ${extDir}.`);
			}
			if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
				throw new Error(`Sandbox extension entry ${JSON.stringify(entry)} in ${pkgPath} does not resolve to a file at ${resolved}.`);
			}
			const realPackageRoot = fs.realpathSync(extDir);
			const realEntry = fs.realpathSync(resolved);
			const realRelative = path.relative(realPackageRoot, realEntry);
			if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
				throw new Error(`Sandbox extension entry ${JSON.stringify(entry)} in ${pkgPath} resolves outside ${extDir}.`);
			}
			return resolved;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(message.startsWith("Sandbox") ? new Error(message) : new Error(`Cannot read sandbox package manifest at ${pkgPath}: ${message}`));
		}
	}
	if (errors.length > 0) throw errors[0]!;
	if (!foundPackage) {
		throw new Error(`pi-sandbox is not installed; cannot launch a child with sandbox profile.`);
	}
	throw new Error(`No usable pi-sandbox extension manifest was found under '${agentDir}'.`);
}

export interface ResolvedProfileExtensions {
	/** Absolute path of the resolved pi-sandbox child extension when a sandbox profile is selected. */
	sandboxExtension?: string;
	/** The permission-system child extension a launch must load: rules-driven or profile-driven. */
	effectivePermSystemExt?: string;
}

/**
 * Validate the selected sandbox/permission profiles and resolve the child
 * extensions they require. `permSystemExt` is the rules-driven permission-system
 * resolution the tool plan already computed; when only a permission profile is
 * selected the extension is resolved eagerly here and a missing package fails
 * the launch instead of silently degrading to no policy at all.
 */
export function resolveProfileExtensions(input: {
	sandbox?: string;
	permissionProfile?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	permSystemExt?: string;
}): ResolvedProfileExtensions {
	const { capabilityCeiling, permSystemExt } = input;
	const sandboxProfile = input.sandbox === undefined
		? undefined
		: validateSandboxProfileName(input.sandbox, "sandbox profile");
	if (sandboxProfile && capabilityCeiling?.denyExtensions) {
		throw new Error(`Sandbox profile '${sandboxProfile}' requires the pi-sandbox child extension, but this launch denies child extensions.`);
	}
	const permissionProfile = input.permissionProfile === undefined
		? undefined
		: validatePermissionProfileName(input.permissionProfile, "permission profile");
	if (permissionProfile && capabilityCeiling?.denyExtensions) {
		throw new Error(`Permission profile '${permissionProfile}' requires the pi-permission-system child extension, but this launch denies child extensions.`);
	}
	const permSystemExtForProfile = permissionProfile !== undefined && permSystemExt === undefined
		? resolvePermissionSystemExtension()
		: undefined;
	if (permissionProfile !== undefined && permSystemExt === undefined && permSystemExtForProfile === undefined) {
		throw new Error(`Permission profile '${permissionProfile}' cannot be enabled: pi-permission-system is not installed; cannot launch a child with a permission profile.`);
	}
	const effectivePermSystemExt = permSystemExt ?? permSystemExtForProfile;
	let sandboxExtension: string | undefined;
	if (sandboxProfile) {
		try {
			sandboxExtension = resolveSandboxExtensionForProfile(sandboxProfile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Sandbox profile '${sandboxProfile}' cannot be enabled: ${message}`);
		}
	}
	return {
		...(sandboxExtension ? { sandboxExtension } : {}),
		...(effectivePermSystemExt ? { effectivePermSystemExt } : {}),
	};
}
