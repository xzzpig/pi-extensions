import assert from "node:assert/strict";
import test from "node:test";
import { SessionTranscript } from "@xzzpig/pi-components/transcript";
import { openAuditorTranscriptOverlay } from "../extensions/widgets/auditor-transcript-overlay.ts";

test("auditor transcript overlay focuses, scrolls with the mouse, and closes on Escape", async () => {
  const transcript = new SessionTranscript();
  transcript.appendCompletedTurn({
    user: "Audit this goal",
    assistant: [
      "Checking the evidence.",
      ...Array.from({ length: 30 }, (_value, index) => `Evidence line ${index + 1}.`),
    ].join("\n"),
  });

  let component: { render(width: number): string[]; handleInput(data: string): void; dispose?(): void } | undefined;
  let doneCalls = 0;
  let closeObserverCalls = 0;
  let resolveCustom: (() => void) | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  const requestRenderCalls: unknown[] = [];
  const terminalWrites: string[] = [];
  let focused = false;
  let hidden = false;
  const handle = {
    focus: () => { focused = true; },
    hide: () => { hidden = true; },
  };
  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory: any, options: any) => {
        capturedOptions = options;
        return new Promise<void>((resolve) => {
          resolveCustom = resolve;
          const done = () => {
            doneCalls++;
            component?.dispose?.();
            resolve();
          };
          component = factory(
            {
              requestRender: () => { requestRenderCalls.push(undefined); },
              mode: "regular",
              terminal: { write: (data: string) => { terminalWrites.push(data); } },
            },
            {
              fg: (_color: string, value: string) => value,
              bg: (_color: string, value: string) => value,
              bold: (value: string) => value,
            },
            {},
            done,
          );
          options.onHandle(handle);
        });
      },
      notify: () => {},
    },
  } as any;

  const overlay = openAuditorTranscriptOverlay(ctx, {
    transcript,
    getStatus: () => "Inspecting files... (25%)",
    onClose: () => {
      closeObserverCalls++;
    },
  });

  await Promise.resolve();
  assert.ok(overlay);
  assert.equal(capturedOptions?.overlay, true);
  assert.deepEqual(capturedOptions?.overlayOptions, {
    anchor: "top-center",
    width: "82%",
    minWidth: 56,
    maxHeight: "82%",
    margin: { top: 1, left: 2, right: 2 },
    nonCapturing: true,
  });
  assert.equal(focused, true);
  const latest = component?.render(100).join("\n") ?? "";
  assert.match(latest, /Completion audit transcript/);
  assert.match(latest, /Evidence line 30/);
  assert.match(latest, /down 0/);

  component?.handleInput("\x1b[<64;1;1M");
  const scrolled = component?.render(100).join("\n") ?? "";
  assert.match(scrolled, /down [1-9]/);
  assert.equal(requestRenderCalls.length, 1);

  overlay?.refresh();
  assert.equal(requestRenderCalls.length, 2);

  component?.handleInput("\x1b");
  assert.equal(doneCalls, 1);
  assert.equal(closeObserverCalls, 1);
  assert.equal(hidden, true);
  assert.deepEqual(terminalWrites, [
    "\x1b[?1000h\x1b[?1006h",
    "\x1b[?1000l\x1b[?1006l",
  ]);
  resolveCustom?.();
});
