import type {
  ExtensionContext,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/** Retain upstream's optional Pi 1.4 registry wrapper lookup without widening the host API. */
export function auditorSessionRuntimeOptions(ctx: ExtensionContext): {
  modelRuntime?: ModelRuntime;
} {
  // SAFETY: Pi 1.4's Extension ModelRegistry wraps the live ModelRuntime at
  // runtime; SDK versions do not uniformly declare that property. Optional
  // access preserves the original undefined fallback and does not mutate it.
  const registry = ctx.modelRegistry as unknown as
    | { runtime?: ModelRuntime }
    | undefined;
  return { modelRuntime: registry?.runtime };
}
