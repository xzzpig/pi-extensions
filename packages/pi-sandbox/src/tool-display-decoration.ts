/**
 * Optional integration with pi-tool-display.
 *
 * This module MUST NOT create a hard dependency on pi-tool-display: the
 * consumer package is imported dynamically at runtime, and every failure path
 * degrades to pi's built-in default bash rendering.
 */

export interface ToolDisplayAdapterLike {
  kind?: string;
  overrideExistingRenderers?: boolean;
}

export interface ToolDisplayDecorator {
  (tool: unknown, adapter?: ToolDisplayAdapterLike): unknown;
}

const TOOL_DISPLAY_CONSUMER_SPECIFIERS = [
  "@xzzpig/pi-tool-display/tool-display-api-consumer",
  "pi-tool-display/tool-display-api-consumer",
] as const;

/**
 * Resolve pi-tool-display's consumer helper without a static import.
 * Returns undefined when the package is not installed (or cannot provide the
 * helper), so callers keep pi's built-in default rendering.
 */
export async function loadToolDisplayDecorator(): Promise<ToolDisplayDecorator | undefined> {
  for (const specifier of TOOL_DISPLAY_CONSUMER_SPECIFIERS) {
    try {
      const mod = await import(specifier);
      if (typeof mod?.decorateToolForDisplay === "function") {
        return mod.decorateToolForDisplay as ToolDisplayDecorator;
      }
    } catch {
      // Try the next candidate specifier; if all fail, fall back to defaults.
    }
  }
  return undefined;
}

/**
 * Apply pi-tool-display's bash renderers to a registered bash tool in place.
 * Only the renderers (renderCall/renderResult) are replaced; execution and
 * permission logic owned by pi-sandbox are never touched. Returns true when
 * decoration was applied without throwing.
 */
export function applyToolDisplayBashDecoration(
  tool: unknown,
  decorateToolForDisplay: ToolDisplayDecorator,
): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  try {
    const decorated = decorateToolForDisplay(tool, {
      kind: "bash",
      overrideExistingRenderers: true,
    });
    if (decorated && typeof decorated === "object" && decorated !== tool) {
      Object.assign(tool, decorated);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget optional decoration. Never throws and never blocks the
 * extension load: when pi-tool-display is unavailable, the tool keeps pi's
 * built-in default rendering. When pi-tool-display loads later, its pending
 * decoration queue applies the renderers at that point.
 */
export function maybeDecorateBashForToolDisplay(tool: unknown): Promise<void> {
  return loadToolDisplayDecorator()
    .then((decorator) => {
      if (decorator) {
        applyToolDisplayBashDecoration(tool, decorator);
      }
    })
    .catch(() => {
      // pi-tool-display unavailable: keep built-in default rendering.
    });
}
