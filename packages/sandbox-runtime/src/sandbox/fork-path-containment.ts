// [fork] Root-aware path containment for the deny/allow seams.
//
// The recorded upstream (carderne/sandbox-runtime v0.0.79/v0.0.80) still spells
// containment as `target.startsWith(allowed + '/')`, which builds '//' when the
// allowed path is the filesystem root: no absolute path starts with '//', so a
// denyWrite path under an allowWrite of '/' was judged outside the write
// allowlist and silently lost its --ro-bind mask (the writable root bind stays).
// Anthropic's @anthropic-ai/sandbox-runtime fixed exactly this with isAtOrUnder
// (Linux seams in 0.0.77, the macOS read-rule re-emit in 0.0.80).
//
// Keep the body byte-identical to upstream so the sync that brings it in
// merges cleanly; the removal condition is recorded in
// subtrees/sandbox-runtime.json `reapplyOnSync`.
export function isAtOrUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir === '/' ? '/' : dir + '/')
}
