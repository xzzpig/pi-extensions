import { minimatch } from "minimatch";
import type { ContextCapConfig } from "./config.js";

/**
 * Model whitelist matching for pi-context-cap.
 *
 * Patterns follow pi's `scopedModels` / `enabledModels` convention
 * (model-resolver): minimatch against `provider/modelId` (e.g.
 * "openai-codex/*") or a bare `modelId` (e.g. "claude-*"), case-insensitively.
 * Note `*` does not cross `/`: use `**` for hierarchical ids such as
 * "new-api/Vendor/Model" from proxy providers. An absent or empty `models`
 * list matches every model.
 */

const MATCH_OPTS = { nocase: true } as const;

export function isModelAllowed(
  provider: string | undefined,
  modelId: string | undefined,
  config: ContextCapConfig,
): boolean {
  const patterns = config.models;
  if (!patterns || patterns.length === 0) return true;

  const qualified = provider && modelId ? `${provider}/${modelId}` : "";
  for (const pattern of patterns) {
    if (qualified && minimatch(qualified, pattern, MATCH_OPTS)) return true;
    if (modelId && minimatch(modelId, pattern, MATCH_OPTS)) return true;
  }
  return false;
}

/** Collect patterns with invalid glob syntax so they can be surfaced. */
export function invalidPatterns(config: ContextCapConfig): string[] {
  const patterns = config.models ?? [];
  return patterns.filter((p) => {
    try {
      minimatch("", p, MATCH_OPTS);
      return false;
    } catch {
      return true;
    }
  });
}
