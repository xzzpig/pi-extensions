import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { folded, TurnStore, TURN_ENTRY, turnOptions, turnStore } from "./turn-state.ts";

export function connectTurns(pi: ExtensionAPI): void {
  const restore = (ctx: ExtensionContext) => {
    const store = new TurnStore();
    store.restore(ctx.sessionManager.getBranch());
    turnStore.set(store);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", () => { turnStore.get().begin(); });
  pi.on("agent_start", () => { turnStore.get().begin(); });
  pi.on("before_provider_request", () => { turnStore.get().requestStart(); });
  pi.on("message_start", ({ message }) => { turnStore.get().note(message); });
  pi.on("message_update", ({ message }) => { turnStore.get().note(message); });
  pi.on("message_end", ({ message }) => { turnStore.get().note(message, true); });
  pi.on("tool_execution_start", (event) => {
    turnStore.get().toolStart(event.toolCallId, event.parentToolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    turnStore.get().toolEnd(event.toolCallId, event.parentToolCallId);
  });
  pi.on("agent_before_settle", (event) => { turnStore.get().settlementOutcome = event.outcome; });
  pi.on("agent_settled", (event) => {
    const saved = turnStore.get().settle(event.aborted);
    if (saved?.keys.length) pi.appendEntry(TURN_ENTRY, saved);
  });
  pi.registerCommand("tidy", {
    description: "Toggle a turn's process: /tidy turn [number|last]",
    handler: async (args, ctx) => {
      const [action, target = "last"] = args.trim().split(/\s+/);
      const turns = [...new Set(turnStore.get().byMessage.values())];
      const index = target === "last" ? turns.length - 1 : Number(target) - 1;
      const turn = turns[index];
      if (action !== "turn" || !Number.isInteger(index) || !turn || turnOptions.get().collapseTurns === "off") {
        ctx.ui.notify("Usage: /tidy turn [number|last] (requires tidy.collapseTurns)", "warning");
        return;
      }
      turn.open = folded(turn);
    },
  });
}
