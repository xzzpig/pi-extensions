/**
 * Small shared helpers for the `/opsx:*` command layer (openspec change
 * add-pi-openspec-x): the per-session key and the best-effort notice.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** The per-session key used by all flows (session id, or "unknown"). */
export function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId() ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** A best-effort follow-up notice; a delivery failure never breaks the flow. */
export function sendNotice(
  pi: Pick<ExtensionAPI, "sendMessage">,
  customType: string,
  content: string,
): void {
  try {
    pi.sendMessage(
      { customType, content, display: true },
      { deliverAs: "followUp" },
    );
  } catch {
    // Best-effort.
  }
}
