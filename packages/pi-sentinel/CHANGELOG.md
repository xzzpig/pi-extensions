# Changelog

## 0.1.1 — 2026-09-30

- New `event` trigger (the sixth): a rule subscribes a plugin event-bus channel
  by bare name or a host extension event via the reserved `core:` prefix
  (`trigger.event`; unknown `core:` names fail validation with the list of
  legal values). Subscriptions are reference-counted per event name and bound
  to the configuration: hot reloads add and remove them, session switches and
  tree navigation keep them, session shutdown tears them all down.
- Event data template root `{ name, event }` (`name` is the configured event
  name verbatim; the payload is JSON-safe projected and truncated, non-object
  bus payloads wrap as `{ value }`), with the payload JSON as the default scope
  block and `blocking` reserved for `tool_call`.
- `/sentinel:test` supports event rules (simulated content becomes the
  payload); `/sentinel:list` and `/sentinel:fleet` render event triggers as
  `event:<name>`; the configure-dialog cheat sheet documents the new trigger,
  and the README warns that per-token hot events such as `core:message_update`
  audit on every emission (background `overlap` defaults to `ignore`).

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
