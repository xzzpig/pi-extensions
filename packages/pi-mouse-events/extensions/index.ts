/**
 * `pi-mouse-events` extension entry.
 *
 * Installs the mouse dispatch on `TuiAltScreen.prototype` once per process
 * and publishes the `MouseEventsApi` under `globalThis`. The prototype and
 * the published API outlive sessions; the one session-scoped surface — the
 * event-bus handle — is refreshed on every run of this factory, because pi
 * re-runs extension factories on every session replacement (`/new`, fork,
 * switch, reload) and invalidates the session that produced the previous
 * `pi`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { getMouseEventsApi } from "../api.ts";
import { createMouseEventsApi, publishApi } from "./api-registry.ts";
import { installMousePatches } from "./patch.ts";

let installAttempted = false;

export default function extension(pi: ExtensionAPI): void {
  // A copy of this extension (or an earlier load of this one) already
  // published the API — never install twice, or the prototype would be
  // wrapped twice and events emitted twice. This run is still handed to the
  // published patches: pi invalidates the session runtime that produced the
  // previous `pi`, so the bus handle must move to this session's before any
  // mouse event can be emitted on it.
  const published = getMouseEventsApi();
  if (published) {
    published.refreshBus?.(pi);
    return;
  }
  if (installAttempted) return;
  installAttempted = true;

  // `TuiAltScreen` only ships with pi-tui >= 0.84.0, which the peer range
  // already guarantees. The guard is for environments that bypass peer
  // resolution: under jiti a missing export arrives as undefined rather than
  // failing the import, so a readable hint beats a TypeError.
  if (!TuiAltScreen) {
    console.warn(
      "[pi-mouse-events] @earendil-works/pi-tui does not export TuiAltScreen " +
        "(pi-tui < 0.84?); mouse event dispatch is unavailable.",
    );
    return;
  }

  const patches = installMousePatches(pi, TuiAltScreen.prototype);
  if (!patches) return;
  publishApi(createMouseEventsApi(patches));
}
