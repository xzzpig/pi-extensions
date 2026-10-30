# Fork release notes

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
