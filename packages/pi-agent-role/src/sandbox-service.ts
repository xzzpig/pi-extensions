/**
 * Module specifier kept as a plain string: pi-sandbox is an optional dependency,
 * so TypeScript must not resolve (and type-check) its sources from this
 * package's compiler options.
 */
const SANDBOX_MODULE: string = "@xzzpig/pi-sandbox";

/** The subset of pi-sandbox's SandboxService this package uses. */
export interface SandboxServiceLike {
  setProfile(
    profileName: string | undefined,
  ): Promise<{ ok: boolean; message?: string }>;
  listProfiles?(): string[];
}

/**
 * Resolve the sandbox service published by this session.
 *
 * The dynamic import is the I/O boundary: a missing or incompatible module means
 * "sandbox controls unavailable", never a crash. Callers must treat undefined as
 * "cannot apply a sandbox profile here" and say so rather than assuming success.
 */
export async function loadSandboxService(
  sessionId: string | undefined,
): Promise<SandboxServiceLike | undefined> {
  let loaded: unknown;
  try {
    loaded = await import(SANDBOX_MODULE);
  } catch {
    return undefined;
  }
  const candidate = loaded as {
    getSandboxService?: (sessionId?: string) => unknown;
  } | null;
  const getService = candidate?.getSandboxService;
  if (typeof getService !== "function") return undefined;
  const service = getService(sessionId) as
    | SandboxServiceLike
    | undefined
    | null;
  if (!service || typeof service.setProfile !== "function") return undefined;
  return service;
}
