import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import vibeguardExtension from "../index.ts";

// Isolate the global config lookup (~/.pi/agent/vibeguard.config.json) so the
// "no config anywhere" case is testable regardless of the host machine.
const FAKE_HOME = "/nonexistent-vg-fake-home";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<any>();
  const homedir = () => FAKE_HOME;
  return { ...actual, homedir, default: { ...actual.default, homedir } };
});

// ---------------------------------------------------------------------------
// Minimal ExtensionAPI mock (pi-btw runtime test style)
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const passthroughTheme = {
  fg: (_c: string, text: string) => text,
  bg: (_c: string, text: string) => text,
  bold: (text: string) => text,
};

function makeHarness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { name: string; description?: string; handler: Handler }>();
  const notifications: Array<{ message: string; level?: string }> = [];
   
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const components: any[] = [];
  const sentMessages: unknown[] = [];
  const sentUserMessages: unknown[] = [];
  const appendedEntries: unknown[] = [];

  const ui = {
    notify: (message: string, level?: string) => {
      notifications.push({ message, level });
    },
    // Capture the rendered component, then resolve immediately so the command
    // handler's await completes. Interactions continue on the captured modal.
    custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) => {
      const component = await factory({ requestRender: () => {} }, passthroughTheme, {}, () => {});
      components.push(component);
      return undefined;
    },
    setStatus: () => {},
  };

  const api = {
    on: ((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    registerCommand: ((name: string, options: { description?: string; handler: Handler }) => {
      commands.set(name, { name, ...options });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    registerTool: vi.fn(),
    sendMessage: (message: unknown) => {
      sentMessages.push(message);
    },
    sendUserMessage: (content: unknown) => {
      sentUserMessages.push(content);
    },
    appendEntry: (customType: string, data?: unknown) => {
      appendedEntries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  const dispatch = async (event: string, payload: unknown, ctx: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };

  return { api, commands, notifications, components, sentMessages, sentUserMessages, appendedEntries, ui, dispatch };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeConfigDir(config: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vg-test-"));
  await fs.writeFile(path.join(dir, "vibeguard.config.json"), JSON.stringify(config), "utf8");
  return dir;
}

const ENABLED_CONFIG = {
  enabled: true,
  patterns: { builtin: ["china_phone"] },
};

// Assembled (not a literal) so the value survives any content rewriting
// between authoring and execution.
const PHONE = "138" + "1234" + "5678";

// The regex shape is written as a bracket expression, not as a concrete
// placeholder literal, for the same reason.
const PLACEHOLDER_RE = /__VG_CHINA_PHONE_[0-9a-f]{12}__/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vibeguard extension with mapping commands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeConfigDir(ENABLED_CONFIG);
  });

  async function bootActive() {
    const harness = makeHarness();
    vibeguardExtension(harness.api);
    await harness.dispatch("session_start", {}, { cwd: dir, ui: harness.ui });
    return harness;
  }

  it("registers the two colon-namespace commands with descriptions", async () => {
    const harness = await bootActive();
    expect(harness.commands.has("vibeguard:list")).toBe(true);
    expect(harness.commands.has("vibeguard:stats")).toBe(true);
    expect(harness.commands.get("vibeguard:list")?.description).toBeTruthy();
    expect(harness.commands.get("vibeguard:stats")?.description).toBeTruthy();
  });

  it("redacts outbound messages, lists live mappings masked, reveals, and restores tool args", async () => {
    const harness = await bootActive();

    // 1. context: user message with a china phone gets redacted before the LLM sees it
    const ctxResult = (await harness.dispatch(
      "context",
      { messages: [{ role: "user", content: `call ${PHONE} now` }] },
      { ui: harness.ui },
    )) as { messages: Array<{ content: string }> };
    const redacted = ctxResult.messages[0]!.content as string;
    expect(redacted).not.toContain(PHONE);
    const placeholder = PLACEHOLDER_RE.exec(redacted)?.[0];
    expect(placeholder).toBeTruthy();

    // 2. list command: modal renders a masked table containing the placeholder
    const listCmd = harness.commands.get("vibeguard:list");
    await listCmd!.handler("", { ui: harness.ui });
    expect(harness.components).toHaveLength(1);
    const modal = harness.components[0];
    const masked = (modal.render(120) as string[]).join("\n");
    expect(masked).toContain("VibeGuard 映射");
    expect(masked).toContain(placeholder!);
    expect(masked).not.toContain(PHONE); // masked by default
    expect(masked).not.toContain("明文显示"); // masked-state title

    // 3. reveal key shows plaintext with an explicit title marker
    modal.handleInput("r");
    const revealed = (modal.render(120) as string[]).join("\n");
    expect(revealed).toContain(PHONE);
    expect(revealed).toContain("明文显示"); // plaintext warning in the title bar

    // 4. tool_call: placeholder in tool args is restored to the original value
    const holder = { toolName: "bash", input: { command: `echo ${placeholder}` } };
    await harness.dispatch("tool_call", holder, { ui: harness.ui });
    expect(holder.input.command).toContain(PHONE);
    expect(holder.input.command).not.toContain(placeholder!);

    // 5. zero context pollution: nothing was ever written to the session
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
  });

  it("stats command summarizes by category from the same live snapshot", async () => {
    const harness = await bootActive();
    await harness.dispatch("context", { messages: [{ role: "user", content: `call ${PHONE}` }] }, { ui: harness.ui });

    const statsCmd = harness.commands.get("vibeguard:stats");
    await statsCmd!.handler("", { ui: harness.ui });
    expect(harness.components).toHaveLength(1);
    const text = (harness.components[0].render(120) as string[]).join("\n");
    expect(text).toContain("VibeGuard 统计");
    expect(text).toContain("CHINA_PHONE");
    expect(text).toContain("█");
  });

  it("notifies instead of rendering when there are no live mappings", async () => {
    const harness = await bootActive();
    const listCmd = harness.commands.get("vibeguard:list");
    await listCmd!.handler("", { ui: harness.ui });
    expect(harness.components).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain("暂无存活映射");
  });

  it("drops expired mappings from the list once their TTL elapses", async () => {
    const shortTtlDir = await makeConfigDir({ ...ENABLED_CONFIG, session: { ttl: "50ms" } });
    const harness = makeHarness();
    vibeguardExtension(harness.api);
    await harness.dispatch("session_start", {}, { cwd: shortTtlDir, ui: harness.ui });

    await harness.dispatch("context", { messages: [{ role: "user", content: `call ${PHONE}` }] }, { ui: harness.ui });
    const listCmd = harness.commands.get("vibeguard:list");
    await listCmd!.handler("", { ui: harness.ui });
    expect(harness.components).toHaveLength(1);

    // Wait past the TTL; the command's cleanup pass must remove the entry.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const componentsBefore = harness.components.length;
    await listCmd!.handler("", { ui: harness.ui });
    expect(harness.components).toHaveLength(componentsBefore);
    expect(harness.notifications.at(-1)?.message).toContain("暂无存活映射");
  });

  it("notifies when the plugin is disabled", async () => {
    const disabledDir = await makeConfigDir({ enabled: false });
    const harness = makeHarness();
    vibeguardExtension(harness.api);
    await harness.dispatch("session_start", {}, { cwd: disabledDir, ui: harness.ui });

    const listCmd = harness.commands.get("vibeguard:list");
    await listCmd!.handler("", { ui: harness.ui });
    expect(harness.components).toHaveLength(0);
    const note = harness.notifications.at(-1)?.message ?? "";
    expect(note).toContain("未启用");
    expect(harness.notifications.at(-1)?.level).toBe("warning");
  });

  it("notifies when no config file exists", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "vg-empty-"));
    const harness = makeHarness();
    vibeguardExtension(harness.api);
    await harness.dispatch("session_start", {}, { cwd: emptyDir, ui: harness.ui });

    const listCmd = harness.commands.get("vibeguard:list");
    await listCmd!.handler("", { ui: harness.ui });
    expect(harness.components).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain("未启用");
  });
});
