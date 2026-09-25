/**
 * Restoring Pi's own gesture state after a handler consumes a release.
 *
 * The click protocol this extension serves deliberately never consumes the
 * press: Pi's selection machinery anchors on it, so a drag that starts on a
 * togglable row still selects. That means the press reaches Pi's built-ins,
 * and they arm their gesture and selection state there — `mousePressTarget` /
 * `mousePressPoint` / `mousePressMoved` for the component path, and
 * `selectionPressActive` / `selectionAnchor` / `pressedUrl` for the selection
 * path.
 *
 * The *release* is where Pi clears that state. When a handler consumes the
 * release, Pi's release branch never runs, so the armed state outlives the
 * gesture: a stale `mousePressPoint` makes the next motion report look like a
 * drag, and a stale `selectionAnchor` keeps a selection the user never made.
 *
 * Pi's own reset methods are the maintainable path (they also stop the
 * selection auto-scroll timer, which a field write cannot), with a direct
 * field reset as the backstop for a build where a method has moved or been
 * renamed. Every step is best-effort: a renderer that refuses one reset must
 * not take the input path down with it.
 */

/** The reset methods Pi exposes (pi-tui >= 0.85). */
export interface GestureResetTarget {
  clearComponentMouseGesture?(): void;
  clearTextSelection?(): void;
}

function attempt(action: () => void): void {
  try {
    action();
  } catch {
    // Best-effort: the built-in path stays intact either way.
  }
}

/**
 * Put the renderer back into "no gesture in progress" after this extension
 * consumed a release whose press went to the built-ins.
 */
export function restoreCoreGesture(receiver: GestureResetTarget): void {
  // SAFETY: the caller is the `handleViewportInput` wrapper, whose `this` is
  // a live `TuiAltScreen`; the fields written below are that class's own
  // runtime state (compiled from TS-privates, so they exist on the instance),
  // and writing an absent one is a harmless no-op.
  const fields = receiver as unknown as Record<string, unknown>;
  attempt(() => receiver.clearComponentMouseGesture?.call(receiver));
  attempt(() => receiver.clearTextSelection?.call(receiver));

  // Backstop for a pi-tui that renamed or dropped either method. These are
  // the fields both resets write, so repeating them is idempotent when the
  // methods did run.
  attempt(() => {
    fields.mouseCapture = undefined;
    fields.mousePressTarget = undefined;
    fields.mousePressPoint = undefined;
    fields.mousePressMoved = false;
    fields.selectionPressActive = false;
    fields.selectionAnchor = undefined;
    fields.selectionFocus = undefined;
    fields.selectionDragged = false;
    fields.pressedUrl = undefined;
  });
}
