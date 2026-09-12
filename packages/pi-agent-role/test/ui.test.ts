import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { describe, expect, it } from "vitest";

import { pickOption, type PickerOption } from "../src/ui.ts";

/** Real terminal input sequences, as `matchesKey` expects them. */
const INPUT = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  ctrlC: "\x03",
} as const;

interface Harness {
  ctx: ExtensionContext;
  rendered(): string;
  press(data: string): void;
  result: Promise<string | undefined>;
}

function makeHarness(
  title: string,
  options: readonly PickerOption<string>[],
  status?: string,
): Harness {
  let component:
    | { render(width: number): string[]; handleInput(data: string): void }
    | undefined;
  let resolveResult: (value: string | undefined) => void = () => {};
  const result = new Promise<string | undefined>((resolve) => {
    resolveResult = resolve;
  });

  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory: unknown) => {
        const create = factory as (
          tui: { requestRender(): void },
          theme: { fg(color: string, value: string): string },
          keybindings: unknown,
          done: (value: string | undefined) => void,
        ) => {
          render(width: number): string[];
          handleInput(data: string): void;
        };
        component = create(
          { requestRender() {} },
          { fg: (_color, value) => value },
          {},
          resolveResult,
        );
        return result;
      },
    },
  } as unknown as ExtensionContext;

  void pickOption(ctx, title, options, status);

  return {
    ctx,
    result,
    rendered: () => (component?.render(80) ?? []).join("\n"),
    press: (data: string) => component?.handleInput(data),
  };
}

const OPTIONS: PickerOption<string>[] = [
  {
    value: "worker",
    label: "worker",
    hint: "Implements tasks",
    badges: ["sandbox: strict"],
  },
  { value: "reviewer", label: "reviewer", current: true },
  { value: "none", label: "none — clear", danger: true },
];

/** Same list without a current marker, so selection arrows are unambiguous. */
const PLAIN_OPTIONS: PickerOption<string>[] = [
  {
    value: "worker",
    label: "worker",
    hint: "Implements tasks",
    badges: ["sandbox: strict"],
  },
  { value: "reviewer", label: "reviewer" },
  { value: "none", label: "none — clear", danger: true },
];

describe("role picker", () => {
  it("renders the title, status, badges, and the current marker", () => {
    const harness = makeHarness("Session role", OPTIONS, "agent worker");

    const rendered = harness.rendered();

    expect(rendered).toContain("Session role");
    expect(rendered).toContain("agent worker");
    expect(rendered).toContain("worker");
    expect(rendered).toContain("[sandbox: strict]");
    expect(rendered).toContain("Implements tasks");
    expect(rendered).toContain("● reviewer");
    expect(rendered).toContain("↑↓ / jk navigate");
  });

  it("moves the selection with arrows and confirms with enter", async () => {
    const harness = makeHarness("Session role", PLAIN_OPTIONS);

    harness.press(INPUT.down);
    expect(harness.rendered()).toContain("→ reviewer");

    harness.press(INPUT.down);
    expect(harness.rendered()).toContain("→ none — clear");

    harness.press(INPUT.up);
    expect(harness.rendered()).toContain("→ reviewer");

    harness.press(INPUT.enter);

    await expect(harness.result).resolves.toBe("reviewer");
  });

  it("supports jk navigation", async () => {
    const harness = makeHarness("Session role", PLAIN_OPTIONS);

    harness.press("j");
    harness.press("j");
    expect(harness.rendered()).toContain("→ none — clear");

    harness.press("k");
    expect(harness.rendered()).toContain("→ reviewer");

    harness.press(INPUT.enter);

    await expect(harness.result).resolves.toBe("reviewer");
  });

  it("does not move past the ends of the list", () => {
    const harness = makeHarness("Session role", PLAIN_OPTIONS);

    harness.press(INPUT.up);
    expect(harness.rendered()).toContain("→ worker");

    for (let index = 0; index < 5; index += 1) harness.press(INPUT.down);
    expect(harness.rendered()).toContain("→ none — clear");
  });

  it("cancels on escape and ctrl+c", async () => {
    const escaped = makeHarness("Session role", PLAIN_OPTIONS);
    escaped.press(INPUT.escape);
    await expect(escaped.result).resolves.toBeUndefined();

    const interrupted = makeHarness("Session role", PLAIN_OPTIONS);
    interrupted.press(INPUT.ctrlC);
    await expect(interrupted.result).resolves.toBeUndefined();
  });
});
