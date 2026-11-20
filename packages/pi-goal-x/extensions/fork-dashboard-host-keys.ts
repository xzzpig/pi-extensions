import { getKeybindings, type KeyId, type TUI } from "@earendil-works/pi-tui";

// TuiAltScreen registers its viewport listener before extension listeners.
// Keep the consuming action IDs, not their defaults: Pi owns remaps/disables.
const viewportActions = [
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
] as const;
const searchActions = [
  "tui.altScreen.searchNext",
  "tui.altScreen.searchPrevious",
  "tui.altScreen.searchClose",
] as const;

/** Keep footer hints and extension input behind the same focus gate. */
export function dashboardKeyboardAvailable(
  tui: TUI | null | undefined,
  mainEditorFocused: boolean | undefined,
  promptOwnsInput: boolean,
): boolean {
  return !promptOwnsInput && (mainEditorFocused ?? !tui?.hasOverlay?.());
}

export function fullscreenDashboardReservedKeys(tui: TUI | undefined): KeyId[] {
  if (tui?.mode !== "fullscreen") return [];
  // SAFETY: read-only inspection. Pi 1.4 and 1.5 use different optional
  // names for viewport deferral; do not invoke the input dispatcher itself.
  const host = tui as TUI & {
    shouldDeferViewportInput?: () => boolean;
    shouldDeferViewportInputToOverlay?: () => boolean;
    activeSearch?: { overlay?: { isFocused(): boolean } };
  };
  const defer =
    (
      host.shouldDeferViewportInput ?? host.shouldDeferViewportInputToOverlay
    )?.call(host) === true;
  const searchFocused = host.activeSearch?.overlay?.isFocused() === true;
  const actions = [
    "tui.altScreen.search",
    ...(searchFocused ? searchActions : []),
    ...(defer ? [] : viewportActions),
  ] as const;
  try {
    const keybindings = getKeybindings();
    return actions.flatMap((action) => keybindings.getKeys(action));
  } catch {
    // An embedding without a Pi keymap cannot resolve viewport bindings.
    return [];
  }
}
