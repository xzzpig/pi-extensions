# Fork release notes

## 0.5.1 — Release candidate

- Recognize the optional `@xzzpig/transcript-expand-target.v1` contract for group summary clicks. Invalid or absent providers fall back to the existing component resolver; no new mandatory package dependency or default-setting change.
- Add `build:types` and `prepack` to include `dist/public.d.ts` alongside the extension sources.
- Keep historical upstream/fork release notes in `CHANGELOG.md`; this fork-only file records the new compatibility release without expanding upstream documentation edits.

Validated host: Pi 1.1.0. Native drag-selection acceptance and OpenSpec archival are release gates, not implied by a successful package build.
