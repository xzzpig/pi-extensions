import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  AssistantMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  ScrollView,
  Text,
  VStack,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { GroupCollapseRuntime } from "../src/runtime.ts";

// Starline uses bundler-style extensionless imports. Load its actual source
// at runtime without adding that sibling's separate tsconfig to this package.
const starlineModule = new URL(
  "../../pi-starline/extensions/starline/mouse/tool-box.ts",
  import.meta.url,
).href;
let expandTargetAt: (
  lookup: { root: unknown; keyText: string },
  x: number,
  y: number,
) =>
  | { component: { setExpanded(expanded: boolean): void }; expanded: boolean }
  | undefined;
beforeAll(async () => {
  ({ expandTargetAt } = await import(starlineModule));
});

const WIDTH = 120;
type Host = {
  chatContainer: Container;
  ui: { requestRender(): void };
  outputPad: number;
  showExtensionNotify(message: string, level: "info"): void;
};

let runtime: GroupCollapseRuntime;
let host: Host;
let dir: string;
let previousDir: string | undefined;

beforeEach(() => {
  initTheme();
  dir = mkdtempSync(join(tmpdir(), "pigc-starline-footer-"));
  previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(
    join(dir, "group-collapse.json"),
    JSON.stringify({
      rules: [{ kind: "notification", textPrefix: "NOTICE:", action: "group" }],
    }),
  );
  runtime = new GroupCollapseRuntime({ notify: () => {} });
  runtime.onSessionStart({ mode: "tui", cwd: dir, getBranch: () => [] });
  host = Object.create(InteractiveMode.prototype) as Host;
  host.chatContainer = new Container();
  host.ui = { requestRender() {} };
  host.outputPad = 1;
  runtime.handlePiEvent({ type: "agent_start" });
});

afterEach(() => {
  runtime.onSessionShutdown();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

function settle(): void {
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_before_settle", outcome: "completed" });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
}

function tool(id: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "bash",
    id,
    { command: `echo ${id}` },
    {},
    undefined,
    { requestRender() {} } as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `BODY-${id}` }], isError: false },
    false,
  );
  host.chatContainer.addChild(component);
  runtime.syncReceiver(host);
  runtime.handlePiEvent({
    type: "tool_execution_end",
    toolCallId: id,
    isError: false,
  });
  return component;
}

function scene() {
  const document = new Container();
  document.addChild(host.chatContainer);
  const scroll = new ScrollView(document);
  const root = new VStack([{ component: scroll, grow: 1 }]);
  const frame = renderLayoutFrame(root, WIDTH, 60, () => {});
  const box = frame.root.children[0] as typeof frame.root & {
    scrollContentLines?: readonly string[];
  };
  const content = box.children[0];
  if (!content || !box.scrollContentLines) throw new Error("no scroll content");
  const lines = box.scrollContentLines;
  const row = (needle: string) => {
    const index = lines.findIndex((line) =>
      stripTerminalSequences(line).includes(needle),
    );
    if (index < 0) throw new Error(`missing ${needle}`);
    return content.rect.y + index;
  };
  const lookup = { root: frame.root, keyText: "ctrl+o" };
  return {
    target: (needle: string) => expandTargetAt(lookup, 2, row(needle)),
    lines,
  };
}

function assertFooterMatchesHeader(): void {
  settle();
  expect(runtime.expandAll()).toBe(1);
  const rendered = scene();
  const header = rendered.target("▾ 分组");
  const footer = rendered.target("收起分组");
  expect(header).toBeDefined();
  expect(footer?.component).toBe(header?.component);
  expect(footer?.expanded).toBe(false);
  footer?.component.setExpanded(false);
  const collapsed = host.chatContainer
    .render(WIDTH)
    .map(stripTerminalSequences)
    .join("\n");
  expect(collapsed).toContain("▸ 分组");
  expect(collapsed).not.toContain("收起分组");
}

describe("Starline resolves projected footer rows through real ScrollView layout", () => {
  test("tool footer wins over the independently expandable tool", () => {
    host.chatContainer.addChild(new Text("BEFORE", 0, 0));
    tool("last");
    assertFooterMatchesHeader();
  });

  test("assistant thinking footer resolves through the projected component", () => {
    const component = new AssistantMessageComponent(
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "THOUGHT" }],
        api: "anthropic-messages",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      } as never,
      false,
      getMarkdownTheme(),
    );
    host.chatContainer.addChild(component);
    runtime.syncReceiver(host);
    assertFooterMatchesHeader();
  });

  test("notification footer resolves even without the carrier's setExpanded", () => {
    host.showExtensionNotify("NOTICE: text", "info");
    runtime.syncReceiver(host);
    assertFooterMatchesHeader();
  });
});
