import { existsSync, readFileSync } from "node:fs";

import {
  FilesystemConfigSchema,
  IgnoreViolationsConfigSchema,
  NetworkConfigSchema,
} from "@xzzpig/sandbox-runtime";

import {
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfig as loadUpstreamConfig,
  mergeConfigLayers as mergeUpstreamConfigLayers,
  mergeObjects,
  stringArray,
  type SandboxConfig,
  type SandboxConfigFile,
  type SandboxConfigOverride,
  type SandboxProfileConfig,
} from "./config.ts";

/**
 * [fork] Named-profile sandbox layer.
 *
 * Everything in this module is fork-only: src/config.ts stays byte-identical
 * to upstream (plus the fork's type fields), and this module layers
 * operator-defined sandbox profiles on top of the upstream machinery. When no
 * profile is selected and neither config file defines a profile registry,
 * loadConfig delegates to the upstream loadConfig so the no-profile behavior
 * (parse warnings, error handling, merged defaults) matches upstream exactly.
 */

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export interface SandboxConfigLoadOptions {
  /** Explicit profile; otherwise the child profile environment is consulted. */
  profileName?: string;
  /** Project config is included on the profile path only after affirmative trust. */
  projectTrusted?: boolean;
  /**
   * Receives non-fatal notices produced while loading (currently the «project
   * profiles not applied» warning for an untrusted project). The loader stays a
   * pure function over its inputs: the caller owns delivery (UI notification,
   * stderr, startup diagnostics).
   */
  onWarning?: (message: string) => void;
}

export const SANDBOX_PROFILE_ENV = "PI_SUBAGENT_SANDBOX_PROFILE";
const MAX_PROFILE_NAME_LENGTH = 128;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROFILE_TOP_LEVEL_FIELDS = new Set([
  "inheritGlobalConfig",
  "enabled",
  "permissionPromptTimeoutSeconds",
  "network",
  "filesystem",
  "ignoreViolations",
  "allowBrowserProcess",
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
]);
const PROFILE_NETWORK_FIELDS = new Set([
  "disabled",
  "allowedDomains",
  "deniedDomains",
  "strictAllowlist",
  "allowUnixSockets",
  "allowAllUnixSockets",
  "allowLocalBinding",
  "allowMachLookup",
  "httpProxyPort",
  "socksProxyPort",
  "allowUnauthenticatedSocksProxy",
  "mitmProxy",
  "tlsTerminate",
  "parentProxy",
  "sshProxy",
]);
const PROFILE_FILESYSTEM_FIELDS = new Set([
  "disabled",
  "denyRead",
  "allowRead",
  "allowWrite",
  "denyWrite",
  "protectNonexistentFiles",
]);
const PROFILE_ARRAY_FIELDS = new Set([
  "allowedDomains",
  "deniedDomains",
  "allowUnixSockets",
  "allowMachLookup",
  "denyRead",
  "allowRead",
  "allowWrite",
  "denyWrite",
]);

export function validateSandboxProfileName(value: unknown, label = "sandbox profile"): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty profile name without surrounding whitespace.`);
  }
  if (value === "false") {
    throw new Error(`${label} must select a named profile; the literal false is not supported.`);
  }
  if (value.length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_PROFILE_NAME_LENGTH} characters.`);
  }
  if (!PROFILE_NAME_PATTERN.test(value)) {
    throw new Error(
      `${label} must contain only letters, digits, underscores, or hyphens and start with a letter or digit.`,
    );
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function replaceConfiguredArray(
  base: string[] | undefined,
  override: unknown,
): string[] | undefined {
  const entries = stringArray(override);
  return entries === undefined ? base : [...entries];
}

function unionConfiguredArrays(
  base: string[] | undefined,
  override: unknown,
): string[] | undefined {
  const entries = stringArray(override);
  return entries === undefined ? base : unique([...(base ?? []), ...entries]);
}

function preserveRestrictedBoolean(
  base: boolean | undefined,
  profile: boolean | undefined,
  label: string,
  profileName: string,
): boolean | undefined {
  if (profile === true && base !== true) {
    throw new Error(
      `Sandbox profile '${profileName}' cannot enable '${label}' because its inherited baseline does not enable it.`,
    );
  }
  return profile === false ? false : base;
}

function preserveProtectNonexistentFiles(
  base: boolean | undefined,
  profile: boolean | undefined,
  profileName: string,
): boolean | undefined {
  if (profile === false && base === true) {
    throw new Error(
      `Sandbox profile '${profileName}' cannot disable 'filesystem.protectNonexistentFiles' because its inherited baseline requires it.`,
    );
  }
  return profile === true ? true : base;
}

function hasLiteralDenyWrite(paths: readonly string[] | undefined): boolean {
  return paths?.some((path) => !path.includes("*")) === true;
}

function mergeProfileConfig(
  base: SandboxConfig,
  profile: SandboxProfileConfig,
  profileName: string,
): SandboxConfig {
  const {
    inheritGlobalConfig: _inheritGlobalConfig,
    network: profileNetwork,
    filesystem: profileFilesystem,
    ...topLevel
  } = profile;
  const merged = mergeObjects(base, topLevel);
  const network = { ...merged.network, ...profileNetwork } as NetworkConfig;
  const filesystem = {
    ...merged.filesystem,
    ...profileFilesystem,
  } as FilesystemConfig;

  if (profileNetwork) {
    network.allowedDomains =
      replaceConfiguredArray(merged.network?.allowedDomains, profileNetwork.allowedDomains) ?? [];
    network.allowUnixSockets = replaceConfiguredArray(
      merged.network?.allowUnixSockets,
      profileNetwork.allowUnixSockets,
    );
    network.allowMachLookup = replaceConfiguredArray(
      merged.network?.allowMachLookup,
      profileNetwork.allowMachLookup,
    );
    network.deniedDomains =
      unionConfiguredArrays(merged.network?.deniedDomains, profileNetwork.deniedDomains) ?? [];
  }
  if (profileFilesystem) {
    filesystem.allowRead = replaceConfiguredArray(
      merged.filesystem?.allowRead,
      profileFilesystem.allowRead,
    );
    filesystem.allowWrite =
      replaceConfiguredArray(merged.filesystem?.allowWrite, profileFilesystem.allowWrite) ?? [];
    filesystem.denyRead =
      unionConfiguredArrays(merged.filesystem?.denyRead, profileFilesystem.denyRead) ?? [];
    filesystem.denyWrite =
      unionConfiguredArrays(merged.filesystem?.denyWrite, profileFilesystem.denyWrite) ?? [];
  }

  network.disabled = false;
  filesystem.disabled = false;
  filesystem.protectNonexistentFiles = preserveProtectNonexistentFiles(
    base.filesystem?.protectNonexistentFiles,
    profileFilesystem?.protectNonexistentFiles,
    profileName,
  );
  // A selected profile makes its denyWrite entries a hard child boundary.
  // Keep literal paths in the runtime even before they exist so bash cannot
  // create a sensitive target that write/edit would otherwise reject.
  if (hasLiteralDenyWrite(filesystem.denyWrite)) {
    filesystem.protectNonexistentFiles = true;
  }
  network.strictAllowlist = Boolean(
    base.network?.strictAllowlist || profileNetwork?.strictAllowlist,
  );
  network.allowAllUnixSockets = preserveRestrictedBoolean(
    base.network?.allowAllUnixSockets,
    profileNetwork?.allowAllUnixSockets,
    "network.allowAllUnixSockets",
    profileName,
  );
  network.allowLocalBinding = preserveRestrictedBoolean(
    base.network?.allowLocalBinding,
    profileNetwork?.allowLocalBinding,
    "network.allowLocalBinding",
    profileName,
  );
  network.allowUnauthenticatedSocksProxy = preserveRestrictedBoolean(
    base.network?.allowUnauthenticatedSocksProxy,
    profileNetwork?.allowUnauthenticatedSocksProxy,
    "network.allowUnauthenticatedSocksProxy",
    profileName,
  );

  return {
    ...merged,
    // A profile is an explicit request for child isolation, not an opt-out.
    enabled: true,
    allowBrowserProcess: preserveRestrictedBoolean(
      base.allowBrowserProcess,
      profile.allowBrowserProcess,
      "allowBrowserProcess",
      profileName,
    ),
    enableWeakerNestedSandbox: preserveRestrictedBoolean(
      base.enableWeakerNestedSandbox,
      profile.enableWeakerNestedSandbox,
      "enableWeakerNestedSandbox",
      profileName,
    ),
    enableWeakerNetworkIsolation: preserveRestrictedBoolean(
      base.enableWeakerNetworkIsolation,
      profile.enableWeakerNetworkIsolation,
      "enableWeakerNetworkIsolation",
      profileName,
    ),
    network,
    filesystem,
  };
}

/**
 * [fork] Merge a same-named trusted project profile onto its global profile.
 *
 * The global profile is the baseline the project layer refines, so the merge
 * follows the same conventions a profile uses against its inherited config —
 * but only for the fields the project profile actually mentions:
 *
 * - top-level scalars and allow arrays (allowRead/allowWrite/allowedDomains/
 *   allowUnixSockets/allowMachLookup) take the project's value;
 * - deny arrays (denyRead/denyWrite/deniedDomains) are unioned, so a global
 *   deny can never be dropped or cleared by a project layer, and a project's
 *   empty array is a no-op rather than a clear;
 * - restricted booleans keep preserveRestrictedBoolean semantics: a project
 *   layer may only stay relaxed when the global profile already relaxes it;
 * - protectNonexistentFiles cannot be lowered, and a literal denyWrite entry
 *   keeps it on;
 * - inheritGlobalConfig: false in either layer stays false, so a project layer
 *   can narrow the inherited baseline but never widen it back.
 *
 * Unmentioned fields stay undefined instead of materializing empty arrays: the
 * merged profile is applied onto the inherited config afterwards, where an
 * absent field keeps the inherited value while an empty allow array would
 * replace it with nothing.
 */
export function mergeProfileObjects(
  globalProfile: SandboxProfileConfig,
  projectProfile: SandboxProfileConfig,
  profileName: string,
): SandboxProfileConfig {
  const merged = mergeObjects(
    globalProfile as SandboxConfig,
    projectProfile,
  ) as SandboxProfileConfig;

  const globalNetwork = globalProfile.network;
  const projectNetwork = projectProfile.network;
  if (projectNetwork) {
    const network = merged.network as Partial<NetworkConfig>;
    network.allowedDomains = replaceConfiguredArray(
      globalNetwork?.allowedDomains,
      projectNetwork.allowedDomains,
    );
    network.allowUnixSockets = replaceConfiguredArray(
      globalNetwork?.allowUnixSockets,
      projectNetwork.allowUnixSockets,
    );
    network.allowMachLookup = replaceConfiguredArray(
      globalNetwork?.allowMachLookup,
      projectNetwork.allowMachLookup,
    );
    network.deniedDomains = unionConfiguredArrays(
      globalNetwork?.deniedDomains,
      projectNetwork.deniedDomains,
    );
    network.strictAllowlist =
      globalNetwork?.strictAllowlist === true || projectNetwork.strictAllowlist === true
        ? true
        : network.strictAllowlist;
    network.allowAllUnixSockets = preserveRestrictedBoolean(
      globalNetwork?.allowAllUnixSockets,
      projectNetwork.allowAllUnixSockets,
      "network.allowAllUnixSockets",
      profileName,
    );
    network.allowLocalBinding = preserveRestrictedBoolean(
      globalNetwork?.allowLocalBinding,
      projectNetwork.allowLocalBinding,
      "network.allowLocalBinding",
      profileName,
    );
    network.allowUnauthenticatedSocksProxy = preserveRestrictedBoolean(
      globalNetwork?.allowUnauthenticatedSocksProxy,
      projectNetwork.allowUnauthenticatedSocksProxy,
      "network.allowUnauthenticatedSocksProxy",
      profileName,
    );
  }

  const globalFilesystem = globalProfile.filesystem;
  const projectFilesystem = projectProfile.filesystem;
  if (projectFilesystem) {
    const filesystem = merged.filesystem as Partial<FilesystemConfig>;
    filesystem.allowRead = replaceConfiguredArray(
      globalFilesystem?.allowRead,
      projectFilesystem.allowRead,
    );
    filesystem.allowWrite = replaceConfiguredArray(
      globalFilesystem?.allowWrite,
      projectFilesystem.allowWrite,
    );
    filesystem.denyRead = unionConfiguredArrays(
      globalFilesystem?.denyRead,
      projectFilesystem.denyRead,
    );
    filesystem.denyWrite = unionConfiguredArrays(
      globalFilesystem?.denyWrite,
      projectFilesystem.denyWrite,
    );
    filesystem.protectNonexistentFiles = preserveProtectNonexistentFiles(
      globalFilesystem?.protectNonexistentFiles,
      projectFilesystem.protectNonexistentFiles,
      profileName,
    );
    // A literal denyWrite entry is a hard child boundary; keep it enforced
    // even before the path exists (same rule as a single-profile load).
    if (hasLiteralDenyWrite(filesystem.denyWrite)) {
      filesystem.protectNonexistentFiles = true;
    }
  }

  for (const field of [
    "allowBrowserProcess",
    "enableWeakerNestedSandbox",
    "enableWeakerNetworkIsolation",
  ] as const) {
    const value = preserveRestrictedBoolean(
      globalProfile[field],
      projectProfile[field],
      field,
      profileName,
    );
    if (value !== undefined) merged[field] = value;
  }

  // inheritGlobalConfig governs the merged profile's relation to the inherited
  // baseline, not a profile field: narrowing (false) is sticky in both
  // directions, and a project layer cannot opt back into the global baseline
  // when the global profile opted out of it.
  const inheritGlobalConfig =
    globalProfile.inheritGlobalConfig === false || projectProfile.inheritGlobalConfig === false
      ? false
      : (projectProfile.inheritGlobalConfig ?? globalProfile.inheritGlobalConfig);
  if (inheritGlobalConfig !== undefined) merged.inheritGlobalConfig = inheritGlobalConfig;

  return merged;
}

function configWithoutProfiles(config: SandboxConfigFile): SandboxConfigOverride {
  const { profiles: _profiles, ...withoutProfiles } = config;
  return withoutProfiles;
}

function validateHardDenyConfig(config: SandboxConfigFile, label: string): void {
  const sections: Array<["network" | "filesystem", "deniedDomains" | "denyRead" | "denyWrite"]> = [
    ["network", "deniedDomains"],
    ["filesystem", "denyRead"],
    ["filesystem", "denyWrite"],
  ];
  for (const [section, field] of sections) {
    const rawSection = config[section];
    if (rawSection === undefined) continue;
    if (!rawSection || typeof rawSection !== "object" || Array.isArray(rawSection)) {
      throw new Error(`${label}.${section} must be an object when selecting a sandbox profile.`);
    }
    const value = (rawSection as Record<string, unknown>)[field];
    if (value !== undefined && stringArray(value) === undefined) {
      throw new Error(
        `${label}.${section}.${field} must be an array of strings when selecting a sandbox profile.`,
      );
    }
    if (section === "filesystem") {
      const protectNonexistentFiles = (rawSection as Record<string, unknown>)
        .protectNonexistentFiles;
      if (protectNonexistentFiles !== undefined && typeof protectNonexistentFiles !== "boolean") {
        throw new Error(
          `${label}.filesystem.protectNonexistentFiles must be a boolean when selecting a sandbox profile.`,
        );
      }
    }
  }
}

function globalHardDenyConfig(config: SandboxConfigFile): SandboxConfigOverride {
  const deniedDomains = stringArray(config.network?.deniedDomains);
  const denyRead = stringArray(config.filesystem?.denyRead);
  const denyWrite = stringArray(config.filesystem?.denyWrite);
  const protectNonexistentFiles = config.filesystem?.protectNonexistentFiles === true;
  return {
    ...(deniedDomains ? { network: { deniedDomains } } : {}),
    ...(denyRead || denyWrite
      ? {
          filesystem: {
            ...(denyRead ? { denyRead } : {}),
            ...(denyWrite ? { denyWrite } : {}),
            ...(protectNonexistentFiles ? { protectNonexistentFiles: true } : {}),
          },
        }
      : {}),
  };
}

function validateProfileConfig(value: unknown, profileName: string): SandboxProfileConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Sandbox profile '${profileName}' must be a JSON object.`);
  }
  const profile = value as Record<string, unknown>;
  for (const key of Object.keys(profile)) {
    if (!PROFILE_TOP_LEVEL_FIELDS.has(key)) {
      throw new Error(`Sandbox profile '${profileName}' has unsupported field '${key}'.`);
    }
  }
  if (
    profile.inheritGlobalConfig !== undefined &&
    typeof profile.inheritGlobalConfig !== "boolean"
  ) {
    throw new Error(`Sandbox profile '${profileName}'.inheritGlobalConfig must be a boolean.`);
  }
  if (profile.enabled !== undefined && typeof profile.enabled !== "boolean") {
    throw new Error(`Sandbox profile '${profileName}'.enabled must be a boolean.`);
  }
  if (profile.enabled === false) {
    throw new Error(`Sandbox profile '${profileName}' cannot disable the sandbox.`);
  }
  if (
    profile.permissionPromptTimeoutSeconds !== undefined &&
    (typeof profile.permissionPromptTimeoutSeconds !== "number" ||
      !Number.isFinite(profile.permissionPromptTimeoutSeconds) ||
      profile.permissionPromptTimeoutSeconds < 0)
  ) {
    throw new Error(
      `Sandbox profile '${profileName}'.permissionPromptTimeoutSeconds must be a non-negative finite number.`,
    );
  }
  for (const field of [
    "allowBrowserProcess",
    "enableWeakerNestedSandbox",
    "enableWeakerNetworkIsolation",
  ] as const) {
    if (profile[field] !== undefined && typeof profile[field] !== "boolean") {
      throw new Error(`Sandbox profile '${profileName}.${field}' must be a boolean.`);
    }
  }
  if (
    profile.ignoreViolations !== undefined &&
    !IgnoreViolationsConfigSchema.safeParse(profile.ignoreViolations).success
  ) {
    throw new Error(
      `Sandbox profile '${profileName}.ignoreViolations must map command patterns to arrays of paths.`,
    );
  }

  for (const [section, sectionValue] of [
    ["network", profile.network],
    ["filesystem", profile.filesystem],
  ] as const) {
    if (sectionValue === undefined) continue;
    if (!sectionValue || typeof sectionValue !== "object" || Array.isArray(sectionValue)) {
      throw new Error(`Sandbox profile '${profileName}.${section}' must be an object.`);
    }
    const allowed = section === "network" ? PROFILE_NETWORK_FIELDS : PROFILE_FILESYSTEM_FIELDS;
    for (const [key, item] of Object.entries(sectionValue as Record<string, unknown>)) {
      if (!allowed.has(key)) {
        throw new Error(
          `Sandbox profile '${profileName}.${section}' has unsupported field '${key}'.`,
        );
      }
      if (PROFILE_ARRAY_FIELDS.has(key) && !stringArray(item)) {
        throw new Error(
          `Sandbox profile '${profileName}.${section}.${key}' must be an array of strings.`,
        );
      }
      if (
        key === "disabled" ||
        key === "strictAllowlist" ||
        key === "allowAllUnixSockets" ||
        key === "allowLocalBinding" ||
        key === "allowUnauthenticatedSocksProxy" ||
        key === "protectNonexistentFiles"
      ) {
        if (typeof item !== "boolean") {
          throw new Error(`Sandbox profile '${profileName}.${section}.${key}' must be a boolean.`);
        }
      }
    }
  }

  if (profile.network !== undefined) {
    const { sshProxy, ...runtimeNetwork } = profile.network as Record<string, unknown>;
    if (!NetworkConfigSchema.partial().strict().safeParse(runtimeNetwork).success) {
      throw new Error(
        `Sandbox profile '${profileName}.network contains an invalid sandbox runtime value.`,
      );
    }
    if (sshProxy !== undefined && typeof sshProxy !== "boolean") {
      throw new Error(`Sandbox profile '${profileName}.network.sshProxy' must be a boolean.`);
    }
  }
  if (
    profile.filesystem !== undefined &&
    !FilesystemConfigSchema.partial().strict().safeParse(profile.filesystem).success
  ) {
    throw new Error(
      `Sandbox profile '${profileName}.filesystem contains an invalid sandbox runtime value.`,
    );
  }
  if ((profile.network as Partial<NetworkConfig> | undefined)?.disabled === true) {
    throw new Error(`Sandbox profile '${profileName}' cannot disable network isolation.`);
  }
  if ((profile.filesystem as Partial<FilesystemConfig> | undefined)?.disabled === true) {
    throw new Error(`Sandbox profile '${profileName}' cannot disable filesystem isolation.`);
  }
  return profile as SandboxProfileConfig;
}

function availableProfileNames(profiles: Record<string, SandboxProfileConfig>): string {
  const names = Object.keys(profiles).filter((name) => {
    try {
      validateSandboxProfileName(name);
      return true;
    } catch {
      return false;
    }
  });
  return names.length > 0
    ? names.sort((left, right) => left.localeCompare(right)).join(", ")
    : "(none)";
}

/**
 * Read a config file's `profiles` registry, rejecting a malformed one.
 * `undefined` means the file defines no registry at all (an empty object is a
 * registry that defines no profile).
 */
function profileRegistry(
  config: SandboxConfigFile,
  label: string,
): Record<string, unknown> | undefined {
  const profiles = config.profiles;
  if (profiles === undefined) return undefined;
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
    throw new Error(`${label} 'profiles' must be an object mapping profile names to definitions.`);
  }
  return profiles as Record<string, unknown>;
}

/**
 * Tolerant registry read for an untrusted project.
 *
 * An untrusted project's registry is ignored for resolution, so a malformed one
 * must not turn an ignored definition into a launch failure: it degrades to
 * "no profiles" here, and the strict read happens only once the project is
 * trusted.
 */
function untrustedProfileRegistry(config: SandboxConfigFile): Record<string, unknown> {
  try {
    return profileRegistry(config, "Project sandbox configuration") ?? {};
  } catch {
    return {};
  }
}

/**
 * The «N project profiles not applied» warning for an untrusted project.
 *
 * A trusted project's registry participates in resolution, so nothing is
 * skipped and no warning applies. An untrusted project's registry is never
 * applied — operator ownership of the profile library is what makes a profile a
 * trustworthy policy object — and this names how many definitions were skipped
 * so the ignore is visible instead of silently changing the effective policy.
 */
export function untrustedProjectProfilesWarning(
  projectConfig: SandboxConfigFile,
  projectTrusted: boolean | undefined,
): string | undefined {
  // Only an explicitly untrusted project warns: `undefined` means the caller
  // never evaluated trust (no profile selected), and warning there would report
  // a skip that was not a decision.
  if (projectTrusted !== false) return undefined;
  const count = Object.keys(untrustedProfileRegistry(projectConfig)).length;
  if (count === 0) return undefined;
  return `Project defines ${count} sandbox profile${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not applied (project is not trusted).`;
}

/**
 * [fork] Resolve a selected profile name against the global registry and,
 * when the project is trusted, the project registry.
 *
 * A same-named project profile is merged onto the global one with
 * {@link mergeProfileObjects} so the project layer refines the global profile
 * without weakening its deny boundary. A project-only name resolves directly
 * when trusted.
 *
 * When the project is untrusted its registry never contributes to the result.
 * A name that stays unresolvable then fails closed, and when the name is
 * actually defined only in the ignored project registry the diagnostic says so
 * — a plain "not defined" would hide the trust cause behind an apparently
 * broken profile (project-sandbox-profiles: untrusted projects are ignored, but
 * a project-only selection still must not run unconstrained).
 */
function resolveProfile(
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
  profileName: string,
  projectTrusted: boolean,
): SandboxProfileConfig {
  const globalProfiles = profileRegistry(globalConfig, "Global sandbox configuration");
  const rawGlobal = globalProfiles?.[profileName];
  const globalProfile =
    rawGlobal === undefined ? undefined : validateProfileConfig(rawGlobal, profileName);
  const globalNames = availableProfileNames(
    (globalProfiles ?? {}) as Record<string, SandboxProfileConfig>,
  );

  if (!projectTrusted) {
    const ignoredProfiles = untrustedProfileRegistry(projectConfig);
    if (globalProfile === undefined && ignoredProfiles[profileName] !== undefined) {
      throw new Error(
        `Sandbox profile '${profileName}' is defined only in the project sandbox configuration, which is not trusted. Trust the project or define the profile in the global sandbox configuration.`,
      );
    }
    if (globalProfile !== undefined) return globalProfile;
    throw new Error(
      `Sandbox profile '${profileName}' is not defined in the global sandbox configuration. Add it to the global 'profiles' map. Available profiles: ${globalNames}.`,
    );
  }

  const projectProfiles = profileRegistry(projectConfig, "Project sandbox configuration");
  const rawProject = projectProfiles?.[profileName];
  const projectProfile =
    rawProject === undefined ? undefined : validateProfileConfig(rawProject, profileName);

  if (globalProfile !== undefined && projectProfile !== undefined) {
    return mergeProfileObjects(globalProfile, projectProfile, profileName);
  }
  if (globalProfile !== undefined) return globalProfile;
  if (projectProfile !== undefined) return projectProfile;

  const available = availableProfileNames({
    ...globalProfiles,
    ...projectProfiles,
  } as Record<string, SandboxProfileConfig>);
  throw new Error(
    `Sandbox profile '${profileName}' is not defined in the global or project sandbox configuration. Add it to a 'profiles' map. Available profiles: ${available}.`,
  );
}

export function mergeProfileLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
  profileName: string,
  projectTrusted = false,
): SandboxConfig {
  const name = validateSandboxProfileName(profileName);
  validateHardDenyConfig(globalConfig, "Global sandbox configuration");
  if (projectTrusted) validateHardDenyConfig(projectConfig, "Project sandbox configuration");
  const profile = resolveProfile(globalConfig, projectConfig, name, projectTrusted);
  const baseGlobal =
    profile.inheritGlobalConfig === false
      ? globalHardDenyConfig(globalConfig)
      : configWithoutProfiles(globalConfig);
  const baseProject = projectTrusted ? configWithoutProfiles(projectConfig) : {};
  const base = mergeConfigLayers(defaults, baseGlobal, baseProject);
  if (
    globalConfig.filesystem?.protectNonexistentFiles === true ||
    (projectTrusted && projectConfig.filesystem?.protectNonexistentFiles === true)
  ) {
    base.filesystem = { ...base.filesystem, protectNonexistentFiles: true };
  }
  return mergeProfileConfig(base, profile, name);
}

export function mergeConfigLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
): SandboxConfig {
  // The fork's SandboxConfigFile adds the profiles registry to the upstream
  // shape; strip it before handing the layers to the upstream merge so the
  // registry never leaks into a runtime config.
  return mergeUpstreamConfigLayers(
    defaults,
    configWithoutProfiles(globalConfig),
    configWithoutProfiles(projectConfig),
  );
}

// [fork] Upstream readJsonConfig discards parse errors; the profile layer needs
// them to fail a profile launch with the offending path, so this mirrors the
// upstream reader with the error captured.
function readJsonConfigResult(
  configPath: string,
  warn: boolean,
): { config: SandboxConfigFile; error?: Error } {
  if (!existsSync(configPath)) return { config: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    return { config: parsed as SandboxConfigFile };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (warn) console.error(`Warning: Could not parse ${configPath}: ${normalized}`);
    return { config: {}, error: normalized };
  }
}

/**
 * Names of the profiles available for selection in `cwd`.
 *
 * The global registry is operator-owned and is always listed. A trusted
 * project's registry is added on top so a session-launch picker can offer the
 * names that will actually resolve; an untrusted project's registry is not
 * listed because it can never resolve. A name failing the shared profile-name
 * grammar is skipped rather than reported, so every returned name is safe to use
 * as a selector and a malformed registry entry can never reach a launch site.
 */
export function listGlobalSandboxProfiles(
  cwd: string,
  options: { projectTrusted?: boolean } = {},
): string[] {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const { config: globalConfig } = readJsonConfigResult(globalPath, false);
  const names = new Set(validProfileNames(globalConfig.profiles));
  if (options.projectTrusted === true) {
    const { config: projectConfig } = readJsonConfigResult(projectPath, false);
    for (const name of validProfileNames(projectConfig.profiles)) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/** Selectable names in a registry, skipping entries that cannot be selected. */
function validProfileNames(profiles: unknown): string[] {
  if (profiles === undefined || profiles === null || typeof profiles !== "object") return [];
  if (Array.isArray(profiles)) return [];
  return Object.keys(profiles).filter((name) => {
    try {
      validateSandboxProfileName(name);
      return true;
    } catch {
      return false;
    }
  });
}

export function loadConfig(cwd: string, options: SandboxConfigLoadOptions = {}): SandboxConfig {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const profileName = options.profileName ?? process.env[SANDBOX_PROFILE_ENV];

  // With no profile selected, delegate to the upstream loader whenever neither
  // config file defines a profile registry: the fork layering then has nothing
  // to add, and delegation keeps the no-profile behavior byte-identical to
  // upstream. The peek reads are silent because the upstream loader re-reads
  // both files and emits the parse warnings itself.
  if (profileName === undefined) {
    const globalPeek = readJsonConfigResult(globalPath, false);
    const projectPeek = readJsonConfigResult(projectPath, false);
    if (globalPeek.config.profiles === undefined && projectPeek.config.profiles === undefined) {
      return loadUpstreamConfig(cwd);
    }
  }

  const globalRead = readJsonConfigResult(globalPath, true);
  const projectRead = readJsonConfigResult(projectPath, true);
  const projectTrusted = options.projectTrusted;
  // A project may define a profiles registry; it is ignored while the project
  // is untrusted (profiles stay operator-owned) and participates once the
  // project is affirmatively trusted. The skip is reported, never thrown: an
  // unfixed definition must not turn every launch into a failure.
  const projectProfileWarning = untrustedProjectProfilesWarning(projectRead.config, projectTrusted);
  if (projectProfileWarning !== undefined) options.onWarning?.(projectProfileWarning);
  if (profileName === undefined)
    return mergeConfigLayers(DEFAULT_CONFIG, globalRead.config, projectRead.config);

  validateSandboxProfileName(profileName);
  if (globalRead.error) {
    throw new Error(
      `Cannot load sandbox profile '${profileName}' because global configuration '${globalPath}' is invalid: ${globalRead.error.message}`,
    );
  }
  const projectIncluded = projectTrusted === true;
  if (projectIncluded && projectRead.error) {
    throw new Error(
      `Cannot load sandbox profile '${profileName}' because project configuration '${projectPath}' is invalid: ${projectRead.error.message}`,
    );
  }
  try {
    return mergeProfileLayers(
      DEFAULT_CONFIG,
      globalRead.config,
      projectRead.config,
      profileName,
      projectIncluded,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot load sandbox profile '${profileName}' from '${globalPath}': ${message}`,
    );
  }
}
