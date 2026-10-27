# Changelog

## 0.1.1 — Recovery fixes and group title bars

- Bind restored transcript components on initial startup and after in-process session replacement, without requiring a manual reload.
- Re-evaluate verified notification content when the status tail moves instead of unconditionally removing matching notifications and splitting a continuous run.
- Batch notification reclassification and invalidation so one status change removes affected members in linear scans rather than repeatedly scanning historical groups.
- Distinguish collapsed and expanded titles with `▸` / `▾`, an accent-colored `分组` label and a theme-aware neutral title bar, without changing member rendering or row height.
- Let expand/collapse commands request a redraw directly and use the visible group state as feedback; omit info acknowledgements that could overwrite the shared notification status text.

## 0.1.0 — Initial release

- Collapse settled runs of tools, thinking and selected special messages; expand to restore the existing renderers without changing member visibility settings.
- Keep active and abnormal turns visible; collect eligible deferred fragments after a later normal settle.
- Add strict global/project rule files, exact tool/custom-message matching and verified notification-prefix matching, applied on `/reload`.
- Support keyboard commands, native summary clicks and Starline's optional versioned explicit-target integration.
- Include lifecycle, narrow-terminal and performance regressions, plus isolated real-TUI recordings in the repository's local acceptance artifacts (not shipped in npm).
- If notification provenance adapters are unavailable, keep notifications visible and issue one warning per session; a later session can report the same degradation again.
- Ship TypeScript runtime sources and a bundled `dist/public.d.ts` declaration file.
