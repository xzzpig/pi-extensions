# Fork release notes

## 0.11.2 — 原生模型选择器与悬停提示

- 模型行收到无按键移动事件时显示独立背景提示，包含换行续行；不改变原生箭头对应的 Enter／默认模型保存目标，也不触发列表居中。点击仍确认实际鼠标目标，组件外未收到事件时可保留最后提示；内容或布局变化后清理，不增加输入监听或共享依赖。tmux 默认可能不提供悬停事件，验证与运行限制见 `docs/fork-model-selector.md`。

- 模型药丸点击改为调用当前编辑器的原生模型选择动作，保留搜索、范围切换和草稿，不再打开有限候选气泡；`/starline model` 的原有循环行为不变。
- 新入口不提交命令或用户消息，不重复覆盖已打开界面；不支持该动作的自定义编辑器会收到一次说明，可继续直接使用 `/model`。实现与验证边界见 `docs/fork-model-selector.md`。
- 药丸、`/model` 和快捷键打开的原生模型选择器均支持点击及滚轮，换行命中使用真实渲染高度；滚轮首尾停止、不穿透到会话。点击与滚轮不依赖 `pi-mouse-events`，其共享指针能力仅提供可选手形增强。

## 0.11.1 — Upstream bytes restored, lint policy moved to config

- The fork's `pi-mouse-events` consumer implementation moved to fork-only `extensions/starline/mouse/fork-consumer.ts`; `mouse/index.ts` is now a ten-line re-export seam, so an upstream change to the installer lands on the signature instead of a 500-line rewrite. No behavior change: click, wheel and drag-selection were re-verified in a live TUI.

- Restored upstream bytes on `extensions/starline/pill-actions.ts` and `format.ts` (the fork-only `SAFETY:` comment pairs and the `biome-ignore` note are gone), restored upstream's empty `} catch {}` in `config.ts`, and removed the fork's `pi-lens-ignore` notes from `ui.ts`; no behavior change.
- The corresponding pi-lens gates are waived per file in the new `packages/pi-starline/.pi-lens.json` (`require-safety-comment-for-as-unknown-as`, `no-unknown-returns`, `noUnusedVariables`, `error-swallowing`), recorded as a `knownDebt: lint` entry in the subtree metadata. Annotating upstream-original lines is not an option: it breaks the byte-stability rule the fork relies on for syncs.

## 0.11.0 — pi-tidy ownership convergence

- Converge with upstream's pi-tidy ownership of user-message styling and transcript clean-copy: remove Starline's fork renderer and transcript-selection cleaner. Starline now leaves transcript selections to Pi's native copy path; configure optional clean-copy through pi-tidy's `tidy.cleanCopy`.
- Adopt upstream's once-per-process migration warning for the retired user-message keys. With pi-tidy and pi-tool-display both installed, disable pi-tool-display's **Native user message box** (`enableNativeUserMessageBox: false`) for pi-tidy to own the user-message render hook; the upstream default remains unchanged.

## 0.10.0 — Upstream v0.13.0 sync

- **Synced upstream v0.9.0 → v0.13.0** (upstream minor releases → fork minor bump). Upstream rewrote the mouse subsystem, split the pill bar into a governed overflow path, and moved user-message styling toward pi-tidy. At the time of this sync the fork still retained its user-message renderer, so this was an API integration rather than a straight merge; the Unreleased entry above records the later convergence.
- Adopted upstream's pull-request pill (`gitPr`, coloured per state via `gitPrOpen`/`gitPrDraft`/`gitPrMerged`/`gitPrClosed`/`gitPrCount`) and the `git.issues` switch that adds the repository's open-issue count to the pull bubble.
- Adopted `extensionStatuses.commands`: a third-party status can point its pill at an existing slash command (`procs` → `/ps`) without writing a bridge. Entries that are not `/name` or `/name args`, that carry the `extensionStatus:` prefix, that shadow a built-in segment, or that point at `/starline` are dropped and reported once per process. A bridge registration still wins over a declared command.
- Adopted the external editor-hint API (`docs/editor-hints.md`, `editor-hint-api.ts`): other extensions can publish a hint that rides the editor's top rule, ahead of Starline's own hints so the rule's truncation cannot eat it.
- Adopted Pi's bash-mode border painter, so the editor frame says which mode the draft is in instead of always drawing Starline's configured border.
- Adopted the context-pill estimate: before the first turn the pill reads `~N%/window` from the static prompt-and-schemas floor instead of `0%`, and drops the `~` once a turn lands. The bubble reports the same number.
- Adopted upstream's governed overflow row (`onOverflow`/`PillOverflow`) alongside the fork's existing `pill.overflow` governance. With `pill.overflow.enabled: false` the legacy path still renders one unbounded row and hard-truncates it, because upstream's `renderPillBar` now drops whole pills and stands a `+N` counter in their place when given a real width — that is the governance path, not the legacy one.
- Adopted the upstream additions to the settings surface (`previousPrompt`/`latest` pill rows), the `gitPr` colour keys, and the `statusCommandName` helper.
- This v0.10.0 sync kept every fork seam then present: the `pi-mouse-events` consumer mouse subsystem, `clickToToggleExpandable`, the user-message renderer/settings and `transcriptCleanCopy`, `--no-optional-locks` on every git probe, the reverse-video pill legibility pair, the `pill.overflow` governance and status panel, the MCP pill adapter, and the pi-zentui legacy symbol aliases. The Unreleased entry above records the later removal of the user-message and transcript-copy divergences.
- At v0.10.0, upstream v0.13.0 had deleted `mouse/transcript-copy.ts` and `test/mouse/toolbox-frame.ts`; the fork restored both because its then-current transcript cleaner and component-tree code imported them. The transcript cleaner was later removed by the Unreleased convergence above; the component-tree fixture remains.
- Validation: package typecheck clean and 1623/1623 tests passing. `pnpm run audit:fork-divergence` reports undeclared=0, stale=0 for this package.

## 0.9.1 — panel interaction fixes

- The same entrance toggles: pressing the `+N` pill again, clicking the same shortened pill, re-running `/starline statuses` or the settings row puts the panel away instead of stacking another one or warning about "an open dialog" — that dialog was the panel itself. Asking for a _different_ entry replaces it with one focused there.
- A click outside the box dismisses the panel. The frame and the padding are claimed by the panel itself, and with `@xzzpig/pi-mouse-events` loaded the shared pointer stream closes it for clicks anywhere else on screen — the bar included, which Pi never delivers to an overlay. The press that dismisses cannot reopen it (that one echo is swallowed), so `+N` while open closes rather than closing and reopening. Clicks on the gap between entries keep the panel open.
- When another dialog already owns the screen the entrances stay silent: no panel and no notice, for the mouse and the command alike.
- Clicking an entry runs its action when it has one, exactly like Enter, and with pill-click semantics: `model` and `thinking` open their pickers rather than stepping to the next value (only the bare `/starline model` command steps). Read-only entries only take the selection.
- Closing by Esc, by an action or by Pi tearing the overlay down now clears the panel's screen rectangle as well, so the next `+N` press opens it again instead of being mistaken for a click outside a panel that is already gone.

## 0.9.0 — status overflow and the status panel

- The bar is still one row, but it no longer loses pills at the right edge. A pill's content is capped by display columns (`pill.overflow.maxContentWidth`, default 32; third-party statuses 28; `cwd`/`git` 24), shortened with `…` (`...` in ascii mode), and the pills that do not fit are replaced by one `+N` pill. Every valid entry is either drawn whole or counted in `+N`; the old single truncation is what made a status disappear without saying so.
- Retention is set by `pill.overflow.priorities` (defaults: `queue` 100, `model`/`context` 80, everything else 50) and `pill.overflow.pinned`. It decides _which_ pills stay, never where they sit: survivors keep their configured order, and a later short pill is not squeezed past an earlier long one of the same tier. The visible cost is that the row may end with a few free columns instead of reshuffling whenever a text length changes.
- The selected entry is filled across the full row (theme accent plus contrast text, reverse video when the theme cannot supply a background) and the pointer moves that highlight from entry to entry without scrolling; the gap rows stay unfilled, so the block reads as one unit.
- `/starline statuses` opens every status, untruncated, in a bounded panel: wrapped text, ↑/↓ scrolling one visual line while the selected entry keeps its identity, Shift+↑/↓ stepping the selection, PgUp/PgDn paging, Home/End for the first or last entry, the wheel, `Tab` for the statuses the bar does not place (turned `off` or outside `pill.segments`), `Esc` to close. The `+N` pill opens the same panel at the first hidden entry. `pi-plugin-e2e-test` covers the live behaviour; the panel keeps the editor's draft and focus on close.
- Every entrance to the panel goes through one hand-over: the `+N` pill, a shortened pill, `/starline statuses` and the settings row close Starline's own pill bubble first and then refuse to stack when another dialog is already up (asked through `@xzzpig/pi-mouse-events`' published API when installed), with a notice instead of two overlays. Closing our bubble first is deliberate: it is an overlay too, so probing before it would always answer "someone else is up".
- Existing click actions keep their meaning. A pill with an action still runs it (`mcp`, `model`, `context`, …); only a shortened pill with _no_ action opens its own full text, and a full-text read-only pill stays inert. Inside the panel, reading/selecting/scrolling never runs anything: Enter, or a click on that entry's action row, closes the panel and re-resolves the action for the current session before calling it. No anchor is passed, because an overflowed entry has no pill on screen.
- A status's published text is what the panel shows; `extensionStatuses.formats: value` still only changes the pill. The snapshot is built before format conversion and never written back — `ctx.ui.setStatus()` text is untouched, and nothing is persisted, logged or sent to the model. Terminal controls are stripped before display.
- Configuration lives in `pill.overflow` (defaults on). Each field falls back on its own, unknown keys are kept for statuses that appear later, and `enabled: false` restores the old single truncation while keeping the panel. The `/starline` settings screen exposes the switch, the third-party cap, and per-status priority/pinning for the statuses published this session; per-key widths stay in JSON. See `docs/status-overflow.md`.
- The layout decision is cached per frame, and the cache key covers everything that can change the row: each entry's drawn input and truncation, the overflow settings, the terminal width, the icon mode, and the renderer geometry derived from caps, separators and theme colours (measured with a two-pill probe). A cache hit rehydrates the cached selection against the current frame's entries, so `/starline` changing the icon mode never redraws the previous geometry and the panel never disagrees with the row it describes.
- Implementation is fork-only: `fork-overflow-config.ts`, `fork-status-snapshot.ts`, `fork-pill-overflow.ts`, `fork-status-bar.ts`, `fork-status-view.ts`, `fork-status-panel.ts`, `fork-overflow-settings.ts`. Upstream seams are one field plus one call in `pill-config.ts`, one save function in `config.ts`, the render/click tail in `footer.ts`, two item splices plus one change call and one `statuses` route call in `settings-command.ts`, and two calls in `index.ts`. The `/starline` rows, their value lists, the priority/pinned id handling and the close-before-mount ordering all live in `fork-overflow-settings.ts`, so the upstream settings file keeps no fork logic. The public pill API (`types/pill-api.d.ts`) is unchanged; there is no new dependency and no two-line mode in this release.
- Coverage: `test/fork-status-panel-entry.test.ts`, `test/fork-overflow-config.test.ts`, `test/fork-status-snapshot.test.ts`, `test/fork-pill-overflow.test.ts`, `test/fork-status-panel.test.ts`, `test/fork-status-overflow-integration.test.ts`, `test/fork-overflow-settings.test.ts`, `test/fork-overflow-settings-module.test.ts`, `test/fork-status-bar-cache.test.ts`, `test/fork-status-view.test.ts`.

## 0.8.0 — MCP status pill opens the adapter panel

- `pi-mcp-adapter`'s `mcp` status pill is now clickable: a click, or `/starline mcp`, dispatches the adapter's own `/mcp-adapter` command, which opens the panel you get from running that command by hand. Starline does not draw a bubble for it and does not learn how to close or save the panel — the adapter keeps that, including the reload after a config change.
- The text is still the adapter's. With its `settings.mcpFooterStatus: "compact"` the pill reads `MCP 0/1` (connected/enabled); Starline copies that through untouched and never parses it, recounts it, or rewrites `mcp-adapter.json` for you. Connecting, blocked-by-trust and background-task messages keep their full text. Set that setting in your own adapter configuration if you want the short form.
- Nothing is dispatched unless the session's command list contains `mcp-adapter` with source `extension`. A same-named prompt template or skill is not it, an unknown slash command is never sent to the model as a prompt, and non-TUI modes (`rpc`, `json`, `print`) stay inert.
- Reopening is guarded, not single-flighted: the click path reuses the footer's press/click de-duplication, then a shared 300 ms cooldown merges a fast double click or a mouse-then-keyboard repeat. The Starline bubble is closed first and the overlay probe runs _after_ that (`showExtensionCustom.close()` hides its overlay synchronously), so what the probe sees is never Starline's own bubble: a visible foreign overlay drops the request instead of stacking a second panel, and a close that did not take effect is refused the same way. Without that capability the cooldown is the only guard. `pi.sendUserMessage()` returns `void`, so the cooldown is deliberately bounded — a panel that takes longer than 300 ms to appear can be asked for again rather than the entry point being locked forever.
- Implementation: fork-only `extensions/starline/fork-mcp-pill.ts`, one import plus one call in `extensions/starline/index.ts`, registered through `registerExternalPillAction("mcp", …)` so the builtin `PILL_ACTIONS` table and the footer's mouse protocol are untouched. An existing third-party `mcp` action always wins. Coverage lives in `test/fork-mcp-pill.test.ts` and `test/fork-mcp-status-render.test.ts`.

## 0.7.2 — pill text contrast on terminal-owned palettes

- Pick the pill text colour from the 256-colour cube (`38;5;16` black, `38;5;231` white) instead of the basic ANSI codes `30`/`97`. The basic codes belong to the terminal theme: herdr renders ANSI black as `#616161`, which left the automatic "dark" text at 1.76:1 on the muted pill background and 2.62:1 on the model pill. The cube's black and white are fixed by the standard, so contrast now holds in any palette (5.4–9.4:1 for the footer's default backgrounds).
- The change is two constants plus their comment in `extensions/starline/pill.ts`. It covers pill bodies, the thin divider drawn between same-background pills, and the bubble's selected row, all of which share `contrastTextSgr()`. Backgrounds, separators, caps, widths and click targets are unchanged, and an explicit `fg:` in `colors.*` still wins.
- Backgrounds that land on the terminal's own 16 colours are painted in reverse video (`\x1b[49m` + the palette colour as foreground + `\x1b[7m`): the palette colour stays the background and the text becomes the terminal's default background, a pair the palette is designed to keep readable. Only the terminal knows those RGBs — the standard table turned `48;5;3` into "dark yellow" when herdr paints it `#61AFEE`, which is why the contrast guess cannot be trusted there. Measured on the same pills: 2.62:1 → 8.61:1 (model/cwd) and 3.07:1 → 10.11:1 (cost); known-RGB backgrounds keep the cube black/white and land at 9.12:1. The predicate and SGR builders live in the fork-only `extensions/starline/fork-pill-legibility.ts`, with one seam each in `pill.ts` and `pill-bubble.ts`.
- Fork coverage lives in `test/fork-pill-contrast.test.ts`; `subtrees/pi-starline.json` records the sync-time re-apply. Drop the constants divergence once upstream stops deriving legibility from the terminal's basic palette, and the reverse-video seam once upstream handles terminal-owned backgrounds itself.

## 0.7.1 — Pi cursor compatibility

- Restore `underline` and `terminal` editor cursor styles on Pi 1.2 and later while preserving the existing Pi 1.1 cursor path.
- The previous published fork version was 0.5.1. This release also includes the upstream syncs and fork changes recorded in 0.6.0 and 0.7.0 below.

## 0.7.0 — Upstream v0.9.0 sync

- Adopt the compact editor layout, `editorMinRows`, configurable pill row, live throughput, and turn timing. The old editor metadata row is removed and its status placement maps to the right-hand footer.
- At v0.7.0, the fork retained its then-current user-message renderer, padding/colour settings and shared editor/message colour controls. When pi-tidy was installed alongside it, patch order could determine the visible renderer; this old ownership arrangement was later removed by the Unreleased convergence above.
- This release also preserved the fork's shared mouse, clipboard and wheel integrations, pi-zentui markers, and group-expand compatibility. Its then-current clean-copy supported the configured Starline rail alongside upstream pi-tidy frames; transcript cleaning was later removed by the Unreleased convergence above.

## 0.6.0 — Upstream v0.6.1 sync

- Adopt upstream's pill-only status bar, clickable pills, bubbles and keyboard actions. The old text-footer configuration is removed.
- Keep the fork's `pi-mouse-events` consumer, component expansion and group-target compatibility. Pill pointer requests and click-away use the shared mouse layer rather than a second Starline mouse patch.
- Prefer Pi's native clipboard through the shared asynchronous copy slot when available; older v2 mouse-event publishers retain the existing OSC 52 fallback.
- Route editor-wheel input through the shared post-component slot using Pi's calculated delta, including acceleration and Alt-wheel, while retaining the earlier fallback for older v2 publishers.
- Ship upstream's public `types/pill-api.d.ts` along with the fork's built declarations and release notes.

## 0.5.1 — Release candidate

- Recognize the optional `@xzzpig/transcript-expand-target.v1` contract for group summary clicks. Invalid or absent providers fall back to the existing component resolver; no new mandatory package dependency or default-setting change.
- Add `build:types` and `prepack` to include `dist/public.d.ts` alongside the extension sources.
- Keep historical upstream/fork release notes in `CHANGELOG.md`; this fork-only file records the new compatibility release without expanding upstream documentation edits.

Validated host: Pi 1.1.0. Native drag-selection acceptance and OpenSpec archival are release gates, not implied by a successful package build.
