# Fork release notes

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
- Retain Starline's user-message renderer, its padding and colour settings, and the shared editor/message colour controls. If pi-tidy also styles messages, patch order can determine the visible renderer; set `tidy.userMessageStyle` to `"off"` to leave user messages to Starline.
- Preserve the fork's shared mouse, clipboard and wheel integrations, pi-zentui markers, and group-expand compatibility. Clean-copy supports the configured Starline rail alongside upstream pi-tidy frames.

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
