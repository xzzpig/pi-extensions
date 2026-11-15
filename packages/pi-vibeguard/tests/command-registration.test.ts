/**
 * Fork-only: each `/vibeguard:*` command must be registered exactly once.
 *
 * Why this file exists: the command family moved from `index.ts` into
 * `fork-commands.ts`, and a leftover registration in the (upstream) factory
 * would not fail any behavioural test — the mock API stores commands in a
 * `Map`, so a duplicate silently overwrote the first entry. This test counts
 * registrations instead of storing them, so a second owner for the same name
 * fails loudly.
 */

import * as os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import vibeguardExtension from "../index.ts";

vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<any>();
  const homedir = () => "/nonexistent-vg-fake-home";
  return { ...actual, homedir, default: { ...actual.default, homedir } };
});

interface RegisteredCommand {
  name: string;
  description?: string;
}

function countRegistrations() {
  const registered: RegisteredCommand[] = [];
  const api = {
    on: () => {},
    registerCommand: (name: string, options: { description?: string }) => {
      registered.push({ name, description: options?.description });
    },
    registerTool: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  vibeguardExtension(api);
  return registered;
}

describe("/vibeguard:* command registration", () => {
  beforeEach(() => {
    // Fresh module state per test: the extension factory is re-invoked above.
    vi.restoreAllMocks();
    void os.homedir();
  });

  it("registers every fork command exactly once", () => {
    const registered = countRegistrations();
    const counts = new Map<string, number>();
    for (const command of registered) {
      counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([
      "vibeguard:categories",
      "vibeguard:disable",
      "vibeguard:enable",
      "vibeguard:list",
      "vibeguard:stats",
      "vibeguard:status",
    ]);
    for (const [name, count] of counts) {
      expect(count, `${name} registered ${count} times`).toBe(1);
    }
  });

  it("every fork command carries a description", () => {
    for (const command of countRegistrations()) {
      expect(command.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
