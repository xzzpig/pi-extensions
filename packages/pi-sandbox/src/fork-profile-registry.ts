/**
 * [fork] Session-lifetime in-memory sandbox profile registry.
 *
 * Upstream resolves profiles only from the user's sandbox.json registries; this
 * module lets an in-process extension (for example pi-openspec-x) contribute
 * profile definitions at runtime through {@link registerSandboxProfiles}. The
 * registry lives in process memory on globalThis keyed by a Symbol.for — the
 * same pattern as the session service registry — so a host and an in-process
 * child, or a duplicated install, still share one table. Nothing here touches
 * disk: registering never writes sandbox.json, and an entry dies with the
 * process.
 *
 * Semantics (pinned by test/fork-profile-registry.test.ts):
 *
 * - Registration validates every definition with the same validator a
 *   sandbox.json profile goes through, and every name with the shared selector
 *   grammar. A single invalid entry rejects the whole call atomically —
 *   nothing is committed — so a bad registration can never leave a
 *   partially visible set.
 * - Registering an already-registered name replaces the previous definition
 *   (latter wins). Extensions that initialize once per session can therefore
 *   re-register their definitions idempotently; a conflicting re-registration
 *   is the last caller's statement.
 * - Resolution order is user configuration > runtime registry: a name defined
 *   in the global or trusted project sandbox.json always resolves from there,
 *   and the registry only fills names no user configuration defines. An
 *   operator can thus pin or refine any registered name in sandbox.json.
 */
import type { SandboxProfileConfig } from "./config.ts";

import { validateProfileConfig, validateSandboxProfileName } from "./profile-config.ts";

/** A runtime-registered profile definition; same shape as a sandbox.json profile. */
export type SandboxProfileDefinition = SandboxProfileConfig;

const PROFILE_REGISTRY_KEY = Symbol.for("@xzzpig/pi-sandbox/session-profile-registry");

type SandboxProfileRegistry = Map<string, SandboxProfileConfig>;

function profileRegistry(): SandboxProfileRegistry {
  const scope = globalThis as typeof globalThis &
    Record<symbol, SandboxProfileRegistry | undefined>;
  const existing = scope[PROFILE_REGISTRY_KEY];
  if (existing !== undefined) return existing;
  const created: SandboxProfileRegistry = new Map();
  scope[PROFILE_REGISTRY_KEY] = created;
  return created;
}

/**
 * Register runtime profile definitions. Throws on the first invalid name or
 * definition and leaves the registry untouched (atomic commit).
 */
export function registerSandboxProfiles(profiles: Record<string, SandboxProfileDefinition>): void {
  const validated: Array<[string, SandboxProfileConfig]> = [];
  for (const [name, definition] of Object.entries(profiles)) {
    validateSandboxProfileName(name, "registered sandbox profile");
    validated.push([name, validateProfileConfig(definition, name)]);
  }
  const registry = profileRegistry();
  for (const [name, profile] of validated) registry.set(name, profile);
}

/** The registered definition for a name, or undefined when not registered. */
export function lookupRegisteredSandboxProfile(
  profileName: string,
): SandboxProfileConfig | undefined {
  return profileRegistry().get(profileName);
}

/** A shallow copy of the registry, for listing and diagnostics. */
export function registeredSandboxProfilesSnapshot(): Record<string, SandboxProfileConfig> {
  return Object.fromEntries(profileRegistry());
}
