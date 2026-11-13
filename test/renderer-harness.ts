/**
 * A stand-in for pi's extension host, shared by the renderer tests.
 *
 * The resolution rule is copied from pi's `ExtensionRunner`:
 *
 *   resolvers[0](name, () => resolvers[1](name, () => … base()))
 *
 * where `base()` is the registered tool definition with pi's built-in renderers
 * filled in. `registerTool` throws on a duplicate name, exactly as pi does, so a
 * test that "loads" a sandbox extension can prove Tidy does not collide with it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";

export function harness() {
  const tools = new Map<string, ToolDefinition>();
  const resolvers: ToolRendererResolver[] = [];
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const conflicts: string[] = [];
  const commands = new Map<string, any>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      if (tools.has(tool.name)) {
        conflicts.push(tool.name);
        throw new Error(`Tool "${tool.name}" conflicts with another extension`);
      }
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerToolRenderer(resolver: ToolRendererResolver) {
      resolvers.push(resolver);
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  function resolve(name: string, base?: ToolRenderers): ToolRenderers | undefined {
    const visit = (index: number): ToolRenderers | undefined =>
      index < resolvers.length ? resolvers[index]!(name, () => visit(index + 1)) : (base ?? tools.get(name));
    return visit(0);
  }
  return { pi, tools, resolvers, handlers, conflicts, commands, entries, resolve };
}

/** Load Tidy's entry point against `pi`, with a throwaway settings.json. */
export function loadTidy(factory: (pi: ExtensionAPI) => void, pi: ExtensionAPI, config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-renderer-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ tidy: config }));
    process.env.PI_CODING_AGENT_DIR = dir;
    factory(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the `session_start` handlers and collect what they notify. */
export async function collectWarnings(handlers: Map<string, ((...args: any[]) => any)[]>): Promise<string[]> {
  const warnings: string[] = [];
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, { sessionManager: { getBranch: () => [] }, ui: { notify: (message: string) => warnings.push(message) } });
  }
  return warnings;
}
