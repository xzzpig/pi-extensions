import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  FilesystemConfigSchema,
  IgnoreViolationsConfigSchema,
  NetworkConfigSchema,
  type SandboxRuntimeConfig,
} from "@xzzpig/sandbox-runtime";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network"> & {
  enabled?: boolean;
  sandboxUserShell?: boolean;
  permissionPromptTimeoutSeconds?: number;
  network?: NonNullable<SandboxRuntimeConfig["network"]> & {
    allowUnauthenticatedSocksProxy?: boolean;
    /** Route ordinary `ssh` commands through the sandbox SOCKS proxy. */
    sshProxy?: boolean;
    /**
     * Disable all network restrictions: no domain prompts, no OS-level
     * network isolation, no local proxy. Filesystem rules still apply.
     * Defaults to false.
     */
    disabled?: boolean;
  };
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;
type SandboxConfigOverride = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export type SandboxProfileConfig = SandboxConfigOverride & {
  inheritGlobalConfig?: boolean;
};

export type SandboxConfigFile = SandboxConfigOverride & {
  profiles?: Record<string, SandboxProfileConfig>;
};

export interface SandboxConfigLoadOptions {
  /** Explicit profile; otherwise the child profile environment is consulted. */
  profileName?: string;
  /** Project config is included on the profile path only after affirmative trust. */
  projectTrusted?: boolean;
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

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  sandboxUserShell: true,
  permissionPromptTimeoutSeconds: DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  network: {
    allowUnauthenticatedSocksProxy: process.platform === "darwin",
    sshProxy: true,
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local", "Library"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    protectNonexistentFiles: false,
  },
};

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigOverride): SandboxConfig {
  const { network, filesystem, ...topLevel } = overrides;
  return {
    ...base,
    ...topLevel,
    network: network ? ({ ...base.network, ...network } as NetworkConfig) : base.network,
    filesystem: filesystem
      ? ({ ...base.filesystem, ...filesystem } as FilesystemConfig)
      : base.filesystem,
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
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

function mergeConfiguredArray(
  fallback: string[] | undefined,
  globalValue: unknown,
  projectValue: unknown,
): string[] | undefined {
  const globalEntries = stringArray(globalValue);
  const projectEntries = stringArray(projectValue);
  if (globalEntries === undefined && projectEntries === undefined) return fallback;
  return unique([...(globalEntries ?? []), ...(projectEntries ?? [])]);
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

function resolveProfile(
  globalConfig: SandboxConfigFile,
  profileName: string,
): SandboxProfileConfig {
  const profiles = globalConfig.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error(
      `Sandbox profile '${profileName}' is not defined in the global sandbox configuration. Add it to the global 'profiles' map. Available profiles: (none).`,
    );
  }
  const rawProfile = profiles[profileName];
  if (rawProfile === undefined) {
    throw new Error(
      `Sandbox profile '${profileName}' is not defined in the global sandbox configuration. Add it to the global 'profiles' map. Available profiles: ${availableProfileNames(profiles)}.`,
    );
  }
  return validateProfileConfig(rawProfile, profileName);
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
  const profile = resolveProfile(globalConfig, name);
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
  const globalOverrides = configWithoutProfiles(globalConfig);
  const projectOverrides = configWithoutProfiles(projectConfig);
  const merged = mergeObjects(mergeObjects(defaults, globalOverrides), projectOverrides);

  return {
    ...merged,
    network: {
      ...merged.network,
      allowedDomains:
        mergeConfiguredArray(
          defaults.network?.allowedDomains,
          globalOverrides.network?.allowedDomains,
          projectOverrides.network?.allowedDomains,
        ) ?? [],
      deniedDomains:
        mergeConfiguredArray(
          defaults.network?.deniedDomains,
          globalOverrides.network?.deniedDomains,
          projectOverrides.network?.deniedDomains,
        ) ?? [],
      allowUnixSockets: mergeConfiguredArray(
        defaults.network?.allowUnixSockets,
        globalOverrides.network?.allowUnixSockets,
        projectOverrides.network?.allowUnixSockets,
      ),
      allowMachLookup: mergeConfiguredArray(
        defaults.network?.allowMachLookup,
        globalOverrides.network?.allowMachLookup,
        projectOverrides.network?.allowMachLookup,
      ),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead:
        mergeConfiguredArray(
          defaults.filesystem?.denyRead,
          globalOverrides.filesystem?.denyRead,
          projectOverrides.filesystem?.denyRead,
        ) ?? [],
      allowRead: mergeConfiguredArray(
        defaults.filesystem?.allowRead,
        globalOverrides.filesystem?.allowRead,
        projectOverrides.filesystem?.allowRead,
      ),
      allowWrite:
        mergeConfiguredArray(
          defaults.filesystem?.allowWrite,
          globalOverrides.filesystem?.allowWrite,
          projectOverrides.filesystem?.allowWrite,
        ) ?? [],
      denyWrite:
        mergeConfiguredArray(
          defaults.filesystem?.denyWrite,
          globalOverrides.filesystem?.denyWrite,
          projectOverrides.filesystem?.denyWrite,
        ) ?? [],
    },
  };
}

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

function readJsonConfig(configPath: string, warn: boolean): SandboxConfigFile {
  return readJsonConfigResult(configPath, warn).config;
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

export function loadConfig(cwd: string, options: SandboxConfigLoadOptions = {}): SandboxConfig {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const globalRead = readJsonConfigResult(globalPath, true);
  const projectRead = readJsonConfigResult(projectPath, true);
  const profileName = options.profileName ?? process.env[SANDBOX_PROFILE_ENV];
  if (profileName === undefined)
    return mergeConfigLayers(DEFAULT_CONFIG, globalRead.config, projectRead.config);

  validateSandboxProfileName(profileName);
  if (globalRead.error) {
    throw new Error(
      `Cannot load sandbox profile '${profileName}' because global configuration '${globalPath}' is invalid: ${globalRead.error.message}`,
    );
  }
  const projectTrusted = options.projectTrusted === true;
  if (projectTrusted && projectRead.config.profiles !== undefined) {
    throw new Error(
      `Project sandbox configuration '${projectPath}' must not define profiles; profiles are available only from '${globalPath}'.`,
    );
  }
  if (projectTrusted && projectRead.error) {
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
      projectTrusted,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot load sandbox profile '${profileName}' from '${globalPath}': ${message}`,
    );
  }
}

function writeConfigFile(configPath: string, config: SandboxConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addDomainToConfig(configPath: string, domain: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.network?.allowedDomains) ?? [];
  if (existing.includes(domain)) return;

  config.network = {
    ...config.network,
    allowedDomains: [...existing, domain],
  };
  writeConfigFile(configPath, config);
}

export function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowRead) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowRead: [...existing, pathToAdd],
  };
  writeConfigFile(configPath, config);
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowWrite) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowWrite: [...existing, pathToAdd],
  };
  writeConfigFile(configPath, config);
}
