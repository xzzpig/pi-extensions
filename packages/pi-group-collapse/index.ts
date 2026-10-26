import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GroupCollapseRuntime } from "./src/runtime.ts";

/**
 * pi-group-collapse entry point.
 *
 * Wires the process-wide runtime into Pi's extension events. Safe to call
 * on every session factory run: the runtime survives session replacement,
 * reloads re-load the config snapshot and rebuild the current branch, and
 * every installation goes through the recoverable patch registry.
 *
 * Non-TUI modes install no display behavior: RPC/JSON/print keep their
 * transcripts exactly as the host renders them, and the command answers
 * with a notice instead of acting on a view that does not exist.
 *
 * The runtime itself never sees a ctx, so its deduplicated notices queue
 * here and flush through the next event's `ctx.ui.notify`.
 */

const RUNTIME_KEY = Symbol.for("pi-group-collapse.runtime.v1");

export function getGroupCollapseRuntime(
  notify: (message: string, level: "info" | "warning" | "error") => void,
): GroupCollapseRuntime {
  // SAFETY: only our Symbol.for slot is read, then checked with instanceof.
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[RUNTIME_KEY];
  if (existing instanceof GroupCollapseRuntime) {
    // /new recreates the extension factory without reloading this module.
    // Its queue is new even though the process runtime is still the same.
    existing.setNotifications({ notify });
    return existing;
  }
  const runtime = new GroupCollapseRuntime({ notify });
  Object.defineProperty(globalThis, RUNTIME_KEY, {
    value: runtime,
    configurable: true,
  });
  return runtime;
}

type Notice = { message: string; level: "info" | "warning" | "error" };

export default function extension(pi: ExtensionAPI): void {
  const queue: Notice[] = [];
  const runtime = getGroupCollapseRuntime((message, level) => {
    // The runtime owns session-scoped deduplication. A process-wide text
    // set would suppress the same genuine degradation in later sessions.
    queue.push({ message, level });
  });

  const flush = (
    notify: ((message: string, level: Notice["level"]) => void) | undefined,
  ) => {
    if (!notify) return;
    while (queue.length > 0) {
      const notice = queue.shift()!;
      notify(notice.message, notice.level);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    runtime.onSessionStart({
      mode: ctx.mode,
      cwd: ctx.cwd,
      // Compaction-aware: the transcript renders this projection, so the
      // model must replay exactly these entries.
      getBranch: () =>
        // SAFETY: the adapter validates entry kinds and reads only known fields.
        (ctx.sessionManager.buildContextEntries() ??
          ctx.sessionManager.getBranch() ??
          []) as unknown as never,
    });
    flush(ctx.ui.notify.bind(ctx.ui));
  });

  // Tree navigation and compaction rebuild the visible transcript from a
  // different branch projection: the view replays under a fresh epoch
  // instead of accumulating state from the replaced one.
  pi.on("session_tree", (_event, ctx) => {
    runtime.rebuildCurrentView(
      () =>
        // SAFETY: the adapter validates entry kinds and reads only known fields.
        (ctx.sessionManager.buildContextEntries() ??
          ctx.sessionManager.getBranch() ??
          []) as unknown as never,
    );
    flush(ctx.ui.notify.bind(ctx.ui));
  });
  pi.on("session_compact", (event, ctx) => {
    if (event.willRetry) return; // overflow recovery: the turn continues
    runtime.rebuildCurrentView(
      () =>
        // SAFETY: the adapter validates entry kinds and reads only known fields.
        (ctx.sessionManager.buildContextEntries() ??
          ctx.sessionManager.getBranch() ??
          []) as unknown as never,
    );
    flush(ctx.ui.notify.bind(ctx.ui));
  });

  pi.on("tool_execution_update", (event, ctx) => {
    // SAFETY: this built-in event is read by type and known fields only.
    runtime.handlePiEvent(event as unknown as never);
    flush(ctx.ui.notify.bind(ctx.ui));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    // SAFETY: this built-in event is read by type and known fields only.
    runtime.handlePiEvent(event as unknown as never);
    flush(ctx.ui.notify.bind(ctx.ui));
  });

  pi.on("agent_start", (event, ctx) => {
    // SAFETY: this built-in event is read by type and known fields only.
    runtime.handlePiEvent(event as unknown as never);
    flush(ctx.ui.notify.bind(ctx.ui));
  });
  pi.on("agent_end", (event, ctx) => {
    // SAFETY: this built-in event is read by type and known fields only.
    runtime.handlePiEvent(event as unknown as never);
    flush(ctx.ui.notify.bind(ctx.ui));
  });
  pi.on("agent_before_settle", (event, ctx) => {
    // SAFETY: this built-in event is read by type and known fields only.
    runtime.handlePiEvent(event as unknown as never);
    flush(ctx.ui.notify.bind(ctx.ui));
  });
  pi.on("agent_settled", (event, ctx) => {
    // SAFETY: this built-in event is read by type and known fields only.
    runtime.handlePiEvent(event as unknown as never);
    flush(ctx.ui.notify.bind(ctx.ui));
  });

  pi.on("session_shutdown", () => {
    runtime.onSessionShutdown();
  });

  pi.registerCommand("group-collapse", {
    description:
      "expand|collapse — restore or fold settled groups without the mouse",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !runtime.isDisplayInstalled()) {
        ctx.ui.notify(
          "group-collapse: no interactive transcript in this mode",
          "info",
        );
        return;
      }
      const action = args.trim();
      if (action === "expand") {
        const opened = runtime.expandAll();
        ctx.ui.notify(
          opened > 0
            ? `group-collapse: expanded ${opened} group(s)`
            : "group-collapse: nothing folded to expand",
          "info",
        );
        return;
      }
      if (action === "collapse") {
        const closed = runtime.collapseAll();
        ctx.ui.notify(
          closed > 0
            ? `group-collapse: folded ${closed} group(s)`
            : "group-collapse: nothing to fold",
          "info",
        );
        return;
      }
      ctx.ui.notify("group-collapse: expected expand or collapse", "warning");
    },
  });
}
