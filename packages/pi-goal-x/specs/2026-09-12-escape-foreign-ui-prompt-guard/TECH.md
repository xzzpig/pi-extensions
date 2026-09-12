# Escape-owns-the-dialog guard — technical design

## Core signal

pi core (>= 0.84.4) wraps every blocking extension UI call in the outermost
span and dispatches two lifecycle events to extensions:

- `ui_prompt_start` — `{ type, reason: "ui_prompt", kind: "select" | "confirm"
  | "input" | "editor" | "custom", title? }`
- `ui_prompt_end` — same payload shape, emitted when the outermost span closes.

The wrapper lives on the shared runner UI context (`wrapUIPromptContext` →
`withUIPrompt`), so the span is **process-global across extensions**: a dialog
opened by pi-subagents, pi-ask, pi-permission-system, pi-sandbox, or any other
extension opens the span the goal extension observes. `uiPromptDepth` is
runner-scoped, so a nested `ctx.ui.*` call from inside a dialog does not emit a
second start (only the outermost call emits), which is why a plain depth
counter cannot over-count from nesting.

### Timing (why the counter is correct for key handling)

`emitUIPromptEvent` schedules delivery with `queueMicrotask`, and
`ui_prompt_start` is scheduled *before* the dialog component is installed.
Both mean the counter settles long before a human keypress:

| moment | counter | notes |
| --- | --- | --- |
| `ctx.ui.confirm(...)` called | 0 | start queued as a microtask |
| microtask flush | 1 | dialog already installed; user cannot have pressed a key yet |
| user presses Escape | 1 | pi-tui runs input listeners first → guard yields, dialog closes |
| dialog promise resolves (`.finally(finish)`) | 1 → 0 | end queued as a microtask |
| user presses Escape again | 0 | normal goal semantics restored |

Tests that drive input synthetically must `await Promise.resolve()` (or a
`setTimeout(0)`) after firing a start/end event so the microtask queue flushes
before asserting.

## Changes

### `extensions/goal-state.ts`

Add a `uiPromptDepth` counter next to `goalModalDepth`, with the same shape as
the existing modal-depth API (reset-safe clamping):

```ts
let uiPromptDepth = 0;

function enterUiPrompt(): void { uiPromptDepth++; }
function exitUiPrompt(): void { uiPromptDepth = Math.max(0, uiPromptDepth - 1); }
function resetUiPromptDepth(): void { uiPromptDepth = 0; }
```

Expose on `GoalCore`: `uiPromptDepth` (getter/setter for tests, mirroring
`goalModalDepth`), `enterUiPrompt()`, `exitUiPrompt()`, `resetUiPromptDepth()`.
Clamping at 0 makes an unmatched `ui_prompt_end` (host bug, or an end arriving
after a reset) harmless; the session reset makes a leaked span unable to
disable the goal's keys forever.

### `extensions/goal-events.ts`

Register two handlers once, at extension install time, alongside the other
`pi.on` registrations:

```ts
pi.on("ui_prompt_start", async () => { core.enterUiPrompt(); });
pi.on("ui_prompt_end", async () => { core.exitUiPrompt(); });
```

Reset the counter at both session boundaries (the two places that already reset
session-scoped runtime state):

- `session_start` — `core.resetUiPromptDepth()`
- `session_shutdown` — `core.resetUiPromptDepth()`

`session_tree` does not reset: it does not tear down the UI surface, and a
dialog cannot survive a tree switch.

### `extensions/goal-widget.ts`

Extend the single early-return guard in `syncTerminalInputPause`'s
`onTerminalInput` handler:

```ts
if (core.goalModalDepth > 0 || core.uiPromptDepth > 0 || core.goalTui?.hasOverlay?.()) return undefined;
```

Because this is the shared guard at the top of the handler, both affected
branches are covered at once (and every other goal keybinding stays inert while
a dialog owns the keyboard, matching the semantic already documented for
goal-owned modals and TUI overlays):

- `matchesKey(data, "escape") && core.auditProgress` → `abortAudit` is no longer
  reached while a dialog is open;
- `matchesKey(data, "escape") && goal active && autoContinue` →
  `pauseActiveGoal` plus the pass-through that aborts the current turn is no
  longer reached while a dialog is open.

Update the surrounding comment so the invariant names all three sources.

### `package.json` (pi-goal-x)

`ui_prompt_start`/`ui_prompt_end` exist in `@earendil-works/pi-coding-agent`
types from 0.84.4 onward; the package currently pins devDependency `^0.84.1`
with peer `>=0.83.0 <0.85.0`.

- `devDependencies["@earendil-works/pi-coding-agent"]`: `^0.85.1` (matches
  pi-notify and pi-starline; the running host is 0.85.1).
- `peerDependencies["@earendil-works/pi-coding-agent"]`: `>=0.84.4` (matches
  pi-notify's floor).
- `pi-tui` ranges are unchanged: the guard uses the already-typed
  `hasOverlay()`.
- `pnpm install` refreshes `pnpm-lock.yaml`; the workspace already resolves
  0.85.1 for other packages, so no new network dependency is introduced.

## Test plan

`tests/goal-modal-escape.test.ts` (harness with the real extension, mock `pi.on`
registry, `onTerminalInput` capture) gains a foreign-prompt group. Because the
harness `pi.on` recorder is a plain map, the test invokes the recorded
`ui_prompt_start`/`ui_prompt_end` handlers directly and flushes microtasks,
which reproduces core's dispatch.

Cases:

1. Active goal + foreign prompt open → Escape returns `undefined`, no
   `"Goal paused."` notification; after `ui_prompt_end` → Escape pauses again.
2. A running audit (mock `runCompletionAuditor` held open through the injection
   point used by `tests/e2e/goal-lifecycle-dashboard.test.ts`, so
   `auditProgress` is live) + foreign prompt open → Escape does **not** abort
   the audit (the audit still settles); after `ui_prompt_end` → Escape aborts it.
3. Depth clamping: a stray `ui_prompt_end` (or two) never drives the depth
   negative and never unblocks Escape while a real dialog is still open.
4. Session reset: `session_start` clears a leaked depth, so Escape works in the
   new session.
5. Regression: with no dialog open, the three existing
   `goal-modal-escape.test.ts` behaviors are unchanged.

## Verification commands

```bash
pnpm --filter @xzzpig/pi-goal-x run typecheck
pnpm --filter @xzzpig/pi-goal-x test
pnpm exec prettier --check .
```

`packages/pi-goal-x` is excluded from the root prettier check
(`.prettierignore`), so the third command is a repository-level regression
check; the package's own toolchain (eslint) is used on changed files.

### Test-environment prerequisites (see PRODUCT.md "Approved scope additions")

The suite only runs here because of two dependency changes; without them the
baseline at `HEAD` fails 57/75 files:

- `packages/pi-goal-x` resolves `@xzzpig/pi-subagents` through `workspace:*`
  (registry 0.10.0 ships raw `.ts` under `node_modules`, which Node 24 refuses
  to type-strip).
- `packages/pi-subagents` devDependencies pin one `@earendil-works/pi-ai`
  instance (`^0.85.1`), so the workspace link cannot surface the duplicated
  `AssistantMessageEventStream` declaration that already broke that package's
  own `typecheck` at `HEAD`.

## Real-runtime validation

Per the `pi-plugin-e2e-test` skill: a throwaway environment loads (a) a wrapper
extension that re-exports goal-x's extension with a slow injected
`runCompletionAuditor`, so a real audit stays in flight, and (b) a second
extension exposing a slash command that opens a real `ctx.ui.confirm`. With a
focused, active goal, request completion (audit starts), open the foreign
dialog, press Escape: the dialog closes and the audit keeps running; press
Escape again: the audit is cancelled. Evidence is the recorded tmux transcript
plus the extension/pi logs.
