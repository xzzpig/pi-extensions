import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Preserve the session signal while also honouring an individual tool's cancellation. */
export function withToolAbortSignal<T extends ExtensionContext>(ctx: T, signal?: AbortSignal): T {
  if (!signal) return ctx;
  const sessionSignal = ctx.signal;
  if (signal === sessionSignal) return ctx;
  const combined = sessionSignal ? AbortSignal.any([sessionSignal, signal]) : signal;
  return Object.create(ctx, {
    signal: { value: combined, enumerable: true },
  }) as T;
}
