# Changelog

## 0.1.0 — Initial release

- Collapse settled runs of tools, thinking and selected special messages; expand to restore the existing renderers without changing member visibility settings.
- Keep active and abnormal turns visible; collect eligible deferred fragments after a later normal settle.
- Add strict global/project rule files, exact tool/custom-message matching and verified notification-prefix matching, applied on `/reload`.
- Support keyboard commands, native summary clicks and Starline's optional versioned explicit-target integration.
- Include lifecycle, narrow-terminal and performance regressions, plus isolated real-TUI recordings in the repository's local acceptance artifacts (not shipped in npm).
- If notification provenance adapters are unavailable, keep notifications visible and issue one warning per session; a later session can report the same degradation again.
- Ship TypeScript runtime sources and a bundled `dist/public.d.ts` declaration file.
