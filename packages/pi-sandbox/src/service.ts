import { listGlobalSandboxProfiles } from "./config.ts";

/**
 * Outcome of selecting or clearing the session sandbox profile.
 *
 * `ok: false` means nothing changed: the request was rejected and the previous
 * selection still stands. `ok: true` with a message means the selection was
 * recorded but isolation is not active (the sandbox is disabled), so callers
 * must surface the warning instead of reporting success silently.
 */
export interface SandboxProfileSelectionResult {
  ok: boolean;
  message?: string;
}

/**
 * Session-scoped sandbox controls for in-process extensions.
 *
 * pi-sandbox owns the OS-level policy; another extension (for example a session
 * role picker) can only ask it to select a profile by name. Raw sandbox
 * configuration is never exchanged: a profile is a global operator-defined name,
 * and the runtime resolves it exactly as it resolves a child launch.
 */
export interface SandboxService {
  /**
   * Select or clear the session sandbox profile.
   *
   * The profile name is validated against the shared grammar and the global
   * registry before any state changes. When the sandbox is currently disabled
   * the selection is still recorded — the sandbox switch is user-controlled and
   * is never forced on — and the result carries a warning message.
   */
  setProfile(profileName: string | undefined): Promise<SandboxProfileSelectionResult>;
  /** Currently selected profile name, if any. */
  getProfile(): string | undefined;
  /** Profile names the global configuration defines (never project-defined). */
  listProfiles(): string[];
}

const SERVICE_REGISTRY_KEY = Symbol.for("@xzzpig/pi-sandbox/session-services");

type SandboxServiceRegistry = Map<string, SandboxService>;

/**
 * The registry lives on globalThis keyed by a Symbol.for so two copies of this
 * module (a host and an in-process child, or a duplicated install) still share
 * one table instead of each publishing an unreachable service.
 */
function serviceRegistry(): SandboxServiceRegistry {
  const scope = globalThis as typeof globalThis &
    Record<symbol, SandboxServiceRegistry | undefined>;
  const existing = scope[SERVICE_REGISTRY_KEY];
  if (existing !== undefined) return existing;
  const created: SandboxServiceRegistry = new Map();
  scope[SERVICE_REGISTRY_KEY] = created;
  return created;
}

/**
 * Look up the sandbox service published by the session that serves this call.
 *
 * Pass the id of the session whose policy you mean (`ctx.sessionManager.getSessionId()`).
 * Omitting it resolves only when exactly one session published a service, which
 * keeps the convenience path unambiguous instead of guessing between sessions.
 * Returns undefined when pi-sandbox is not loaded or has not reached
 * session_start yet; callers must treat that as "sandbox controls unavailable".
 */
export function getSandboxService(sessionId?: string): SandboxService | undefined {
  const registry = serviceRegistry();
  if (sessionId !== undefined) return registry.get(sessionId);
  if (registry.size !== 1) return undefined;
  return registry.values().next().value;
}

/**
 * Publish this session's sandbox service. Returns a disposer that removes it
 * again; pi-sandbox calls it on session_shutdown so a later session cannot
 * observe a stale selection.
 */
export function registerSandboxService(sessionId: string, service: SandboxService): () => void {
  const registry = serviceRegistry();
  registry.set(sessionId, service);
  return () => {
    if (registry.get(sessionId) === service) registry.delete(sessionId);
  };
}

export { listGlobalSandboxProfiles };
