// [fork] network.disabled support helpers.
//
// Precedence mirrors the filesystem.disabled handling in sandbox-manager: when
// a caller passes a per-call network override block at all, its `disabled`
// (defaulting to false) wins outright; a global disabled=true must not leak
// through an overriding block that omits the key.
export function isNetworkDisabled(
  customNetwork: { disabled?: boolean } | undefined,
  globalNetwork: { disabled?: boolean } | undefined,
): boolean {
  return customNetwork !== undefined
    ? (customNetwork.disabled ?? false)
    : (globalNetwork?.disabled ?? false)
}
