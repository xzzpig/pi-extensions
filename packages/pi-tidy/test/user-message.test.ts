/**
 * The "rail" user message: rules above and below, an accent `│` in front of
 * every content row, pi's own Markdown child doing the text.
 */

import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "node:test";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
let colorMode = "truecolor";
const fakeTheme = {
  fg: (color: string, text: string) => {
    if (color.startsWith("#")) throw new Error(`Unknown theme color: ${color}`);
    return `<fg:${color}>${text}</fg>`;
  },
  bg: (_color: string, text: string) => `\x1b[48;5;60m${text}\x1b[49m`,
  bold: (text: string) => `<b>${text}</b>`,
  getColorMode: () => colorMode,
};
(globalThis as any)[THEME_KEY] = fakeTheme;

const { patchUserMessages, patchContainerBoxes } = await import("../src/frame.ts");
const { USER_MESSAGE_TIME } = await import("../src/messages/user-message.ts");
const { formatMessageTime } = await import("../src/draw/frame-draw.ts");
const { tidyEnabled } = await import("../src/live.ts");
const { InteractiveMode, UserMessageComponent } = await import("@earendil-works/pi-coding-agent");

const BG_FILL_RE = /\x1b\[48;[0-9;]*m|\x1b\[(?:4[0-7]|10[0-7])m/;
const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
const W = 40;

const RAIL = { style: "rail", railColor: "railCol", ruleColor: "ruleCol", paddingY: 1, icons: false, time: true, align: "left", timeFormat: "auto", headerStyle: "inline" } as const;
const USER_ICON = "\u{f007}";

function plain(line: string): string {
  return line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/<\/?[^>]+>/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

// First in the file: the patch stays once installed, and frame tests below install it too.
test("the rail style records when a message was sent, with no frame style in sight", () => {
  const proto: any = InteractiveMode.prototype;
  const original = proto.addMessageToChat;
  proto.addMessageToChat = function (this: any) {
    this.chatContainer.children.push(new UserMessageComponent("hi" as never));
  };
  try {
    patchUserMessages(RAIL);
    const chat = { children: [] as any[] };
    proto.addMessageToChat.call({ chatContainer: chat }, { role: "user", timestamp: 1234 });
    assert.equal(chat.children[0][USER_MESSAGE_TIME], 1234);
  } finally {
    proto.addMessageToChat = original;
  }
});

test("a short message: rules, padding rows and the rail, full width and no background", () => {
  patchUserMessages(RAIL);
  const lines: string[] = new UserMessageComponent("hi" as never).render(W);

  assert.equal(lines.length, 5, "rule, pad, text, pad, rule");
  assert.equal(lines[0], `${ZONE_START}<fg:ruleCol>${"─".repeat(W)}</fg>`);
  assert.equal(lines.at(-1), `${ZONE_END}<fg:ruleCol>${"─".repeat(W)}</fg>`);
  assert.equal(lines[1], "<fg:railCol>│</fg>", "padding row is the rail alone");
  assert.equal(plain(lines[2]).trimEnd(), "│ hi");
  assert.ok(lines[2].startsWith("<fg:railCol>│</fg> "), "one space between rail and text");
  assert.ok(!BG_FILL_RE.test(lines.join("\n")), "no background fill escapes");
});

test("the child's padding comes off behind the resets pi puts in front of it", () => {
  // What pi's Markdown really hands over once its background is gone: `\x1b[49m \x1b[39mtext`.
  (globalThis as any)[THEME_KEY] = { ...fakeTheme, bg: (_color: string, text: string) => `\x1b[49m${text}\x1b[49m` };
  try {
    patchUserMessages({ ...RAIL, paddingY: 0 });
    const lines: string[] = new UserMessageComponent("hi" as never).render(W);
    assert.equal(plain(lines[1]!).trimEnd(), "│ hi");
  } finally {
    (globalThis as any)[THEME_KEY] = fakeTheme;
  }
});

test("paddingY 0 drops the rail-only rows", () => {
  patchUserMessages({ ...RAIL, paddingY: 0 });
  const lines: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.deepEqual(lines.map(plain).map((l) => l.trimEnd()), ["─".repeat(W), "│ hi", "─".repeat(W)]);
});

test("multi-line markdown keeps its rows and every row carries the rail", () => {
  patchUserMessages({ ...RAIL, paddingY: 0 });
  const lines: string[] = new UserMessageComponent("first\n\n- one\n- two" as never).render(W);
  const body = lines.slice(1, -1).map(plain);
  assert.ok(body.every((l) => l.startsWith("│ ")), "rail on every content row");
  assert.ok(body.some((l) => l.includes("first")));
  assert.ok(body.some((l) => l.includes("one")) && body.some((l) => l.includes("two")));
});

test("registered markdown transformers still run", () => {
  patchUserMessages({ ...RAIL, paddingY: 0 });
  // Short: the fake theme's tags count as visible text, so long rows wrap.
  const transformer = (markdown: string) => `${markdown} (t)`;
  const component = new (UserMessageComponent as any)("hi", undefined, 1, [transformer]);
  assert.ok(component.render(W).map(plain).join("\n").includes("hi (t)"));
});

/** Real width: the fake theme's tags would count as visible text. */
function withAnsiTheme<T>(run: () => T): T {
  (globalThis as any)[THEME_KEY] = { ...fakeTheme, fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m` };
  try {
    return run();
  } finally {
    (globalThis as any)[THEME_KEY] = fakeTheme;
  }
}

function timed(text: string, timestamp: number) {
  const component: any = new UserMessageComponent(text as never);
  component[USER_MESSAGE_TIME] = timestamp;
  return component;
}

test("with icons, the user icon and the time sit in the top rule, not in the text", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  const now = Date.now();
  const rows: string[] = withAnsiTheme(() => timed("first\nsecond", now).render(W).map(plain));
  const label = `${USER_ICON} ${formatMessageTime(now)}`;
  assert.deepEqual(rows.map((row) => row.trimEnd()), [
    `─ ${label} ${"─".repeat(W - 3 - label.length)}`,
    "│ first",
    "│ second",
    "─".repeat(W),
  ]);
  assert.equal(rows[0]!.length, W);
});

test("a right-aligned label moves along the rule; the rail and the text stay left", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true, align: "right" });
  const now = Date.now();
  const rows: string[] = withAnsiTheme(() => timed("hi", now).render(W).map(plain));
  const label = `${USER_ICON} ${formatMessageTime(now)}`;
  assert.equal(rows[0], `${"─".repeat(W - 3 - label.length)} ${label} ─`);
  assert.equal(rows[1]!.trimEnd(), "│ hi");
});

test("`time: false` leaves the icon alone in the rule, and re-renders a cached message", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  const component = timed("hi", Date.now());
  const top = () => withAnsiTheme(() => plain(component.render(W)[0]));
  assert.ok(top().includes(formatMessageTime(Date.now())));
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true, time: false });
  assert.match(top(), new RegExp(`^─ ${USER_ICON} ─+$`));
});

test("changing the alignment re-renders a cached message", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  const component = timed("hi", Date.now());
  const top = () => withAnsiTheme(() => plain(component.render(W)[0]));
  assert.ok(top().startsWith("─ "));
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true, align: "right" });
  assert.ok(top().endsWith(" ─"));
});

test("without icons the rule stays plain, time or no time", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: false });
  assert.equal(plain(timed("hi", Date.now()).render(W)[0]), "─".repeat(W));
});

test("a label that does not fit leaves a plain rule", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  const rows: string[] = withAnsiTheme(() => timed("hi", Date.now()).render(8).map(plain));
  assert.equal(rows[0], "─".repeat(8));
});

test("a day rolling over brings the date into the label", (t) => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  const dayMs = 86_400_000;
  const start = new Date(2026, 10, 5, 12, 0).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const component = timed("hi", start);
  const top = () => withAnsiTheme(() => plain(component.render(W)[0]));
  assert.ok(top().includes("12:00"));
  assert.ok(!top().includes("11-05"));
  t.mock.timers.setTime(start + dayMs);
  assert.ok(top().includes("11-05 12:00"));
});

test("the frame style hides its time the same way", () => {
  const colors = { user: "userCol", custom: "customCol" };
  patchUserMessages({ ...RAIL, style: "frame" });
  try {
    patchContainerBoxes(colors, { icons: true, includeUser: true });
    const component = timed("hi", Date.now());
    const top = () => withAnsiTheme(() => plain(component.render(W)[0]));
    assert.ok(top().includes(formatMessageTime(Date.now())));
    patchContainerBoxes(colors, { icons: true, includeUser: true, userTime: false });
    assert.match(top(), new RegExp(`^╭─ ${USER_ICON} ─+╮$`));
  } finally {
    patchContainerBoxes(colors, { includeUser: false });
  }
});

test("switching icons on and off re-renders a cached message", () => {
  patchUserMessages({ ...RAIL, paddingY: 0, icons: false });
  const component = new UserMessageComponent("hi" as never);
  assert.ok(!component.render(W).join("").includes(USER_ICON));
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true });
  assert.ok(component.render(W)[0].includes(USER_ICON));
});

test("hex colors paint truecolor, or the nearest 256-color entry in 256-color mode", () => {
  patchUserMessages({ ...RAIL, railColor: "#cba6f7", ruleColor: "#fff", paddingY: 0 });
  const truecolor: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.ok(truecolor[1].startsWith("\x1b[38;2;203;166;247m│\x1b[39m"));
  assert.ok(truecolor[0].includes("\x1b[38;2;255;255;255m─"));

  colorMode = "256color";
  try {
    const indexed: string[] = new UserMessageComponent("hi" as never).render(W);
    assert.ok(indexed[1].startsWith("\x1b[38;5;183m│"), indexed[1]);
    assert.ok(indexed[0].includes("\x1b[38;5;231m─"), "white is the cube's corner");
  } finally {
    colorMode = "truecolor";
  }
});

test("an unknown color name leaves the cell unpainted instead of breaking the render", () => {
  patchUserMessages({ ...RAIL, railColor: "#nothex", paddingY: 0 });
  const lines: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.equal(plain(lines[1]).trimEnd(), "│ hi");
});

test("an unchanged message hits the cache; new options do not", () => {
  patchUserMessages(RAIL);
  const component = new UserMessageComponent("hi" as never);
  const first = component.render(W);
  assert.strictEqual(component.render(W), first, "same array on a hit");
  patchUserMessages({ ...RAIL, paddingY: 0 });
  assert.equal(component.render(W).length, 3, "padding change re-renders");
  patchUserMessages({ ...RAIL, paddingY: 0, railColor: "otherCol" });
  assert.ok(component.render(W)[1].startsWith("<fg:otherCol>│"), "color change re-renders");
});

test("off, frame and tidy.enabled: false all pass through to the render underneath", () => {
  patchUserMessages({ ...RAIL, style: "off" });
  assert.ok(!new UserMessageComponent("hi" as never).render(W).some((l) => l.includes("railCol")), "off");

  patchUserMessages({ ...RAIL, style: "frame" });
  patchContainerBoxes({ user: "userCol", custom: "customCol" }, { includeUser: true });
  const framed: string[] = new UserMessageComponent("hi" as never).render(W);
  assert.ok(framed.some((l) => l.includes("<fg:userCol>╭")), "frame style draws the rounded frame");
  assert.ok(!framed.some((l) => l.includes("railCol")), "and no rail");

  patchContainerBoxes({ user: "userCol", custom: "customCol" }, { includeUser: false });
  patchUserMessages(RAIL);
  tidyEnabled.set(false);
  try {
    assert.ok(!new UserMessageComponent("hi" as never).render(W).some((l) => l.includes("railCol")), "disabled");
  } finally {
    tidyEnabled.set(true);
  }
  assert.ok(new UserMessageComponent("hi" as never).render(W)[0].includes("ruleCol"), "rail again once re-enabled");
});

test("pi's OSC 133 markers stay on the first and last line only", () => {
  patchUserMessages(RAIL);
  const lines: string[] = new UserMessageComponent("a\n\nb" as never).render(W);
  assert.ok(lines[0].startsWith(ZONE_START) && lines.at(-1)!.startsWith(ZONE_END));
  assert.ok(lines.slice(1, -1).every((l) => !l.includes("\x1b]133;")), "no markers in between");
});

test("a rail message's time follows the format, and a new format is not served from the cache", () => {
  const component: any = new UserMessageComponent("hi" as never);
  component[USER_MESSAGE_TIME] = new Date(2026, 10, 5, 13, 9, 32).getTime();
  const top = (): string => withAnsiTheme(() => plain(component.render(W)[0]));
  patchUserMessages({ ...RAIL, icons: true, timeFormat: "HH:mm" });
  assert.ok(top().includes("13:09"));
  assert.ok(!top().includes("13:09:32"));
  patchUserMessages({ ...RAIL, icons: true, timeFormat: "M月D日 HH:mm:ss" });
  assert.ok(top().includes("11月5日 13:09:32"));
});

test("a split header sets a rule between the icon and the time, and fits a narrow rule", () => {
  const component: any = new UserMessageComponent("hi" as never);
  component[USER_MESSAGE_TIME] = new Date(2026, 10, 5, 13, 9, 32).getTime();
  const top = (width: number): string => withAnsiTheme(() => plain(component.render(width)[0]));
  patchUserMessages({ ...RAIL, icons: true, timeFormat: "HH:mm", headerStyle: "split" });
  assert.ok(top(W).startsWith(`── ${USER_ICON} ── 13:09 ─`), top(W));
  assert.ok(top(W).endsWith("─"));
  assert.equal(visibleWidth(top(W)), W);
  // `── ` + icon + ` ── ` + clock + ` ──` no longer fits: the plain label instead.
  assert.ok(top(16).startsWith(`─ ${USER_ICON} 13:09 ─`), top(16));
  assert.equal(visibleWidth(top(16)), 16);
});

test("the rules style is the rail without its glyph, at either end", () => {
  const component: any = new UserMessageComponent("first\nsecond" as never);
  component[USER_MESSAGE_TIME] = new Date(2026, 10, 5, 13, 9).getTime();
  const rows = (): string[] => withAnsiTheme(() => component.render(W).map(plain));
  for (const align of ["left", "right"] as const) {
    patchUserMessages({ ...RAIL, style: "rules", paddingY: 0, icons: true, timeFormat: "HH:mm", align });
    const out = rows().map((row) => row.trimEnd());
    assert.ok(out[0]!.includes(`${USER_ICON} 13:09`));
    assert.deepEqual(out.slice(1), [" first", " second", "─".repeat(W)]);
  }
  // Switching style on a /reload is not served the rail's cached rows.
  patchUserMessages({ ...RAIL, paddingY: 0, icons: true, timeFormat: "HH:mm" });
  assert.equal(rows()[1]!.trimEnd(), "│ first");
});
