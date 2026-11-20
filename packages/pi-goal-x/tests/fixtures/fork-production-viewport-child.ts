import assert from "node:assert/strict";
import test from "node:test";
import {
  Container,
  getKeybindings,
  TuiAltScreen,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
// Pi keeps the production viewport helper private; load its installed module
// relative to the public SDK entry without changing Pi or its package exports.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { createChatViewport } = await import(
  new URL("./modes/interactive/chat-viewport.js", sdkEntry).href
);
const { createInteractiveTuiReference } = await import(
  new URL("./modes/interactive/tui-renderer.js", sdkEntry).href
);
import type {
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { showProposalDialog } from "../../extensions/goal-questionnaire.ts";
import { showTweakProposalDialog } from "../../extensions/goal-tweak-confirmation.ts";
import { buildTweakComparison } from "../../extensions/goal-tweak-diff.ts";
import { projectTweakCandidate } from "../../extensions/goal-tweak-projection.ts";
import { convertFlatTasks } from "../../extensions/goal-task-tools.ts";
import { createGoal } from "../../extensions/goal-record.ts";
import { GoalWidgetComponent } from "../../extensions/widgets/goal-widget.ts";
import type { GoalRecord } from "../../extensions/goal-record.ts";
import {
  createMockExtensionContext,
  createMockTheme,
} from "../tui-test-utils.ts";

async function setup(
  footerStart: number,
  kind: "create" | "tweak" = "create",
  link = false,
  mouse = true,
  semantic:
    | boolean
    | "long"
    | "views"
    | "literal-contract"
    | "wide-grapheme"
    | "narrow-anchor"
    | "frame" = false,
  rpc = false,
  frame?: { before: string; candidate: string; taskMode?: "before" | "after" },
) {
  let input = (_data: string) => {};
  let resized = () => {};
  let cursorVisible = false;
  const terminal = {
    columns: 130,
    rows: 45,
    kittyProtocolActive: true,
    start(fn: typeof input, onResize: () => void) {
      input = fn;
      resized = onResize;
    },
    stop() {},
    write(data: string) {
      for (const match of data.matchAll(/\x1b\[\?25([hl])/g))
        cursorVisible = match[1] === "h";
    },
    hideCursor() {
      cursorVisible = false;
    },
    showCursor() {
      cursorVisible = true;
    },
    moveBy() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
  };
  let opened = "";
  let copied = "";
  const tui = new TuiAltScreen(terminal as never, true, undefined, {
    mouse,
    copySelection: async (value: string) => {
      copied = value;
      return true;
    },
    openUrl: (url) => {
      opened = url;
    },
  });
  const host = tui as unknown as { doRender(): void };
  const ctx = createMockExtensionContext();
  if (rpc) (ctx as unknown as { mode: string }).mode = "rpc";
  let done = false;
  let result: unknown;
  let component: (Component & { dispose?(): void }) | undefined;
  (ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = ((
    factory: Parameters<ExtensionUIContext["custom"]>[0],
  ) =>
    new Promise<unknown>((resolve) => {
      component = factory(
        createInteractiveTuiReference(() => tui),
        createMockTheme(),
        {} as KeybindingsManager,
        (value: unknown) => {
          done = true;
          result = value;
          resolve(value);
        },
      ) as Component & { dispose?(): void };
    })) as ExtensionUIContext["custom"];
  let footerHeight = footerStart;
  const empty = { render: () => [], invalidate() {} };
  const document = {
    render: () => Array.from({ length: 60 }, (_, i) => `chat ${i}`),
    invalidate() {},
  };
  const footer = {
    render: () => Array.from({ length: footerHeight }, () => "footer"),
    invalidate() {},
  };
  const editor = new Container();
  // Match Pi: a short ordinary editor is laid out before it is replaced by
  // the custom dialog, so the previous committed slot is initially tiny.
  editor.addChild({ render: () => ["editor", "", ""], invalidate() {} });
  const viewport = createChatViewport({
    document,
    pendingMessages: empty,
    status: link
      ? {
          render: () => [
            "\x1b]8;;https://example.test/goal-link\x07LINK FIXTURE\x1b]8;;\x07",
          ],
          invalidate() {},
        }
      : empty,
    editor,
    footer,
  });
  tui.setLayoutRoot(viewport.root);
  tui.start();
  host.doRender();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const body = Array.from(
    { length: rpc ? 70 : 35 },
    (_, i) => `proposal ${i}`,
  ).join("\n");
  if (kind === "create") void showProposalDialog(ctx, body, "goal", true);
  else
    void showTweakProposalDialog(ctx, {
      defaultAuditorEnabled: true,
      presentation: () =>
        typeof semantic === "string"
          ? (() => {
              const old =
                semantic === "frame"
                  ? frame!.before
                  : semantic === "narrow-anchor"
                    ? "甲"
                    : semantic === "wide-grapheme"
                      ? "OLD"
                      : semantic === "long"
                        ? "OLD-SHORT"
                        : Array.from(
                            { length: 60 },
                            (_, i) => `OLD${String(i).padStart(3, "0")}`,
                          ).join("\n");
              const next =
                semantic === "frame"
                  ? frame!.candidate
                  : semantic === "narrow-anchor"
                    ? "乙"
                    : semantic === "wide-grapheme"
                      ? "Aस्त्रB"
                      : Array.from(
                          { length: semantic === "long" ? 600 : 60 },
                          (_, i) => `NEW${String(i).padStart(3, "0")}`,
                        ).join(semantic === "long" ? " " : "\n");
              const goal = (objective: string): GoalRecord => ({
                id: "test",
                objective,
                status: "active",
                autoContinue: true,
                usage: { tokensUsed: 0, activeSeconds: 0 },
                sisyphus: false,
                revision: 1,
                createdAt: "now",
                updatedAt: "now",
              });
              const before = goal(
                semantic === "literal-contract" ? "same objective" : old,
              );
              if (semantic === "frame" && frame?.taskMode) {
                before.taskList = {
                  tasks: [
                    {
                      id: "parent",
                      title: "Write docs (lightweight subtasks)",
                      status: "pending",
                      subtasks: [
                        { id: "child", title: "Child", status: "pending" },
                      ],
                    },
                  ],
                  blockCompletion: false,
                  proposedAt: "now",
                };
              }
              const converted =
                semantic === "frame" && frame?.taskMode === "after"
                  ? convertFlatTasks(
                      [
                        {
                          id: "parent",
                          title: "Write docs",
                          lightweight_subtasks: true,
                        },
                        { id: "child", title: "Child", parent_id: "parent" },
                      ],
                      { maxSubtaskDepth: 2 },
                    )
                  : undefined;
              if (converted && !converted.ok) throw Error(converted.message);
              const after =
                semantic === "literal-contract"
                  ? projectTweakCandidate(
                      before,
                      {
                        objective:
                          "same objective\nVerification contract: (none)",
                        auditorEnabled: true,
                      },
                      {
                        disableContracts: false,
                        sessionId: "test",
                        now: "now",
                        schedulerGeneration: "g",
                      },
                    ).candidate
                  : semantic === "frame"
                    ? projectTweakCandidate(
                        before,
                        {
                          objective: next,
                          auditorEnabled: true,
                          ...(converted?.ok
                            ? {
                                taskList: {
                                  tasks: converted.tasks,
                                  blockCompletion: false,
                                  proposedAt: "now",
                                },
                              }
                            : {}),
                        },
                        {
                          disableContracts: false,
                          sessionId: "test",
                          now: "now",
                          schedulerGeneration: "g",
                        },
                      ).candidate
                    : goal(next);
              const comparison = buildTweakComparison(before, after);
              return {
                ...comparison.presentation,
                diffEntries: comparison.entries,
                fullUiText: comparison.fullUiText,
              };
            })()
          : semantic
            ? {
                diffText: body,
                fullText: body,
                diffEntries: [
                  {
                    kind: "line",
                    lineKind: "remove",
                    content: "OLD-SHORT",
                    hunkIndex: 1,
                  },
                  {
                    kind: "line",
                    lineKind: "add",
                    content: Array.from(
                      { length: 90 },
                      (_, i) => `NEW${String(i).padStart(3, "0")}`,
                    ).join("\n"),
                    hunkIndex: 1,
                  },
                ],
              }
            : { diffText: body, fullText: body },
    });
  assert.ok(component);
  editor.clear();
  editor.addChild(component);
  tui.setFocus(component);
  const draw = async () => {
    for (let i = 0; i < 4; i++) {
      host.doRender();
      await Promise.resolve();
    }
  };
  // A production redraw is scheduled by Pi; do not force subsequent frames,
  // otherwise a missing post-commit growth invalidation would be masked.
  host.doRender();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const point = (label = "[Confirm selection]") => {
    const lines = tui.getScreenLines();
    const y = lines.findIndex((line) => line.includes(label));
    assert.ok(
      y >= 0,
      `${kind} ${label} must remain visible in real editor Container`,
    );
    const line = lines[y]!;
    return { x: visibleWidth(line.slice(0, line.indexOf(label))), y };
  };
  const send = (code: number, p: { x: number; y: number }, end: "M" | "m") =>
    input(`\x1b[<${code};${p.x + 1};${p.y + 1}${end}`);
  return {
    tui,
    component,
    point,
    send,
    draw,
    input: (data: string) => input(data),
    screen: () => tui.getScreenLines().join("\n"),
    notifyResize: (rows: number, columns: number) => {
      terminal.rows = rows;
      terminal.columns = columns;
      resized();
    },
    resize: async (rows: number, columns = terminal.columns) => {
      terminal.rows = rows;
      terminal.columns = columns;
      resized();
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    cursorVisible: () => cursorVisible,
    done: () => done,
    result: () => result,
    opened: () => opened,
    copied: () => copied,
    setFooter: async (n: number) => {
      footerHeight = n;
      await draw();
    },
  };
}

for (const kind of ["create", "tweak"] as const)
  for (const footer of [0, 10])
    test(`production viewport ${kind} recovers after shrink/grow and feedback, footer ${footer}`, async () => {
      const h = await setup(footer, kind);
      try {
        await h.resize(10);
        await h.resize(45);
        h.point();
        await h.resize(60);
        h.point();
        h.input("\x1b[B");
        h.input("\r");
        await new Promise((r) => setTimeout(r, 160));
        assert.match(h.screen(), /refinement feedback/);
        h.input("\x1b");
        await new Promise((r) => setTimeout(r, 160));
        h.point();
      } finally {
        h.component.dispose?.();
        h.tui.stop();
      }
    });

for (const kind of ["create", "tweak"] as const)
  test(`one-row ${kind} keeps body and decision reachable`, async () => {
    const h = await setup(0, kind);
    try {
      await h.resize(1);
      assert.equal(
        h.tui.getFocusedComponent(),
        h.component,
        "dialog focus must survive one-row resize",
      );
      const seen: string[] = [h.screen()];
      h.send(65, { x: 10, y: 0 }, "M");
      await h.draw();
      assert.notEqual(
        h.screen(),
        seen[0],
        "one-row wheel must scroll the dialog rather than chat",
      );
      for (let i = 0; i < 100; i++) {
        h.input("\x1b[6~");
        assert.equal(
          h.tui.getFocusedComponent(),
          h.component,
          `focus after key ${i}`,
        );
        await h.draw();
        seen.push(h.screen());
      }
      assert.ok(
        seen.some((line) => line.includes("proposal 0")),
        `body must be reachable: ${JSON.stringify(seen.slice(0, 12))}`,
      );
      assert.ok(
        seen.some((line) => line.includes("[Confirm selection]")),
        "confirm must be reachable",
      );
      await h.resize(45);
      h.point();
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  test(`preserves ${kind} reading anchor across fixed and tiny heights`, async () => {
    const h = await setup(10, kind, false, false);
    try {
      h.input("\x1b[6~");
      await h.draw();
      const first = h.screen().match(/proposal \d+/)?.[0];
      assert.ok(first);
      await h.resize(5);
      assert.ok(
        h.screen().includes(first),
        `shrinking lost ${first}: ${h.screen()}`,
      );
      for (let i = 0; i < 3; i++) {
        h.input("\x1b[6~");
        await h.draw();
      }
      const tiny = h.screen().match(/proposal \d+/)?.[0];
      assert.ok(tiny);
      await h.resize(45);
      assert.ok(
        h.screen().includes(tiny),
        `growing lost ${tiny}: ${h.screen()}`,
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

test("one-sided split continuation preserves semantic reading anchor on width reflow", async () => {
  const h = await setup(10, "tweak", false, false, true);
  try {
    for (let i = 0; i < 54; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    const first = h.screen().match(/NEW\d{3}/)?.[0];
    assert.ok(first);
    await h.resize(45, 122);
    assert.ok(
      h.screen().includes(first),
      `narrow lost ${first}: ${h.screen()}`,
    );
    await h.resize(45, 130);
    assert.ok(h.screen().includes(first), `wide lost ${first}: ${h.screen()}`);
    await h.resize(5, 130);
    assert.ok(h.screen().includes(first), `tiny lost ${first}: ${h.screen()}`);
    await h.resize(5, 122);
    assert.ok(
      h.screen().includes(first),
      `tiny narrow lost ${first}: ${h.screen()}`,
    );
    await h.resize(45, 130);
    assert.ok(
      h.screen().includes(first),
      `tiny-to-wide lost ${first}: ${h.screen()}`,
    );
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("production long logical line keeps its source position across 120/119 reflow", async () => {
  const h = await setup(10, "tweak", false, false, "long");
  try {
    let first = "";
    for (let i = 0; i < 100; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
      first = h.screen().match(/NEW\d{3}/)?.[0] ?? "";
      if (Number(first.slice(3)) >= 249) break;
    }
    assert.ok(
      Number(first.slice(3)) >= 249,
      `failed to reach desired source: ${first}`,
    );
    for (let i = 0; i < 5; i++) {
      await h.resize(45, 122);
      assert.ok(
        h.screen().includes(first),
        `narrow lost ${first} on round ${i}`,
      );
      await h.resize(45, 130);
      assert.ok(h.screen().includes(first), `wide lost ${first} on round ${i}`);
    }
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("diff and full retain independent reading anchors after a tiny-screen view switch", async () => {
  const h = await setup(10, "tweak", false, false, "views");
  try {
    for (let i = 0; i < 13; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    const diffAnchor = h.screen().match(/NEW\d{3}/)?.[0];
    assert.ok(diffAnchor);
    h.input("\x1b[B");
    h.input("\x1b[B");
    h.input("\x1b[B");
    h.input("\r");
    await h.draw();
    assert.match(h.screen(), /full effective content/);
    for (let i = 0; i < 28; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    const fullAnchor = h.screen().match(/NEW\d{3}/)?.[0];
    assert.ok(fullAnchor);
    assert.notEqual(fullAnchor, diffAnchor);
    await h.resize(5);
    assert.ok(h.screen().includes(fullAnchor), `tiny lost full ${fullAnchor}`);
    h.input("\r");
    await h.draw();
    assert.ok(
      h.screen().includes(diffAnchor),
      `tiny lost diff ${diffAnchor}: ${h.screen()}`,
    );
    h.input("\r");
    await h.draw();
    assert.ok(
      h.screen().includes(fullAnchor),
      `return lost full ${fullAnchor}: ${h.screen()}`,
    );
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("creation reading anchor survives tall and partially expanded height round trips", async () => {
  const h = await setup(10, "create", false, false);
  try {
    for (let i = 0; i < 20; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    const first = h.screen().match(/proposal \d+/)?.[0];
    assert.ok(first);
    for (const height of [160, 70]) {
      await h.resize(height);
      await h.resize(45);
      assert.equal(
        h.screen().match(/proposal \d+/)?.[0],
        first,
        `height ${height} lost ${first}`,
      );
    }
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("production diff and full source anchors survive tall and partial height round trips", async () => {
  const h = await setup(10, "tweak", false, false, "views");
  try {
    for (let i = 0; i < 25; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    const diff = h.screen().match(/NEW\d{3}/)?.[0];
    assert.ok(diff);
    for (const height of [160, 70]) {
      await h.resize(height);
      await h.resize(45);
      assert.equal(
        h.screen().match(/NEW\d{3}/)?.[0],
        diff,
        `diff height ${height} lost ${diff}`,
      );
    }
    h.input("\x1b[B");
    h.input("\x1b[B");
    h.input("\x1b[B");
    h.input("\r");
    await h.draw();
    for (let i = 0; i < 35; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    const full = h.screen().match(/NEW\d{3}/)?.[0];
    assert.ok(full);
    for (const height of [160, 70]) {
      await h.resize(height);
      await h.resize(45);
      assert.equal(
        h.screen().match(/NEW\d{3}/)?.[0],
        full,
        `full height ${height} lost ${full}`,
      );
    }
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const view of ["create", "diff", "full"] as const)
  test(`${view} preserves its anchor through fitted → all-visible → tiny → scroll → fitted`, async () => {
    const h = await setup(
      10,
      view === "create" ? "create" : "tweak",
      false,
      false,
      view !== "create" && "views",
    );
    try {
      if (view === "full") {
        for (let i = 0; i < 3; i++) h.input("\x1b[B");
        h.input("\r");
        await h.draw();
      }
      const marker = () =>
        h
          .screen()
          .match(view === "create" ? /proposal (\d+)/ : /NEW(\d{3})/)?.[1];
      for (let i = 0; i < (view === "create" ? 12 : 24); i++) {
        h.input("\x1b[1;5B");
        await h.draw();
      }
      const before = marker();
      assert.ok(Number(before) > 0);
      await h.resize(160);
      assert.doesNotMatch(h.screen(), /[▲▼] \d+ more/);
      await h.resize(5);
      assert.equal(marker(), before);
      h.input("\x1b[1;5B");
      await h.draw();
      const next = marker();
      assert.equal(Number(next), Number(before) + 1);
      await h.resize(45);
      assert.equal(marker(), next);
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

test("scrolling to the split header in tiny mode keeps the body at the top when it expands", async () => {
  const h = await setup(10, "tweak", false, false, "views");
  try {
    for (let i = 0; i < 20; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    await h.resize(5);
    assert.doesNotMatch(h.screen(), /旧值/);
    for (let i = 0; i < 60 && !h.screen().includes("旧值"); i++) {
      h.input("\x1b[1;5A");
      await h.draw();
    }
    assert.match(h.screen(), /旧值/);
    await h.resize(45);
    assert.match(h.screen(), /旧值/);
    assert.doesNotMatch(h.screen(), /▲ \d+ more/);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("explicit top scroll discards stale anchor even when the split header has no source", async () => {
  const h = await setup(10, "tweak", false, false, "views");
  try {
    for (let i = 0; i < 30; i++) {
      h.input("\x1b[1;5B");
      await h.draw();
    }
    for (let i = 0; i < 90; i++) {
      h.input("\x1b[1;5A");
      await h.draw();
    }
    assert.match(h.screen(), /旧值/);
    assert.match(h.screen(), /NEW000/);
    await h.resize(45, 122);
    assert.match(h.screen(), /OLD000/);
    assert.doesNotMatch(h.screen(), /▲ \d+ more/);
    await h.resize(45, 130);
    assert.match(h.screen(), /旧值/);
    assert.match(h.screen(), /NEW000/);
    assert.doesNotMatch(h.screen(), /▲ \d+ more/);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const kind of ["create", "tweak"] as const)
  test(`independent ${kind} control describes selected action`, async () => {
    const h = await setup(0, kind, false, false);
    try {
      const labels =
        kind === "create"
          ? ["Create", "Refine", "Cancel"]
          : ["Apply", "Refine", "Cancel", "Full view"];
      for (const [index, label] of labels.entries()) {
        if (index) {
          h.input("\x1b[B");
          await h.draw();
        }
        assert.match(
          h.screen(),
          new RegExp(`\\[Confirm selection\\] ${label}`),
        );
        await h.resize(5);
        for (
          let n = 0;
          n < 90 && !h.screen().includes(`[Confirm selection] ${label}`);
          n++
        ) {
          h.input("\x1b[6~");
          await h.draw();
        }
        assert.ok(
          h.screen().includes(`[Confirm selection] ${label}`),
          `tiny control lacks ${label}`,
        );
        await h.resize(45);
      }
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  for (const rows of [45, 5])
    test(`keyboard-only ${kind} scrolls dialog at ${rows} rows`, async () => {
      const h = await setup(10, kind, false, false);
      try {
        await h.resize(rows);
        const before = h.screen();
        const seen: string[] = [before];
        for (let i = 0; i < 90; i++) {
          h.input("\x1b[6~");
          await h.draw();
          seen.push(h.screen());
        }
        assert.ok(
          seen.some((screen) => screen.includes("proposal 0")),
          "body must be reachable",
        );
        assert.ok(
          seen.some((screen) => screen.includes("[Confirm selection]")),
          "confirmation must be reachable",
        );
        assert.notEqual(
          seen.at(-1),
          before,
          "keyboard must scroll the dialog rather than chat",
        );
        h.input("\x1b[5~");
        await h.draw();
        const pageUp = h.screen();
        assert.notEqual(pageUp, seen.at(-1), "PageUp must move the dialog");
        h.input("\x1b[1;5A");
        await h.draw();
        assert.notEqual(h.screen(), pageUp, "Ctrl+Up must move the dialog");
        h.input("\x1b[1;5B");
        await h.draw();
        assert.equal(
          h.screen(),
          pageUp,
          "Ctrl+Down must reverse exactly one row",
        );
      } finally {
        h.component.dispose?.();
        h.tui.stop();
      }
    });

test("real fullscreen host activates OSC 8 and does not decide the dialog", async () => {
  const h = await setup(0, "create", true);
  try {
    const point = h.point("LINK FIXTURE");
    h.send(0, point, "M");
    h.send(0, point, "m");
    await h.draw();
    assert.equal(h.opened(), "https://example.test/goal-link");
    assert.equal(h.done(), false);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("feedback Escape restores fixed layout and the previous body anchor", async () => {
  const h = await setup(10, "tweak");
  try {
    for (let i = 0; i < 5; i++) h.send(65, { x: 20, y: 10 }, "M");
    await h.draw();
    const before = h.screen().match(/▲ (\d+) more/)?.[1];
    assert.ok(before);
    h.input("\x1b[B");
    h.input("\r");
    await new Promise((r) => setTimeout(r, 160));
    assert.match(h.screen(), /refinement feedback/);
    h.input("\x1b");
    await new Promise((r) => setTimeout(r, 160));
    h.point();
    assert.equal(h.screen().match(/▲ (\d+) more/)?.[1], before);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("one-row fallback yields to a real higher overlay and restores the dialog", async () => {
  const h = await setup(0);
  try {
    await h.resize(1);
    let pressed = false;
    const other = {
      render: () => ["EXTERNAL OVERLAY"],
      invalidate() {},
      handleInput: () => {
        pressed = true;
      },
    };
    const overlay = h.tui.showOverlay(other, { width: "100%", maxHeight: 1 });
    await h.draw();
    assert.match(h.screen(), /EXTERNAL OVERLAY/);
    h.input("x");
    assert.equal(pressed, true);
    overlay.hide();
    await h.draw();
    assert.doesNotMatch(h.screen(), /EXTERNAL OVERLAY/);
    await h.resize(45);
    h.point();
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const kind of ["create", "tweak"] as const)
  test(`${kind} wheel stays in its native target when another overlay is visible`, async () => {
    const h = await setup(10, kind, false, true, kind === "tweak" && "views");
    try {
      const body = h.point(kind === "create" ? "proposal 0" : "NEW000");
      let overlayDelta = 0;
      const overlay = {
        render: () => ["WHEEL OVERLAY"],
        invalidate() {},
        handleMouse(event: TuiMouseEvent) {
          if (event.type !== "wheel") return;
          overlayDelta += event.wheelDelta ?? 0;
          return { handled: true };
        },
      };
      const separate = h.tui.showOverlay(overlay, {
        anchor: "top-right",
        width: 18,
        nonCapturing: true,
      });
      await h.draw();
      const start = h.screen();
      assert.match(start, /chat 59/);
      h.send(64, body, "M");
      await h.draw();
      assert.equal(
        h.screen(),
        start,
        "wheel at the dialog's top must not scroll chat",
      );
      h.send(65, body, "M");
      await h.draw();
      assert.match(h.screen(), /▲ 1 more/);
      assert.match(h.screen(), /chat 59/);
      assert.equal(overlayDelta, 0);
      separate.hide();
      h.tui.showOverlay(overlay, {
        row: body.y,
        col: body.x,
        width: 18,
        nonCapturing: true,
      });
      await h.draw();
      const covered = h.screen();
      assert.match(covered, /WHEEL OVERLAY/);
      h.send(65, body, "M");
      await h.draw();
      assert.equal(
        overlayDelta,
        1,
        "native Pi dispatch must prioritize the hit overlay",
      );
      assert.equal(
        h.screen(),
        covered,
        "covered event must not move the dialog or chat",
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  test(`${kind} accepts fresh clicks and native editor positioning beside a noncapturing overlay`, async () => {
    const h = await setup(10, kind, false, true, kind === "tweak" && "views");
    const click = (p: { x: number; y: number }) => {
      h.send(0, p, "M");
      h.send(0, p, "m");
    };
    const wait = async (ms = 560) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await h.draw();
    };
    try {
      const view = { render: () => ["SIDE OVERLAY"], invalidate() {} };
      const side = () =>
        h.tui.showOverlay(view, {
          anchor: "top-right",
          width: 18,
          nonCapturing: true,
        });
      const overlay = side();
      await h.draw();
      const confirm = h.point();
      // Native overlay coverage wins at a coordinate that would otherwise confirm.
      let coveredClicks = 0;
      const covered = h.tui.showOverlay(
        {
          ...view,
          handleMouse(e: TuiMouseEvent) {
            if (e.type !== "click") return;
            coveredClicks++;
            return { handled: true };
          },
        },
        { row: confirm.y, col: confirm.x, width: 18, nonCapturing: true },
      );
      await h.draw();
      click(confirm);
      await wait();
      assert.equal(coveredClicks, 1);
      assert.equal(h.done(), false);
      covered.hide();
      await wait();
      // Both phases must invalidate on overlay identity changes even though a side overlay remains visible.
      for (const phase of ["press", "pending"] as const) {
        h.send(0, confirm, "M");
        if (phase === "pending") h.send(0, confirm, "m");
        const other = side();
        await h.draw();
        other.hide();
        await h.draw();
        if (phase === "press") h.send(0, confirm, "m");
        await wait();
        assert.equal(h.done(), false, phase);
      }
      click(h.point("2. Continue chatting"));
      await h.draw();
      assert.match(h.screen(), /> 2\. Continue/);
      assert.equal(h.done(), false);
      click(h.point("[Confirm selection] Refine"));
      await wait();
      assert.match(h.screen(), /refinement feedback/);
      h.input("uvwxyz");
      await h.draw();
      click(h.point("uvwxyz"));
      await h.draw();
      h.input("A");
      await h.draw();
      assert.match(h.screen(), /Auvwxyz/);
      h.input("\x1b");
      h.input("\x1b[A");
      await h.draw();
      click(
        h.point(
          kind === "create"
            ? "[Confirm selection] Create"
            : "[Confirm selection] Apply",
        ),
      );
      await wait();
      assert.equal(
        h.done(),
        true,
        "default confirmation must execute beside a stable overlay",
      );
      overlay.hide();
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  test(`${kind} keeps native transcript edge auto-scroll and multi-line copy outside the dialog`, async () => {
    const h = await setup(10, kind, false, true, kind === "tweak" && "views");
    try {
      const anchor = h.point("chat 59");
      const bodyBefore = h
        .screen()
        .split("\n")
        .find((line) =>
          line.includes(kind === "create" ? "proposal 0" : "NEW000"),
        );
      h.send(0, { x: anchor.x + 6, y: anchor.y }, "M");
      h.send(32, { x: anchor.x, y: 0 }, "M");
      await new Promise((resolve) => setTimeout(resolve, 375));
      await h.draw();
      assert.doesNotMatch(
        h.screen(),
        /chat 59/,
        "edge must scroll the native transcript",
      );
      h.send(0, { x: anchor.x, y: 0 }, "m");
      assert.ok(h.copied().split("\n").length >= 3, JSON.stringify(h.copied()));
      assert.match(h.copied(), /chat 58/);
      assert.ok(
        bodyBefore && h.screen().includes(bodyBefore),
        "dialog reading position is unchanged",
      );
      assert.equal(
        h.tui.hasOverlay(),
        false,
        "normal-size dialogs must not register a visible overlay",
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  test(`${kind} rejects coalesced resize gestures and preserves transcript shortcuts`, async () => {
    const h = await setup(10, kind, false, true, kind === "tweak" && "views");
    try {
      h.input("\x1b[1;5H");
      await h.draw();
      assert.match(h.screen(), /chat 0(?:[^0-9]|$)/);
      h.input("\x1b[1;5F");
      await h.draw();
      assert.match(h.screen(), /chat 59/);
      h.input("\x1b[6~");
      await h.draw();
      assert.match(h.screen(), /▲ [1-9]/);
      assert.match(h.screen(), /chat 59/);
      for (const phase of ["pressed", "pending"] as const) {
        const p = h.point();
        h.send(0, p, "M");
        if (phase === "pending") h.send(0, p, "m");
        h.notifyResize(40, 122);
        h.notifyResize(45, 130);
        if (phase === "pressed") h.send(0, p, "m");
        await new Promise((resolve) => setTimeout(resolve, 560));
        await h.draw();
        assert.equal(
          h.done(),
          false,
          `${phase} gesture revived despite a notified resize round trip`,
        );
      }
      const p = h.point();
      h.send(0, p, "M");
      h.send(0, p, "m");
      await new Promise((resolve) => setTimeout(resolve, 560));
      assert.equal(
        h.done(),
        true,
        "fresh press should work after the final redraw",
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  for (const phase of ["pressed", "pending"] as const)
    test(`${kind} invalidates ${phase} confirmation on coalesced native overlay changes`, async () => {
      const h = await setup(10, kind, false, true, kind === "tweak" && "views");
      try {
        const p = h.point();
        h.send(0, p, "M");
        if (phase === "pending") h.send(0, p, "m");
        const overlay = h.tui.showOverlay(
          { render: () => ["BRIEF OVERLAY"], invalidate() {} },
          { nonCapturing: true },
        );
        assert.equal(h.tui.hasOverlay(), true);
        overlay.hide();
        assert.equal(h.tui.hasOverlay(), false);
        if (phase === "pressed") h.send(0, p, "m");
        await new Promise((resolve) => setTimeout(resolve, 560));
        await h.draw();
        assert.equal(
          h.done(),
          false,
          "notification-only overlay round trip revived old confirmation",
        );
        const fresh = h.point();
        h.send(0, fresh, "M");
        h.send(0, fresh, "m");
        await h.draw();
        await new Promise((resolve) => setTimeout(resolve, 560));
        assert.equal(
          h.done(),
          true,
          "an unchanged redraw must not cancel the fresh confirmation",
        );
      } finally {
        h.component.dispose?.();
        h.tui.stop();
      }
    });

test("production root contract literal is distinct from absent in diff and full view", async () => {
  const h = await setup(10, "tweak", false, false, "literal-contract");
  try {
    assert.match(h.screen(), /- \(none\).*\+ "\(none\)"/);
    for (let i = 0; i < 3; i++) h.input("\x1b[B");
    h.input("\r");
    await h.draw();
    assert.match(h.screen(), /Verification contract: "\(none\)"/);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const kind of ["create", "tweak"] as const)
  test(`${kind} feedback keeps double-width input through very narrow resize and recovery`, async () => {
    const h = await setup(10, kind, false, false, kind === "tweak" && "views");
    try {
      h.input("\x1b[B");
      h.input("\r");
      h.input("中");
      await h.draw();
      for (const width of [7, 6, 5, 4, 3, 2, 1]) {
        await h.resize(45, width);
        if (width > 1)
          assert.match(
            h.screen(),
            /中/,
            `feedback must be visible at width ${width}`,
          );
      }
      h.input("文");
      await h.draw();
      await h.resize(45, 130);
      assert.match(h.screen(), /中文/);
      h.input("\x1b");
      await h.draw();
      h.input("\r");
      await h.draw();
      assert.match(h.screen(), /中文/, "Esc and re-entry keep the draft");
      h.input("\x1b[D");
      h.input("A");
      h.input("\r");
      assert.equal((h.result() as { feedback?: string }).feedback, "中A文");
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  test(`${kind} keeps wide Unicode feedback through native paste and narrow layout`, async () => {
    const h = await setup(10, kind, false, false, kind === "tweak" && "views");
    try {
      const conjunct = "स्त्र";
      assert.ok(visibleWidth(conjunct) > 2);
      h.input("\x1b[B");
      h.input("\r");
      h.input(`\x1b[200~${conjunct}\x1b[201~`);
      await h.draw();
      await h.resize(45, 6);
      assert.match(h.screen(), /स्त्र/);
      await h.resize(45, 3);
      assert.match(h.screen(), /स्त्र/);
      await h.resize(45, 1);
      // Paste and a navigation key can arrive in the same native input batch.
      h.input(`\x1b[200~${conjunct}\x1b[201~\x1b[A`);
      await h.draw();
      await h.resize(45, 130);
      assert.ok(h.screen().includes(conjunct.repeat(2)));
      h.input("\x1b");
      await h.draw();
      h.input("\r");
      await h.draw();
      h.input("\x1b[D");
      h.input("A");
      h.input("\r");
      assert.equal(
        (h.result() as { feedback?: string }).feedback,
        `${conjunct}A${conjunct}`,
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  test(`${kind} keeps host IME cursor visible across narrow width roundtrip`, async () => {
    const h = await setup(10, kind, false, false, kind === "tweak" && "views");
    try {
      h.input("\x1b[B");
      h.input("\r");
      h.input("中");
      await h.draw();
      for (const width of [3, 2, 3, 1, 2, 130]) {
        await h.resize(45, width);
        await h.draw();
        assert.equal(h.cursorVisible(), true, `cursor at width ${width}`);
      }
      h.input("A");
      h.input("\r");
      assert.equal((h.result() as { feedback?: string }).feedback, "中A");
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

test("production semantic diff preserves fitting wide graphemes at narrow widths", async () => {
  const h = await setup(0, "tweak", false, false, "wide-grapheme");
  try {
    for (const width of [6, 7, 8]) {
      await h.resize(45, width);
      let found = false;
      for (let i = 0; i < 50; i++) {
        await h.draw();
        if (h.screen().includes("स्त्र")) {
          found = true;
          break;
        }
        h.input("\x1b[B");
      }
      assert.ok(found, `wide source grapheme accessible at width ${width}`);
      h.input("\x1b[H");
    }
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const kind of ["create", "tweak"] as const)
  test(`${kind} narrow multiline feedback reflows and supports native pointer positioning`, async () => {
    const h = await setup(0, kind, false, true, kind === "tweak" && "views");
    try {
      h.input("\x1b[B");
      h.input("\r");
      h.input("\x1b[200~स्त्र\nABCDEFG\x1b[201~");
      await h.draw();
      await h.resize(45, 3);
      await h.draw();
      const screen = h.tui.getScreenLines();
      const y = screen.findIndex((line) => line.includes("ABC"));
      assert.ok(y >= 0, "ABC visible for pointer positioning");
      h.send(0, { x: 0, y }, "M");
      h.send(0, { x: 0, y }, "m");
      h.input("X");
      await h.draw();
      await h.resize(45, 130);
      assert.match(h.screen(), /XABCDEFG/);
      await h.resize(45, 2);
      await h.draw();
      const text = h
        .screen()
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")
        .replace(/\s/g, "");
      assert.ok(
        text.includes("XABCDEFG"),
        "all fitting ASCII survives wrapping",
      );
      await h.resize(45, 130);
      h.input("\r");
      assert.equal(
        (h.result() as { feedback?: string }).feedback,
        "स्त्र\nXABCDEFG",
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const kind of ["create", "tweak"] as const)
  test(`${kind} narrow feedback moves keyboard by visible rows after mouse`, async () => {
    const h = await setup(0, kind, false, true, kind === "tweak" && "views");
    try {
      h.input("\x1b[B");
      h.input("\r");
      h.input("\x1b[200~स्त्र\nABCDEFG\x1b[201~");
      await h.draw();
      await h.resize(45, 2);
      await h.draw();
      const y = h.tui
        .getScreenLines()
        .findIndex((line) =>
          line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").startsWith("G"),
        );
      assert.ok(y >= 0);
      h.send(0, { x: 0, y }, "M");
      h.send(0, { x: 0, y }, "m");
      h.input("\x1b[A");
      h.input("X");
      await h.draw();
      await h.resize(45, 130);
      h.input("\r");
      assert.equal(
        (h.result() as { feedback?: string }).feedback,
        "स्त्र\nABCDEXFG",
      );
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

test("RPC host with native custom browses all creation proposal lines", async () => {
  const h = await setup(0, "create", false, false, false, true);
  try {
    await h.resize(22, 130);
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) {
      await h.draw();
      for (const match of h.screen().matchAll(/proposal (\d+)/g))
        seen.add(Number(match[1]));
      h.input("\x1b[1;5B");
    }
    assert.equal(seen.size, 70);
    assert.ok(seen.has(69));
    h.input("\r");
    assert.equal((h.result() as { decision?: string }).decision, "confirm");
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const kind of ["create", "tweak"] as const)
  for (const scenario of ["coalesced", "keymap", "rebound-up"] as const)
    test(`${kind} narrow feedback preserves ${scenario} editor navigation`, async () => {
      const kb = getKeybindings();
      const original = kb.getUserBindings();
      if (scenario !== "coalesced")
        kb.setUserBindings({
          ...original,
          "tui.editor.cursorUp": "ctrl+p",
          "tui.editor.cursorRight": "up",
        });
      const h = await setup(0, kind, false, true, kind === "tweak" && "views");
      try {
        h.input("\x1b[B");
        h.input("\r");
        h.input("\x1b[200~स्त्र\nABCDEFG\x1b[201~");
        await h.draw();
        await h.resize(45, 2);
        await h.draw();
        const y = h.tui
          .getScreenLines()
          .findIndex((line) =>
            line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").startsWith("G"),
          );
        assert.ok(y >= 0);
        h.send(0, { x: 0, y }, "M");
        h.send(0, { x: 0, y }, "m");
        if (scenario === "coalesced") {
          h.input("\x1b[D");
          h.input("\x1b[A");
        } else h.input(scenario === "rebound-up" ? "\x10" : "\x1b[A");
        h.input("X");
        await h.draw();
        await h.resize(45, 130);
        h.input("\r");
        assert.equal(
          (h.result() as { feedback?: string }).feedback,
          scenario === "coalesced"
            ? "स्त्र\nABCXDEFG"
            : scenario === "rebound-up"
              ? "स्त्र\nABCDEXFG"
              : "स्त्र\nABCDEFGX",
        );
      } finally {
        kb.setUserBindings(original);
        h.component.dispose?.();
        h.tui.stop();
      }
    });

for (const kind of ["create", "tweak"] as const)
  test(`${kind} vertical navigation skips native padding and reaches next logical line`, async () => {
    const h = await setup(0, kind, false, true, kind === "tweak" && "views");
    try {
      h.input("\x1b[B");
      h.input("\r");
      h.input("\x1b[200~स्त्र\nA\nBCDE\x1b[201~");
      await h.draw();
      await h.resize(45, 2);
      await h.draw();
      const y = h.tui
        .getScreenLines()
        .findIndex((line) =>
          line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").startsWith("A"),
        );
      assert.ok(y >= 0);
      h.send(0, { x: 0, y }, "M");
      h.send(0, { x: 0, y }, "m");
      await h.draw();
      for (let i = 0; i < 4; i++) {
        h.input("\x1b[B");
        await h.draw();
      }
      h.input("X");
      await h.draw();
      await h.resize(45, 130);
      h.input("\r");
      const feedback = (h.result() as { feedback?: string }).feedback!;
      assert.match(feedback, /^स्त्र\nA\nB?C?D?E?X/);
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

test("oversized grapheme first fragment survives narrow width roundtrip", async () => {
  const h = await setup(0, "tweak", false, false, "narrow-anchor");
  try {
    await h.resize(5, 1);
    let found = false;
    for (let i = 0; i < 200; i++) {
      await h.draw();
      const lines = h.tui.getScreenLines();
      if (
        lines.some((line) =>
          line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").startsWith("<"),
        )
      ) {
        found = true;
        break;
      }
      h.input("\x1b[1;5B");
    }
    assert.ok(found, "first escape fragment reachable");
    await h.resize(5, 2);
    await h.draw();
    assert.match(h.screen(), /甲/);
    await h.resize(5, 1);
    await h.draw();
    assert.match(h.screen(), /</);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

test("production confirmation frames distinguish hard breaks and NBSP at 119/120", async () => {
  for (const [columns, n] of [
    [122, 117],
    [123, 118],
  ] as const) {
    const p = "P".repeat(n),
      old = `begin\n${p}  甲\nend`,
      next = `begin\n${p}\n甲\nend`;
    const frames: string[] = [];
    for (const candidate of [old, next]) {
      const h = await setup(0, "tweak", false, false, "frame", false, {
        before: old,
        candidate,
      });
      try {
        await h.resize(45, columns);
        h.input("\x1b[B");
        h.input("\x1b[B");
        h.input("\x1b[B");
        h.input("\r");
        await h.draw();
        frames.push(h.screen().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
      } finally {
        h.component.dispose?.();
        h.tui.stop();
      }
    }
    assert.notEqual(frames[0], frames[1], `hard newline at ${columns}`);
    assert.ok(frames[1]!.includes("⏎"));
  }
  for (const [columns, n] of [
    [122, 116],
    [123, 55],
    [123, 117],
  ] as const) {
    const p = "P".repeat(n),
      old = `begin\n${p}甲\nend`,
      candidate = `begin\n${p}\u00a0甲\nend`;
    const h = await setup(0, "tweak", false, false, "frame", false, {
      before: old,
      candidate,
    });
    try {
      await h.resize(45, columns);
      await h.draw();
      const view = h.screen();
      assert.ok(view.includes("00A0⟧"), `NBSP diff ${columns}/${n}`);
      h.input("\x1b[B");
      h.input("\x1b[B");
      h.input("\x1b[B");
      h.input("\r");
      await h.draw();
      assert.ok(h.screen().includes("00A0⟧"), `NBSP full ${columns}/${n}`);
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  }
});

test("production full task frames distinguish lightweight setting from title suffix", async () => {
  for (const columns of [122, 123]) {
    const frames: string[] = [];
    for (const taskMode of ["before", "after"] as const) {
      const h = await setup(0, "tweak", false, false, "frame", false, {
        before: "same",
        candidate: "same",
        taskMode,
      });
      try {
        await h.resize(45, columns);
        h.input("\x1b[B");
        h.input("\x1b[B");
        h.input("\x1b[B");
        h.input("\r");
        await h.draw();
        frames.push(h.screen());
      } finally {
        h.component.dispose?.();
        h.tui.stop();
      }
    }
    assert.notEqual(frames[0], frames[1]);
    assert.match(frames[0]!, /"Write docs \(lightweight subtasks\)"/);
    assert.match(frames[1]!, /"Write docs" \(lightweight subtasks\)/);
  }
});

test("production full frames distinguish empty objective from literal empty label", async () => {
  for (const columns of [122, 123]) {
    const screens: string[] = [];
    for (const candidate of [
      "Verification contract: Run tests",
      "(empty)\nVerification contract: Run tests",
    ]) {
      const h = await setup(0, "tweak", false, false, "frame", false, {
        before: "original",
        candidate,
      });
      try {
        await h.resize(45, columns);
        h.input("\x1b[B");
        h.input("\x1b[B");
        h.input("\x1b[B");
        h.input("\r");
        await h.draw();
        screens.push(h.screen());
      } finally {
        h.component.dispose?.();
        h.tui.stop();
      }
    }
    assert.notEqual(screens[0], screens[1], `empty vs literal at ${columns}`);
    assert.ok(screens[0]!.includes("⟦EMPTY OBJECTIVE⟧"));
    assert.ok(screens[1]!.includes("(empty)"));
  }
});

test("boundary wheel down then up before redraw moves up one", async () => {
  const h = await setup(0, "tweak");
  try {
    for (let i = 0; i < 80; i++) h.send(65, { x: 20, y: 10 }, "M");
    await h.draw();
    const before = Number(h.screen().match(/▲ (\d+) more/)?.[1]);
    assert.ok(before > 0);
    h.send(65, { x: 20, y: 10 }, "M");
    h.send(64, { x: 20, y: 10 }, "M");
    await h.draw();
    assert.equal(Number(h.screen().match(/▲ (\d+) more/)?.[1]), before - 1);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const kind of ["create", "tweak"] as const)
  test(`production viewport ${kind} keeps controls above ten footer rows`, async () => {
    const h = await setup(10, kind);
    try {
      assert.ok(h.point().y < 35);
      if (kind === "tweak") h.point("View the full modified goal");
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

test("production viewport valid native click survives a normal redraw", async () => {
  const h = await setup(0);
  try {
    const p = h.point();
    h.send(0, p, "M");
    h.send(0, p, "m");
    await h.draw();
    await new Promise((r) => setTimeout(r, 560));
    assert.equal(h.done(), true);
  } finally {
    h.component.dispose?.();
    h.tui.stop();
  }
});

for (const phase of ["pressed", "pending"] as const)
  test(`production editor Container origin round-trip invalidates ${phase}`, async () => {
    const h = await setup(0);
    try {
      const p = h.point();
      h.send(0, p, "M");
      if (phase === "pending") h.send(0, p, "m");
      await h.setFooter(1);
      assert.notEqual(
        h.point().y,
        p.y,
        "the footer must move the screen target",
      );
      await h.setFooter(0);
      assert.equal(h.point().y, p.y);
      if (phase === "pressed") h.send(0, p, "m");
      await new Promise((r) => setTimeout(r, 560));
      assert.equal(h.done(), false, "stale press/pending click revived");
    } finally {
      h.component.dispose?.();
      h.tui.stop();
    }
  });

for (const gesture of ["task press", "audit press", "audit pending"] as const) {
  test(`production Goal-X dock layout invalidates ${gesture}`, async () => {
    let input = (_data: string) => {};
    const terminal = {
      columns: 100,
      rows: 36,
      kittyProtocolActive: true,
      start(fn: typeof input) {
        input = fn;
      },
      stop() {},
      write() {},
      hideCursor() {},
      showCursor() {},
      moveBy() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
    };
    const tui = new TuiAltScreen(terminal as never, false, undefined, {
      mouse: true,
      copyOnSelect: false,
    });
    const host = tui as unknown as { doRender(): void };
    const originalDraw = host.doRender;
    const draw = () => host.doRender();
    const goal = createGoal({
      objective: "Dock layout",
      autoContinue: false,
      sisyphus: false,
    });
    goal.taskList = {
      tasks: [{ id: "current", title: "Current task", status: "pending" }],
      proposedAt: goal.createdAt,
      blockCompletion: false,
    };
    goal.currentTaskId = "current";
    const audit = gesture.startsWith("audit");
    let toggles = 0;
    const widget = new GoalWidgetComponent({
      tui: createInteractiveTuiReference(() => tui),
      theme: createMockTheme(),
      getGoal: () => goal,
      getAuditorProgress: () =>
        audit
          ? { phase: "running", elapsedMs: 0, attemptId: "a", recentOutput: [] }
          : null,
      getExpanded: () => toggles % 2 === 1,
      onToggleExpanded: () => {
        toggles++;
      },
    });
    let acceptedClicks = 0;
    const handleMouse = widget.handleMouse.bind(widget);
    widget.handleMouse = (event) => {
      const result = handleMouse(event);
      if (event.type === "click" && result?.handled) acceptedClicks++;
      return result;
    };
    const widgetsAbove = new Container();
    widgetsAbove.addChild({
      render: () => ["another widget"],
      invalidate() {},
    });
    widgetsAbove.addChild(widget);
    let editorRows = 3;
    const empty = { render: () => [], invalidate() {} };
    const viewport = createChatViewport({
      document: {
        render: () => Array.from({ length: 50 }, (_, i) => `chat ${i}`),
        invalidate() {},
      },
      pendingMessages: empty,
      status: empty,
      widgetsAbove,
      editor: {
        render: () => Array.from({ length: editorRows }, () => "editor"),
        invalidate() {},
      },
      footer: empty,
    });
    const label = audit ? "[展开清单]" : "[展开]";
    const point = () => {
      const lines = tui.getScreenLines();
      const y = lines.findIndex(
        (line) => line.startsWith("╰") && line.includes(label),
      );
      assert.ok(y >= 0, lines.join("\n"));
      return { x: visibleWidth(lines[y]!.split(label)[0]!), y };
    };
    const send = (p: { x: number; y: number }, suffix: "M" | "m") =>
      input(`\x1b[<0;${p.x + 1};${p.y + 1}${suffix}`);
    const pending = gesture.endsWith("pending");
    const auditDelay = () => new Promise((resolve) => setTimeout(resolve, 570));
    try {
      tui.setLayoutRoot(viewport.root);
      tui.start();
      draw();
      draw();
      const old = point();
      send(old, "M");
      if (pending) {
        send(old, "m");
        assert.equal(acceptedClicks, 1, "native click is now queued");
      }
      editorRows = 5;
      draw();
      assert.equal(point().y, old.y - 2, "the editor moved the painted footer");
      if (!pending) {
        editorRows = 3;
        draw();
        assert.deepEqual(
          point(),
          old,
          "the footer is back at the original point",
        );
        send(old, "m");
      }
      // Allow both Pi’s double-click window and a queued audit click to expire.
      await auditDelay();
      assert.equal(toggles, 0, "reflow invalidates the old gesture");
      // A same-size paint, unlike a dock relocation, keeps a fresh gesture.
      const fresh = point();
      send(fresh, "M");
      draw();
      send(fresh, "m");
      draw();
      if (audit) await auditDelay();
      assert.equal(toggles, 1, "a valid click survives ordinary redraws");
    } finally {
      widget.dispose();
      assert.equal(host.doRender, originalDraw);
      tui.stop();
    }
  });
}
