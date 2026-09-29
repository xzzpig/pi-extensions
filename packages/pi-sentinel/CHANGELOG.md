# Changelog

## 0.1.0 — 2026-09-29

- Initial package skeleton for the declarative side-loop sentinel engine.
- Post-implementation audit fixes: one shared concurrency semaphore whose limit
  hot-reloads (reused runners refresh their context); dedupe cooldowns survive
  unrelated config changes and expire per rule name; the configure-dialog
  shadow notice reads the unmerged file scope; audit failures notify once; tree
  navigation only replays the session op-log and re-anchors markers; session
  switches clear negative cooldowns; watermarks re-anchor at the current level;
  removing a session rule clears its disable mask; finished configure dialogs
  leave the fleet registry; a synchronous `streamSimple` throw becomes a
  terminal error stream; `@root`/`this` paths are no longer reported as
  unresolved template variables. See
  `openspec/changes/add-pi-sentinel/audit-fixes-2026-09-29.md`.
