# Changelog

All notable changes to the internal `@xzzpig/pi-components` shared library are
documented here.

## 0.4.0

### Added

- **`appendText` and `appendAssistantMessage` builder helpers.** `upsertText`
  is documented as latest-wins merging, which is right for repeated updates of
  one message but collapses a replayed turn that contains several distinct
  assistant messages into its final message. The new helpers append one entry
  per message, so every thinking block and answer survives a replay of
  persisted records.
- `TranscriptRenderOptions.hideThinkingBlock` renders assistant thinking blocks
  collapsed to `thinkingLabel`, letting hosts that replay completed transcripts
  own their expansion gesture (the collapsed label doubles as its hint).
  Omitted keeps Pi's default: expanded.

### Changed

- `upsertText` now documents when appending is required instead of merging.

## 0.3.0

### Added

- **Public builder API for historical-record ingestion.** The entry-state
  operations previously private to the module are now exported so hosts can
  construct transcripts from persisted records instead of live agent events:
  `appendEntry`, `ensureTurn`, `finishTurn`, `findLatestEntry`,
  `ensureToolCall`, `upsertText`, `upsertToolResult`, and `appendNotice`.
  Signatures match the internal implementations; existing exports are
  unchanged.
- `ensureToolCall` backfills arguments onto a placeholder call entry when a
  tool result was recorded before its start event (result-before-call replay).
- New `maxToolArgsChars` option (`SessionTranscriptOptions`) caps per-call
  argument size. Oversized or non-serializable arguments degrade to a stored
  `TruncatedToolArgs` marker (`{ truncated: true, preview, ... }`) instead of
  throwing, keeping ingestion total and rendering bounded.

### Fixed

- **`ensureTranscriptTheme` never clobbers a live host theme.** The previous
  implementation called `initTheme()` unconditionally on first use, which
  re-resolves the default theme from environment detection and can silently
  replace the user's chosen theme with the dark fallback — changing tool-call
  background colors in the main session after opening an embedded transcript
  view (e.g. `/subagents-fleet`). It now probes the SDK's shared
  `globalThis` theme symbol (`@earendil-works/pi-coding-agent:theme`, plus the
  legacy `@mariozechner/...` spelling) and is a strict no-op when the host has
  already initialized the theme; `initTheme()` is only called when nothing is
  active (headless embeds, unit tests).

## 0.2.0

### Breaking

- **Tool calls render through Pi's native `ToolExecutionComponent`.** The
  hand-drawn badge/result renderer (`formatToolPreview`,
  `summarizeToolResult`, tool badges, `↳ result` labels, and the
  `maxToolResultChars` cap) is removed. `tool-call` entries now store raw
  provider `args`, and `tool-result` entries store structured
  `TranscriptToolResultPayload` data verbatim so built-in tools keep their
  rich main-transcript output (diffs, file previews, images).
- `SessionTranscriptOptions` extends `NativeToolRenderOptions` (`tui`, `cwd`,
  `resolveToolDefinition`, `showImages`, `imageWidthCells`, `expanded`) and no
  longer accepts `maxToolResultChars`.
- `renderTranscriptLines` options replace `toolLabel` / `toolBadgeBackground`
  / `toolBadgeForeground` with `toolComponents` (a `ToolComponentLookup`); a
  persistent component registry is available via `TranscriptToolComponents`
  and `SessionTranscript.toolComponents`. Tool rows bypass line wrapping and
  width truncation because components own their geometry.
- `snapshot()` deep-copies structured tool `args`/`result` data.

### Changed

- Tool result entries whose call entry was trimmed away are dropped together
  with their component instances; `trimTranscriptState`,
  `removeCurrentTurn()`, and `clear()` prune the registry in lockstep with the
  entry list.
- `TranscriptToolComponents` requests a TUI repaint after every tool event
  (matching Pi's interactive mode) and routes component repaint signals
  through a forwarder, so `attachTui()` can wire — or replace — the host TUI
  at any time, even after instances exist. This keeps streaming tool output
  (e.g. bash's per-second invalidate interval) visible while a command runs.
- **Runtime entry ships TypeScript source again** (`exports["./transcript"]`
  now resolves to `src/transcript.ts`; types still resolve to the compiled
  `dist/src/transcript.d.ts`, so consumer typechecks are unchanged). Pi loads
  extension code through jiti, whose core-package alias map only applies to
  files jiti transforms itself; a precompiled `.js` entry was delegated to
  native import and resolved `@earendil-works/pi-coding-agent` by physical
  location, splitting into a second module instance in local-development
  layouts (repo workspace + npm-installed plugins). With a `.ts` entry the
  component library shares the host's core-package instances in every layout,
  so prototype patches from other plugins (e.g. pi-starline's user-message
  rail) apply to overlay transcripts again. This supersedes the 0.1.1
  bundle-safe rationale: consumers run exclusively inside Pi's jiti loader,
  which executes TypeScript directly. The unused legacy `"."` export
  (`dist/index.js`) was removed and `files` now includes `src`.

## 0.1.1

### Fixed

- **Bundle-safe runtime artifacts.** Consumer Pi packages now bundle compiled
  JavaScript and declarations rather than relying on Node to execute TypeScript
  from `node_modules`.

### Changed

- **Internal distribution.** This package is intentionally private and is
  bundled into consumer package tarballs instead of being published separately.

## 0.1.0

### Added

- Bounded session transcript state, native Pi message rendering, terminal-safe
  tool output, and a scrollable transcript viewport for Pi extensions.
