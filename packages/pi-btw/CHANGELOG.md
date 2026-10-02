# Changelog

All notable changes to the `@xzzpig/pi-btw` fork are documented here. This
fork tracks [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw) via git
subtree; entries below describe only fork-specific deviations from upstream.

## 0.10.0

### Changed

- **Synced upstream `v0.6.1` → `v0.7.1`**, adopting the opt-in headless
  extension tools for `/btw`, `/side`, and `/btw:tangent` (btw.json extension
  allowlists, separate BTW cache for remote sources, child-lifecycle
  startup/shutdown) and the child capability-claims fix. The pi-components
  transcript migration and outcome threading were re-applied onto the new
  session-options shape (`builtinTools`/`noTools`, the four-argument
  `createBtwResourceLoader`), keeping the `[BTW SESSION BOUNDARY]` marker and
  the model-runtime sharing spreads.
- Peer dependencies follow the workspace Pi 1.0.0 baseline (`>=1.0.0 <2`),
  devDependencies moved to the pnpm catalog; the upstream `package-lock.json`
  resurrection was deleted again per the standing knownDebt.

## 0.8.1

### Changed

- **Conflict-surface refactor, no behavior change.** Fork-only cleanup of `extensions/btw.ts`: dead `removeTranscriptTurn` import removed, in-code SAFETY annotations removed. The transcript overlay now caches rendered lines per state-mutation version and width, so streaming frames no longer re-run the full markdown render of the whole thread (output is unchanged).
- The npm package no longer ships the deregistered `skills/` directory, and the stale `package-lock.json` (pinned to an old `@xzzpig/pi-components`, unparseable with `catalog:` devDependencies) was deleted; this pnpm monorepo never reads it.

## 0.8.0

### Changed

- **Synced upstream `v0.4.1` → `v0.5.0`**, adopting the new features: `Alt+w`
  full-width overlay toggle, abort-first Escape while streaming, configurable
  `PI_BTW_FOCUS_KEYS` focus shortcuts, Markdown rendering in the overlay,
  custom-provider support in BTW sub-sessions, subscription/keyless model
  auth, mouse-scroll preservation across TUI modes, overlay double-close
  fix, RPC-host note surfacing, and the bundled `btw` skill in the npm
  package. Turn endings now record an outcome (`completed`/`aborted`/
  `failed`).
- **The fork keeps its pi-components migration on top of the upstream
  rewrite.** Upstream's own overlay transcript builder
  (`buildOverlayTranscript` + per-entry helpers) is not adopted; rendering
  stays on `@xzzpig/pi-components`'s shared `renderTranscriptLines` (already
  markdown-aware via Pi's native components). The new outcome semantics were
  added as an optional `outcome` field on turn-boundary entries in
  `@xzzpig/pi-components` (`TranscriptTurnOutcome`, `finishTurn` third
  parameter) so aborted/failed turns render and are counted consistently
  with upstream.

## 0.7.1

### Changed

- Removed the unused BTW skill registration from the published package.
- Corrected npm installation instructions to use `npm:@xzzpig/pi-btw`.

### Fixed

- **Prevented contextual BTW sessions from resuming main-session work.** Each
  new contextual BTW child session now inserts one internal
  `[BTW SESSION BOUNDARY]` instruction after inherited main-session context and
  before the BTW conversation. The marker is not rendered in the overlay or
  included in inject/summarize handoffs; tangent sessions do not receive it and
  follow-up turns do not duplicate it.

## 0.7.0

### Changed

- **Migrated to the shared builder API.** The hand-written transcript state
  machine (~200 lines: `appendTranscriptEntry`, `ensureTranscriptTurn`,
  `finishTranscriptTurn`, `removeTranscriptTurn`, `findLatestTranscriptEntry`
  and the upsert helpers) was removed in favor of `@xzzpig/pi-components`'s
  public builder exports (`appendEntry`, `ensureTurn`, `finishTurn`,
  `findLatestEntry`, `ensureToolCall`, `upsertText`, `upsertToolResult`,
  `removeTranscriptTurn`, `hasStreamingTranscriptEntry`); entry/state types
  now alias the library's `TranscriptEntry`/`TranscriptState`. Behavior is
  equivalent (58/58 tests match the pre-migration baseline).
- `@xzzpig/pi-components` is declared via `bundledDependencies` (stays
  private, never published to npm) and bumped to 0.3.0, which also stops
  tool-call backgrounds being reset to the dark theme in the main session
  after opening a thread (the shared theme is probed, never re-initialized).

## 0.6.0

### Changed

- **Native tool call rendering.** BTW threads now render tool calls through
  Pi's native `ToolExecutionComponent` (bundled
  `@xzzpig/pi-components@0.2.0`) instead of a summarized badge/preview row.
  Built-in tools keep their main-transcript output; output stays collapsed by
  default, matching the main transcript.
- Transcript entries store raw provider `args` and structured tool results;
  component instances are pruned together with their entries when turns are
  removed or history is trimmed.
- The bundled `@xzzpig/pi-components` now ships its runtime as TypeScript
  source, so the overlay shares the host's core-package module instances in
  every load layout. Prototype patches from other plugins (pi-starline's
  user-message rail, pi-tool-display's message box) now apply to BTW threads
  when extensions are mixed from local paths and npm installs.

### Fixed

- The overlay attaches its live TUI to the tool component registry
  (`attachTui`), so streaming tool output repaints while a command is still
  running instead of appearing only after completion.

## 0.5.2

### Fixed

- **Pi package dependency bundling.** BTW now bundles compiled
  `@xzzpig/pi-components@0.1.1` into its tarball. The published manifest has
  no pnpm-only `workspace:*` protocol and Pi's npm installer no longer needs a
  separately installed shared package.

## 0.5.1

### Changed

- **Shared transcript runtime.** The BTW overlay now consumes
  `@xzzpig/pi-components` for its bounded session transcript and Pi-native
  transcript rendering. BTW retains ownership of its composer, side-thread
  lifecycle, focus controls, and its existing mouse-scroll behavior.

## 0.5.0

### Added

- **Overlay renders user/assistant messages with the main-window markdown
  pipeline.** The BTW popup now renders user and assistant messages through
  `@earendil-works/pi-coding-agent`'s `UserMessageComponent` /
  `AssistantMessageComponent` (with `getMarkdownTheme()`), so headings, fenced
  code blocks with syntax highlighting, lists, tables, and block quotes match
  the main session instead of leaking raw markdown source. Thinking blocks are
  rendered with the main-window thinking style. Tool-call/result rows stay
  textual.

### Changed

- **Raised peer dependency floor to `>=0.83.0 <1`** for
  `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
  `@earendil-works/pi-tui`: the overlay now statically imports the main-window
  message components.

## 0.4.1

### Fixed

- **Fullscreen TUI mouse-mode conflict (scrolling broken after closing the BTW
  overlay).** In fullscreen (alt-screen) mode, `@earendil-works/pi-tui` owns
  terminal mouse-reporting modes (`?1000`/`?1006`/`?1002`/`?1004`) and enters
  them exactly once on start, never re-asserting them. The BTW overlay's
  constructor and `dispose()` wrote `?1000h ?1006h` / `?1000l ?1006l`
  unconditionally, so closing the overlay disabled the modes pi-tui relies on
  to parse wheel events and scroll the message view — leaving the transcript
  unscrollable for the rest of the session.

  The overlay now only opts in to mouse reporting when pi-tui is **not**
  managing it (`tui.mode !== "fullscreen"`), and `dispose()` only undoes the
  modes it actually enabled. In fullscreen mode pi-tui already forwards wheel
  events to a focused overlay, so the writes were unnecessary there anyway.
  `tui.mode` is read defensively so the code still compiles against pi-tui
  versions that predate the `mode` property.

- **Type-check against the catalog-pinned pi-coding-agent SDK.** The upstream
  `btw.ts` referenced APIs that the monorepo's catalog-pinned
  `@earendil-works/pi-coding-agent@0.83.0` / `pi-tui@0.83.0` no longer (or not
  yet) expose, so `pnpm --filter @xzzpig/pi-btw run typecheck` failed on a clean
  import. Resolved the drift without changing runtime behavior:
  - `createBtwResourceLoader` now implements the two `ResourceLoader` members
    added by 0.83.0 — `getSystemPromptSource()` (returns `undefined`) and
    `getAppendSystemPromptSources()` (returns `[]`) — so the inline BTW system
    prompt still flows via `getSystemPrompt()`/`getAppendSystemPrompt()`.
  - `createAgentSession({ modelRegistry: ctx.modelRegistry as
    AgentSession["modelRegistry"] })` referenced a non-existent type/option in
    both call sites; it is redundant because BTW resolves auth up front via
    `ctx.modelRegistry.getApiKeyAndHeaders(model)` and the SDK builds its own
    model runtime. The option is no longer forwarded.
  - Updated the sub-session creation test to assert the option is not passed.

### Fork metadata

- Initial fork of upstream `dbachelder/pi-btw` at tag `v0.4.1`
  (commit `4f858102706910ee9d520a9666832f3103631b61`), imported via
  `git subtree add --squash`.
- npm package name renamed from `pi-btw` to `@xzzpig/pi-btw` per the monorepo
  fork convention.
