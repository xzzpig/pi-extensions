# Changelog

## 0.1.3 — 2026-11-15

- Fix `Cannot find module '@earendil-works/pi-schema'` on Pi 1.5. Pi neither
  maps that specifier for extensions nor installs peer dependencies of managed
  packages, so declaring it as a peer dependency never provided it. It is now a
  runtime dependency, which Pi installs next to the plugin.

## 0.1.2 — 2026-11-05

- Require Pi 1.5.0 or newer and build tool parameter schemas with
  `@earendil-works/pi-schema` instead of TypeBox. Preserve existing required
  fields, bounds, and open/closed-object validation semantics.

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
