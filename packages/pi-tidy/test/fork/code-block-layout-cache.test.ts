import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { setClipboardWriter } from "../../src/clipboard.ts";
import { disableHoverForTests, enableHoverForTests, resetHover } from "../../src/hover.ts";
import { visibleText } from "../../src/draw/frame-draw.ts";
import { presentTurn } from "../../src/turns/turn-view.ts";
import { TurnStore, turnOptions, turnStore } from "../../src/turns/turn-state.ts";
import { chipLabels } from "../../src/turns/code-blocks.ts";

initTheme("dark");

const CHIP = chipLabels(true).copy;
const FIRST = "const first = 1;\nconsole.log(first);";
const SECOND = "const second = 2;\nconsole.log(second);";
const USER = { role: "user", content: "show code", timestamp: 1000 };

function fixture(text: string) {
  const previousOptions = turnOptions.get();
  const previousStore = turnStore.get();
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: true,
    replyStyle: "frame",
    codeBlocks: true,
    splitDiff: false,
    icons: true,
  });
  const message: any = {
    role: "assistant",
    provider: "anthropic",
    model: "cache-test",
    timestamp: 1100,
    durationMs: 100,
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(1000);
  store.note(USER as any);
  store.note(message);
  store.settle(false, 1200);
  const answer = new AssistantMessageComponent(message, true);
  const chat = new Container();
  chat.addChild(transcriptView(answer));
  const rows = chat.render(100);
  const hook = (answer as any)[Symbol.for("pi-tidy:code-blocks")];
  assert.ok(hook?.ruleRowsMemo, "the final reply established a code-rule layout cache");
  return { answer, chat, hook, message, store, rows, restore: () => { turnOptions.set(previousOptions); turnStore.set(previousStore); } };
}

function transcriptView(answer: AssistantMessageComponent) {
  return {
    render: (width: number) => presentTurn(answer, width, (drawWidth) => answer.render(drawWidth)),
    invalidate() {},
    handleMouse: (event: any) => answer.handleMouse(event),
  };
}

function click(chat: Container, x: number, y: number, height: number) {
  return chat.handleMouse({
    type: "click", button: "left", x, y, screenX: x, screenY: y,
    width: 100, height, shift: false, alt: false, ctrl: false,
  });
}

test("stable code layout is reused and invalidated by content, width, and render options", async (t) => {
  const text = ["Before", "", "```ts", FIRST, "```", "", "Between", "", "```ts", SECOND, "```", "", "After"].join("\n");
  const { answer, chat, hook, message, store, rows, restore } = fixture(text);
  t.after(restore);
  const firstMemo = hook.ruleRowsMemo;

  assert.equal(chat.render(100)[0], rows[0]);
  assert.equal(hook.ruleRowsMemo, firstMemo, "stable redraw reuses the derived rule/chip row scan");

  const rendered = chat.render(100).map(visibleText);
  assert.equal(rendered.filter((line) => line.includes(CHIP)).length, 2, "both blocks retain their copy chips");
  const written: string[] = [];
  setClipboardWriter(async (value) => { written.push(value); });
  enableHoverForTests();
  resetHover();
  try {
    const y = rendered.findIndex((line) => line.includes(CHIP));
    const x = rendered[y]!.indexOf(CHIP);
    chat.handleMouse({
      type: "move", button: "none", x, y, screenX: x, screenY: y,
      width: 100, height: rendered.length, shift: false, alt: false, ctrl: false,
    });
    const hovered = chat.render(100).find((line) => line.includes(CHIP))!;
    assert.ok(hovered.includes("\x1b[48;"), "the cached chip span still drives hover paint");
    click(chat, x, y, rendered.length);
    await new Promise((resolve) => setImmediate(resolve));
    const secondY = rendered.findIndex((line, index) => index > y && line.includes(CHIP));
    click(chat, rendered[secondY]!.indexOf(CHIP), secondY, rendered.length);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [FIRST, SECOND], "each cached span copies its matching block text");
  } finally {
    setClipboardWriter(undefined);
    resetHover();
    disableHoverForTests();
  }

  const widthMemo = hook.ruleRowsMemo;
  chat.render(80);
  assert.notEqual(hook.ruleRowsMemo, widthMemo, "a width change invalidates row positions");

  const contentMemo = hook.ruleRowsMemo;
  const updatedText = text.replace(SECOND, "const second = 200;\nconsole.log(second);");
  message.content = [{ type: "text", text: updatedText }];
  store.note(message);
  answer.updateContent(message, false);
  chat.render(80);
  assert.notEqual(hook.ruleRowsMemo, contentMemo, "a changed message invalidates the cached scan");

  const optionsMemo = hook.ruleRowsMemo;
  turnOptions.set({ ...turnOptions.get(), icons: false });
  chat.render(80);
  assert.notEqual(hook.ruleRowsMemo, optionsMemo, "a render option change invalidates the cached scan");
});

test("streaming code blocks prune superseded token versions and copy the current text", async (t) => {
  const previousOptions = turnOptions.get();
  const previousStore = turnStore.get();
  t.after(() => { turnOptions.set(previousOptions); turnStore.set(previousStore); });
  turnOptions.set({
    ...turnOptions.get(),
    collapseTurns: "afterRun",
    frameFinalReply: true,
    replyStyle: "frame",
    codeBlocks: true,
    splitDiff: false,
    icons: true,
  });
  const store = new TurnStore();
  turnStore.set(store);
  store.begin(2000);
  store.note({ role: "user", content: [{ type: "text", text: "review stream" }], timestamp: 2000 } as any);

  let firstText = "const first = 0;";
  let secondText = "const second = 0;";
  const message: any = {
    role: "assistant", provider: "anthropic", model: "stream-cache", timestamp: 2100,
    stopReason: "toolUse",
    content: [{ type: "text", text: `\`\`\`typescript\n${firstText}\n\`\`\`\n\n\`\`\`typescript\n${secondText}\n\`\`\`` }],
  };
  store.note(message);
  const answer = new AssistantMessageComponent(message, true);
  answer.updateContent(message, true);
  const chat = new Container();
  chat.addChild(transcriptView(answer));
  chat.render(100);
  const hook = (answer as any)[Symbol.for("pi-tidy:code-blocks")];
  assert.ok(hook?.built instanceof Map, "the Markdown hook owns the derived token cache");

  for (let update = 1; update <= 30; update++) {
    firstText = `const first = ${update};`;
    secondText = `const second = ${update};`;
    message.content = [{ type: "text", text: `\`\`\`typescript\n${firstText}\n\`\`\`\n\n\`\`\`typescript\n${secondText}\n\`\`\`` }];
    store.note(message);
    answer.updateContent(message, true);
    chat.render(100);
    assert.equal(hook.built.size, 2, "only the two currently present code tokens remain cached");
    const keys = [...hook.built.keys()];
    assert.ok(keys.some((key: string) => key.includes(firstText)), "the first current token is cached");
    assert.ok(keys.some((key: string) => key.includes(secondText)), "the second current token is cached");
    if (update > 1) {
      assert.ok(!keys.some((key: string) => key.includes(`const first = ${update - 1};`)), "the superseded prefix is released");
      assert.ok(!keys.some((key: string) => key.includes(`const second = ${update - 1};`)), "the other superseded prefix is released");
    }
  }

  message.stopReason = "stop";
  message.durationMs = 100;
  store.note(message, true);
  store.settle(false, 2200);
  answer.updateContent(message, false);
  const rows = chat.render(100).map(visibleText);
  const written: string[] = [];
  setClipboardWriter(async (value) => { written.push(value); });
  try {
    const chips = rows.map((line, y) => ({ line, y })).filter(({ line }) => line.includes(CHIP));
    assert.equal(chips.length, 2, rows.join("\n"));
    for (const { line, y } of chips) {
      const x = line.indexOf(CHIP);
      click(chat, x, y, rows.length);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(written, [firstText, secondText], "only the latest token text is copied from each chip");
    assert.equal(hook.built.size, 2, "settling keeps the cache bounded by the current blocks");
  } finally {
    setClipboardWriter(undefined);
  }
});
