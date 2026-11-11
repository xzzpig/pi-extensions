import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { createMockExtensionContext, createMockTheme, createMockTUI, type MockExtensionContext } from "./tui-test-utils.ts";
import {
	showTweakProposalDialog,
	type TweakProposalDialogOptions,
	type TweakProposalDialogResult,
} from "../extensions/goal-tweak-confirmation.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

type DialogComponent = Component & { handleInput(data: string): void };

/**
 * Open the real host entry against a functional `ui.custom` mock: the factory
 * is invoked exactly as the host would invoke it and its `done` callback
 * resolves the `showTweakProposalDialog` promise.
 */
function openDialog(
	options: TweakProposalDialogOptions,
	args: { rows?: number; baseFrameLines?: number; ctx?: MockExtensionContext; width?: number } = {},
): {
	ctx: MockExtensionContext;
	component: DialogComponent;
	tui: TUI;
	result: Promise<TweakProposalDialogResult>;
	settled: () => boolean;
	render: (width?: number) => string[];
	keys: (data: string) => void;
} {
	const ctx = args.ctx ?? createMockExtensionContext();
	let component: DialogComponent | undefined;
	let tui: TUI | undefined;
	let settled = false;
	(ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => new Promise<TweakProposalDialogResult | undefined>((resolve) => {
		const mock = createMockTUI(args.rows !== undefined ? { terminalRows: args.rows } : {});
		tui = mock.tui;
		if (args.baseFrameLines !== undefined) {
			(tui as unknown as { previousLines?: string[] }).previousLines = Array.from({ length: args.baseFrameLines }, () => "x");
		}
		component = factory(tui, createMockTheme(), {} as KeybindingsManager, (value: unknown) => {
			settled = true;
			resolve(value as TweakProposalDialogResult | undefined);
		}) as DialogComponent;
	})) as ExtensionUIContext["custom"];
	const result = showTweakProposalDialog(ctx, options);
	assert.ok(component, "the tweak confirmation opens a custom dialog");
	assert.ok(tui, "the custom dialog receives a TUI");
	const dialog = component;
	const terminal = tui;
	return {
		ctx,
		component: dialog,
		tui: terminal,
		result,
		settled: () => settled,
		render: (width = 100) => dialog.render(width),
		// Mirror the host render loop: a key handled by the dialog is followed by
		// a render, which is where selection-follow scroll state is consumed.
		keys: (data) => {
			dialog.handleInput(data);
			if (!settled) dialog.render(args.width ?? 100);
		},
	};
}

function joined(lines: string[]): string {
	return lines.join("\n");
}

test("opens on the diff view with tweak-specific wording and the existing decision semantics", async () => {
	const calls: boolean[] = [];
	const h = openDialog({
		presentation: (auditorEnabled) => {
			calls.push(auditorEnabled);
			return { diffText: "- old objective line\n+ new objective line", fullText: "FULL-CONTENT-MARKER" };
		},
		defaultAuditorEnabled: true,
	});
	const text = joined(h.render(100));
	assert.match(text, /Goal tweak confirmation/);
	assert.match(text, /Changes from the current goal \(diff\)/);
	assert.match(text, /- old objective line/);
	assert.match(text, /\+ new objective line/);
	assert.doesNotMatch(text, /FULL-CONTENT-MARKER/, "the default view is the diff, not the full text");
	assert.match(text, /View the full modified goal \(read-only\)/);
	assert.match(text, /Confirm — apply this tweak/);
	assert.match(text, /Continue chatting — keep refining/);
	assert.match(text, /Cancel — discard this tweak/);
	assert.doesNotMatch(text, /create/i, "an existing-goal tweak never claims to create a goal");
	assert.deepEqual(calls, [true], "presentation is built once for the initial auditor choice");

	h.keys(ENTER);
	const result = await h.result;
	assert.deepEqual(result, { decision: "confirm", auditorEnabled: true, unavailable: false });
});

test("the full/diff view toggle is focusable and read-only, with independent scroll positions", async () => {
	const diff = Array.from({ length: 80 }, (_, i) => `diff line ${i}`).join("\n");
	const full = Array.from({ length: 80 }, (_, i) => `full line ${i}`).join("\n");
	const calls: boolean[] = [];
	const h = openDialog({
		presentation: (auditorEnabled) => {
			calls.push(auditorEnabled);
			return { diffText: diff, fullText: full };
		},
		defaultAuditorEnabled: true,
	}, { rows: 24 });

	assert.match(joined(h.render(100)), /diff line 0/);
	for (let i = 0; i < 3; i++) h.keys(DOWN);
	assert.equal(h.settled(), false, "navigating to the read-only control does not resolve the dialog");
	h.keys(PAGE_UP);
	h.keys(PAGE_UP);
	const diffScrolled = joined(h.render(100));
	assert.doesNotMatch(diffScrolled, /diff line 0/, "the diff view scrolled away from its top");
	const diffOffset = Number(diffScrolled.match(/▲ (\d+) more/)?.[1]);
	assert.ok(diffOffset > 0, "the scrolled diff advertises the hidden lines");

	h.keys(ENTER);
	assert.equal(h.settled(), false, "switching to the full text never resolves the decision");
	const fullTop = joined(h.render(100));
	assert.match(fullTop, /Modified goal — full effective content/);
	assert.match(fullTop, /full line 0/, "the untouched full view starts at its own top");
	assert.deepEqual(calls, [true], "read-only view switches do not rebuild the presentation");

	h.keys(PAGE_DOWN);
	h.keys(PAGE_DOWN);
	const fullOffset = Number(joined(h.render(100)).match(/▲ (\d+) more/)?.[1]);
	assert.ok(fullOffset > 0, "the full view has its own scroll position");

	h.keys(ENTER);
	const diffAgain = joined(h.render(100));
	assert.doesNotMatch(diffAgain, /diff line 0/);
	assert.equal(Number(diffAgain.match(/▲ (\d+) more/)?.[1]), diffOffset, "returning to the diff restores its scroll position");
	assert.equal(h.settled(), false);
});

test("auditor changes rebuild both views while the view, selection, and feedback draft survive", async () => {
	const calls: boolean[] = [];
	const h = openDialog({
		presentation: (auditorEnabled) => {
			calls.push(auditorEnabled);
			return {
				diffText: auditorEnabled ? "AUD-ON-DIFF" : "AUD-OFF-DIFF",
				fullText: auditorEnabled ? "AUD-ON-FULL" : "AUD-OFF-FULL",
			};
		},
		defaultAuditorEnabled: true,
	}, { rows: 30 });
	assert.match(joined(h.render(100)), /AUD-ON-DIFF/);
	h.keys("a");
	assert.deepEqual(calls, [true, false], "the audit toggle re-evaluates the presentation callback");
	const afterToggle = joined(h.render(100));
	assert.match(afterToggle, /AUD-OFF-DIFF/);
	assert.match(afterToggle, /Auditor disabled/);

	for (let i = 0; i < 3; i++) h.keys(DOWN);
	h.keys(ENTER);
	assert.match(joined(h.render(100)), /AUD-OFF-FULL/);
	h.keys("a");
	const rebuiltFull = joined(h.render(100));
	assert.match(rebuiltFull, /AUD-ON-FULL/, "the full view reflects the newly selected auditor value");
	assert.doesNotMatch(rebuiltFull, /AUD-OFF/, "stale presentation text is not kept");
	assert.deepEqual(calls, [true, false, true]);

	h.keys(UP);
	h.keys(UP);
	h.keys(ENTER);
	assert.match(joined(h.render(100)), /refinement feedback/);
	h.keys("tighten the acceptance criteria");
	assert.match(joined(h.render(100)), /tighten the acceptance criteria/);
	h.keys(ESCAPE);
	assert.equal(h.settled(), false, "Escape in the feedback editor returns to the decisions");
	assert.match(joined(h.render(100)), /Confirm — apply this tweak/);

	// Toggle the view and back: the typed draft is still there.
	h.keys(DOWN);
	h.keys(DOWN);
	h.keys(ENTER);
	h.keys(ENTER);
	h.keys(UP);
	h.keys(UP);
	h.keys(ENTER);
	assert.match(joined(h.render(100)), /tighten the acceptance criteria/);
	h.keys(ENTER);
	const result = await h.result;
	assert.deepEqual(result, {
		decision: "continue",
		auditorEnabled: true,
		unavailable: false,
		feedback: "tighten the acceptance criteria",
	});
});

test("continue accepts an empty feedback editor without confirming", async () => {
	const h = openDialog({
		presentation: () => ({ diffText: "- old\n+ new", fullText: "FULL" }),
		defaultAuditorEnabled: true,
	}, { rows: 30 });
	h.keys(DOWN);
	h.keys(ENTER);
	assert.match(joined(h.render(100)), /Feedback \(optional — empty continues without text\)/);
	h.keys(ENTER);
	const result = await h.result;
	assert.equal(result.decision, "continue");
	assert.equal(result.unavailable, false);
	assert.equal("feedback" in result, false);
});

test("Escape means continue chatting, never cancel", async () => {
	const h = openDialog({
		presentation: () => ({ diffText: "- old\n+ new", fullText: "FULL" }),
		defaultAuditorEnabled: true,
	});
	h.keys(ESCAPE);
	const result = await h.result;
	assert.deepEqual(result, { decision: "continue", auditorEnabled: true, unavailable: false });
});

test("cancel and confirm resolve their own decisions with the current auditor value", async () => {
	const options: TweakProposalDialogOptions = {
		presentation: () => ({ diffText: "- old\n+ new", fullText: "FULL" }),
		defaultAuditorEnabled: true,
	};

	const cancelled = openDialog(options);
	cancelled.keys(DOWN);
	cancelled.keys(DOWN);
	cancelled.keys(ENTER);
	assert.deepEqual(await cancelled.result, { decision: "cancel", auditorEnabled: true, unavailable: false });

	const confirmed = openDialog(options);
	confirmed.keys("a");
	confirmed.keys(ENTER);
	assert.deepEqual(await confirmed.result, { decision: "confirm", auditorEnabled: false, unavailable: false });
});

test("long content stays fully reachable and decision controls stay visible in a narrow, short terminal", async () => {
	const diff = Array.from({ length: 120 }, (_, i) => `- change ${i} ${"detail ".repeat(8)}`).join("\n");
	const h = openDialog({
		presentation: () => ({ diffText: diff, fullText: "FULL" }),
		defaultAuditorEnabled: true,
	}, { rows: 14, width: 40 });

	const seen = new Set<string>();
	for (let step = 0; step < 40; step++) {
		const lines = h.render(40);
		assert.ok(lines.length <= 10, "the dialog never exceeds the terminal-height bound");
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 40, `line fits the narrow terminal: ${JSON.stringify(line)}`);
			seen.add(line);
		}
		h.keys(PAGE_DOWN);
	}
	const all = joined([...seen]);
	for (let i = 0; i < 120; i++) assert.ok(all.includes(`change ${i} `), `change ${i} is reachable by scrolling`);
	assert.match(all, /Confirm — apply this tweak/, "the confirm control is reachable");
	assert.match(all, /Cancel — discard this tweak/, "the cancel control is reachable");
	assert.match(all, /Enter select/, "the decision footer is reachable");
	assert.match(all, /more · PgUp\/PgDn scroll/, "clipped content advertises how to scroll");
});

test("narrow and wide renders both stay inside their width and show the same content", () => {
	const h = openDialog({
		presentation: () => ({ diffText: "- old objective\n+ new objective", fullText: "FULL" }),
		defaultAuditorEnabled: true,
	});
	const wide = h.render(100);
	const narrow = h.render(30);
	const tiny = h.render(12);
	assert.ok(wide.every((line) => visibleWidth(line) <= 100));
	assert.ok(narrow.every((line) => visibleWidth(line) <= 30));
	assert.ok(tiny.every((line) => visibleWidth(line) <= 12));
	assert.match(joined(wide), /- old objective/);
	assert.match(joined(narrow), /- old objective/);
	assert.match(joined(tiny), /old/);
});

/* eslint-disable no-control-regex -- these assertions verify untrusted control sequences are inert */
test("terminal control sequences in proposal text are displayed inertly", () => {
	const h = openDialog({
		presentation: () => ({
			diffText: "\u001b[31m- red line\u001b[0m\r\n\u001b]0;owned-title\u0007+ blue\u009b2J line\n\u001b_pi:c\u0007tail",
			fullText: "FULL",
		}),
		defaultAuditorEnabled: true,
	});
	const text = joined(h.render(60));
	// Theme/truncation helpers may add their own safe SGR resets; the injected
	// instructions themselves must never survive.
	assert.doesNotMatch(text, /\u001b\[31m/);
	assert.doesNotMatch(text, /\u001b\]0;owned-title/);
	assert.doesNotMatch(text, /\u001b\[2J/);
	assert.doesNotMatch(text, /\u001b_pi:c/);
	assert.doesNotMatch(text, /\u0007/);
	assert.doesNotMatch(text, /\r/);
	assert.doesNotMatch(text, /owned-title/);
	assert.match(text, /red line/);
	assert.match(text, /blue line/);
	assert.match(text, /tail/);
});
/* eslint-enable no-control-regex */

test("basic select fallback offers read-only views, the audit toggle, and optional feedback", async () => {
	const ctx = createMockExtensionContext();
	delete (ctx.ui as unknown as { custom?: unknown }).custom;
	const prompts: Array<{ prompt: string; options: string[] }> = [];
	const selectAnswers = [
		"View the full modified goal (read-only)",
		"Toggle completion auditor (currently enabled)",
		"Back to the change diff (read-only)",
		"Continue chatting — keep refining",
	];
	(ctx.ui as unknown as { select: ExtensionUIContext["select"] }).select = async (prompt, options) => {
		prompts.push({ prompt, options });
		return selectAnswers.shift();
	};
	const inputPrompts: Array<{ prompt: string; placeholder?: string }> = [];
	(ctx.ui as unknown as { input: ExtensionUIContext["input"] }).input = async (prompt, placeholder) => {
		inputPrompts.push({ prompt, placeholder });
		return "adjust the acceptance tests";
	};
	const calls: boolean[] = [];
	const result = await showTweakProposalDialog(ctx, {
		presentation: (auditorEnabled) => {
			calls.push(auditorEnabled);
			return { diffText: "BASIC-DIFF", fullText: "BASIC-FULL" };
		},
		defaultAuditorEnabled: true,
	});

	assert.deepEqual(result, {
		decision: "continue",
		auditorEnabled: false,
		unavailable: false,
		feedback: "adjust the acceptance tests",
	});
	assert.deepEqual(calls, [true, false], "the fallback audit toggle rebuilds the presentation");
	assert.equal(prompts.length, 4);
	assert.match(prompts[0]!.prompt, /BASIC-DIFF/);
	assert.ok(prompts[0]!.options.includes("View the full modified goal (read-only)"));
	assert.match(prompts[1]!.prompt, /BASIC-FULL/);
	assert.match(prompts[1]!.prompt, /Auditor: enabled/);
	assert.match(prompts[2]!.prompt, /Auditor: disabled/);
	assert.match(prompts[3]!.prompt, /BASIC-DIFF/);
	assert.equal(inputPrompts.length, 1);
	assert.match(inputPrompts[0]!.prompt, /Continue chatting — type the adjustment/);
	assert.equal(inputPrompts[0]!.placeholder, "Adjustment (optional)");
});

test("basic fallback keeps continue working when the host cannot collect feedback", async () => {
	const ctx = createMockExtensionContext();
	delete (ctx.ui as unknown as { custom?: unknown }).custom;
	delete (ctx.ui as unknown as { input?: unknown }).input;
	(ctx.ui as unknown as { select: ExtensionUIContext["select"] }).select = async () => "Continue chatting — keep refining";
	const result = await showTweakProposalDialog(ctx, {
		presentation: () => ({ diffText: "DIFF", fullText: "FULL" }),
		defaultAuditorEnabled: false,
	});
	assert.deepEqual(result, { decision: "continue", auditorEnabled: false, unavailable: false });
});

test("unsupported hosts return unavailable and are never silently approved", async (t) => {
	const noUi = createMockExtensionContext();
	noUi.hasUI = false;
	let presentationCalls = 0;
	const noUiResult = await showTweakProposalDialog(noUi, {
		presentation: () => {
			presentationCalls++;
			return { diffText: "DIFF", fullText: "FULL" };
		},
		defaultAuditorEnabled: true,
	});
	assert.deepEqual(noUiResult, { decision: "continue", auditorEnabled: true, unavailable: true });
	assert.equal(presentationCalls, 0);

	const noDialogs = createMockExtensionContext();
	delete (noDialogs.ui as unknown as { custom?: unknown }).custom;
	delete (noDialogs.ui as unknown as { select?: unknown }).select;
	assert.deepEqual(
		await showTweakProposalDialog(noDialogs, { presentation: () => ({ diffText: "DIFF", fullText: "FULL" }), defaultAuditorEnabled: false }),
		{ decision: "continue", auditorEnabled: false, unavailable: true },
	);

	const previous = process.env.PI_GOAL_AUTO_CONFIRM;
	process.env.PI_GOAL_AUTO_CONFIRM = "1";
	try {
		assert.equal((await showTweakProposalDialog(noUi, { presentation: () => ({ diffText: "DIFF", fullText: "FULL" }), defaultAuditorEnabled: true })).unavailable, true);
	} finally {
		if (previous === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM;
		else process.env.PI_GOAL_AUTO_CONFIRM = previous;
	}
	void t;
});

test("a host that cannot render the custom component falls back to the native decision loop", async () => {
	const ctx = createMockExtensionContext();
	(ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => new Promise<TweakProposalDialogResult | undefined>((resolve) => {
		// A render callback in place of a TUI: the factory must bail with
		// done(undefined) instead of rendering or approving.
		factory({} as TUI, createMockTheme(), {} as KeybindingsManager, (value: unknown) => resolve(value as TweakProposalDialogResult | undefined));
	})) as ExtensionUIContext["custom"];
	(ctx.ui as unknown as { select: ExtensionUIContext["select"] }).select = async () => "Confirm — apply this tweak";

	const result = await showTweakProposalDialog(ctx, {
		presentation: () => ({ diffText: "DIFF", fullText: "FULL" }),
		defaultAuditorEnabled: true,
	});
	assert.deepEqual(result, { decision: "confirm", auditorEnabled: true, unavailable: false });
});

test("a renderer that throws degrades to the native decision loop instead of approving", async () => {
	const ctx = createMockExtensionContext();
	(ctx.ui as unknown as { custom: ExtensionUIContext["custom"] }).custom = (async () => {
		throw new Error("renderer unavailable");
	}) as ExtensionUIContext["custom"];
	const notices: string[] = [];
	(ctx.ui as unknown as { notify: ExtensionUIContext["notify"] }).notify = (message) => {
		notices.push(message);
	};
	(ctx.ui as unknown as { select: ExtensionUIContext["select"] }).select = async () => "Cancel — discard this tweak";

	const result = await showTweakProposalDialog(ctx, {
		presentation: () => ({ diffText: "DIFF", fullText: "FULL" }),
		defaultAuditorEnabled: true,
	});
	assert.deepEqual(result, { decision: "cancel", auditorEnabled: true, unavailable: false });
	assert.ok(notices.some((message) => message.includes("falling back to basic dialogs")));
});

test("a very tall proposal remains windowed without argument-spread overflow", async () => {
	const text = Array.from({ length: 130_000 }, (_, index) => `+ row-${index}`).join("\n");
	const h = openDialog({ presentation: () => ({ diffText: text, fullText: text }), defaultAuditorEnabled: true }, { rows: 30 });
	assert.ok(h.render(80).length <= 30);
	h.keys(ESCAPE);
	assert.equal((await h.result).decision, "continue");
});
