# Changelog

All notable changes to the `@xzzpig/pi-btw` fork are documented here. This
fork tracks [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw) via git
subtree; entries below describe only fork-specific deviations from upstream.

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
