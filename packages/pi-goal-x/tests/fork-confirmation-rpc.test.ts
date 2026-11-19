import assert from "node:assert/strict";
import test from "node:test";
import { showCreateProposalDialog } from "../extensions/goal-tweak-confirmation.ts";
import { createMockExtensionContext } from "./tui-test-utils.ts";

test("RPC hosts without a usable custom TUI do not approve the draft", async () => {
  for (const behavior of ["undefined", "throw"] as const) {
    const ctx = createMockExtensionContext();
    (ctx as unknown as { mode: string }).mode = "rpc";
    (ctx.ui as unknown as { custom: () => Promise<undefined> }).custom =
      async () => {
        if (behavior === "throw") throw new Error("custom unsupported");
        return undefined;
      };
    assert.equal(
      await showCreateProposalDialog(ctx, "proposal", "title", true),
      undefined,
    );
  }
});
