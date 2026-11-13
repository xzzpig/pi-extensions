/**
 * Options the prototype patches read at call time.
 *
 * pi's components are one shared module, so each prototype is patched once per
 * process. `/reload` re-runs the extension in a fresh module, though, and a
 * patch that captured its options in a closure would keep the old ones — the
 * "already patched" guard would drop the new settings on the floor. Keeping the
 * options in a global slot lets a reload reach the patches already installed.
 */

export interface LiveSlot<T> {
  get(): T;
  set(value: T): void;
}

/** The slot that holds the revision counter itself; writing it must not bump it. */
const REVISION = "options-revision";
let revision: LiveSlot<number> | undefined;

/**
 * A number that changes whenever a slot is written.
 *
 * The render caches hold what a box drew between frames. Keying them off the
 * options they read means naming every option in every cache, and one missed
 * name leaves the old frame on screen after a `/reload` with new settings — the
 * bug class that made 0.9.4's split diff ignore a theme switch. A frame either
 * sees the same revision it cached under, or it sees every new option at once.
 *
 * Reloading and re-patching are the only things that write a slot, so this bumps
 * a handful of times per session, not per frame.
 */
export const optionsRevision = (): number => (revision ??= liveSlot<number>(REVISION, 0)).get();

function bumpRevision(): void {
  revision ??= liveSlot<number>(REVISION, 0);
  revision.set(revision.get() + 1);
}

export function liveSlot<T>(name: string, initial: T): LiveSlot<T> {
  // Still `pi-toolbox:`, on purpose: with the old package and pi-tidy both
  // installed, they share one set of patches instead of framing twice.
  const key = Symbol.for(`pi-toolbox:${name}`);
  const store = globalThis as unknown as Record<symbol, LiveBox<T> | T | undefined>;
  // The value lives in a box that every module instance shares, rather than
  // directly in the global slot. `get` runs several times per rendered row, and
  // reading a field off one small object is cheaper than a `globalThis[symbol]`
  // lookup; a `/reload` still reaches patches left behind by the previous
  // module, because it swaps the value inside the shared box.
  const existing = store[key];
  const box: LiveBox<T> = isLiveBox<T>(existing) ? existing : { value: existing === undefined ? initial : (existing as T) };
  store[key] = box;
  return {
    get: () => box.value,
    set: (value) => {
      box.value = value;
      // An older build sharing the symbol writes a bare value back into the
      // slot; putting the box back keeps the two on the same object.
      if (store[key] !== box) store[key] = box;
      if (name !== REVISION) bumpRevision();
    },
  };
}

interface LiveBox<T> {
  value: T;
}

/** An older build may have left a bare value in the slot; adopt it as the box. */
function isLiveBox<T>(value: unknown): value is LiveBox<T> {
  return typeof value === "object" && value !== null && "value" in value;
}

/** `tidy.enabled`: false turns every installed patch into a pass-through. */
export const tidyEnabled = liveSlot("enabled", true);

/**
 * An agent run is in flight: `agent_start` … `agent_end`/`agent_settled`. This
 * is the only signal about pi's work that cannot go stale, so the thinking rows
 * use it to stop animating the moment the run is over.
 *
 * A slot rather than a module variable: `/reload` builds a new module while the
 * patches from the old one keep rendering, and both have to see the same value.
 */
export const agentRunning = liveSlot("agent-running", false);

/**
 * `tidy.groupOpen`: whether a new tool group is born open. A slot for the same
 * reason: `/reload` pushes the setting from a fresh module instance, while the
 * render patch installed by the previous one is what asks for new groups.
 */
export const groupOpen = liveSlot("group-open", false);
