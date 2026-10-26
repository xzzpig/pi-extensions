# pi-group-collapse

Fold a settled turn's tools, thinking, and selected special messages into
one-line summaries after the turn truly settles, and restore the original
rendering with a single click.

The transcript stays untouched while the model works: tools, thinking, and
messages render exactly as the host and your other beautification plugins
draw them. Only after the whole turn settles normally does each contiguous
run of selected members collapse to one summary line. Abnormal turns
(errors, aborts, truncation) keep their original display and are folded by
the next normal turn's end — never silently.

## Install

```bash
pi install npm:@xzzpig/pi-group-collapse
```

Validated with Pi 1.1.0 in fullscreen mode. When using Starline's click handling,
use `@xzzpig/pi-starline` 0.5.1 or later for the explicit group-target integration.
Older or unsupported host component layouts fail safely without hiding content.

## What it does

- **Groups by visible order**: contiguous tools, thinking runs, and
  configured special messages form one group; assistant text, user
  messages, native diagnostics, and any kept (visible) item split groups.
- **Folds only on a real settle**: a turn folds when Pi reports the final
  `agent_settled`, the result is provably normal, and every member has
  stopped. Parallel tools must all finish; unknown evidence never counts
  as success.
- **Two-level view**: a folded group renders one width-aware summary line
  (`▸ 4 次工具调用 · 3 段思考 · 2 条消息`, with `✗`/`⚠` markers when
  failures or warning/error notifications exist). Expanding restores the
  members' original rendering byte-for-byte — no member list, no
  indentation, no changes to members' own expand states.
- **Independent group objects**: a summary click toggles the group, never
  the first tool inside it. Works with pi-starline's click resolution (via
  a versioned explicit-target protocol) and without it; drags, double
  clicks, selections, links, and wheel events keep their native meaning.

## Configuration

Two JSON layers, resolved at extension load and `/reload` (never
hot-reloaded, never written back):

- global: `<agentDir>/group-collapse.json` (default `~/.pi/agent/…`,
  honors `PI_CODING_AGENT_DIR`);
- project: `<cwd>/.pi/group-collapse.json`.

A project file that provides a `rules` field replaces the global table
entirely; a missing field inherits it; `rules: []` restores the defaults.
Invalid JSON, unknown fields, wrong kinds/actions, or empty selection
conditions reject that whole layer (falling back to the valid upper layer)
with one deduplicated notice — single bad rules are never silently
ignored.

```json
{
  "rules": [
    { "kind": "tool", "name": "update_goal", "action": "keep" },
    {
      "kind": "customMessage",
      "customType": "pi-goal-audit-event",
      "action": "group"
    },
    {
      "kind": "notification",
      "textPrefix": "Observational memory:",
      "level": "info",
      "action": "group"
    }
  ]
}
```

- `kind` is exclusive: tool rules match tool names, customMessage rules
  match custom types — exact and case-sensitive, never crossing kinds.
- Notification `textPrefix` matches the verified original notification
  text (ANSI stripped) from its start; `level` optionally narrows to
  `info` / `warning` / `error`. Notifications are only claimed when this
  package can prove they came from the extension notify entry — core
  status lines with the same text stay visible.
- `action`: `group` joins a run; `keep` stays visible and splits groups.
  When several rules match, the **last** one wins. Defaults: tools group;
  thinking follows its own visibility; special messages and notifications
  stay visible.
- Assistant text, user messages, native diagnostics, hidden entries,
  widgets, overlays, and other extensions' transcripts can never become
  members, whatever the rules say.

## Commands

- `/group-collapse expand` — restore every folded group (mouse-free).
- `/group-collapse collapse` — fold every settled, quiet group; the
  running turn and unresolved calls are never hidden.

## Boundaries (first version)

- Interactive main-session TUI only; RPC/JSON/print and other extensions'
  self-built transcripts (pi-btw, fleet) are untouched.
- A tool that returned a result is done, even if it spawned background
  processes; this plugin does not track them.
- Renderer-level hiding (e.g. pi-tool-display hidden output) is respected:
  expanding a group never forces hidden content back on.
- Temporary notifications that the session did not persist are not
  replayed on reload.
- If the host no longer exposes all required notification-source methods,
  notification grouping is disabled and a warning is shown once per session.
  Notifications stay visible; ordinary tool grouping remains available.
- Works alongside pi-tool-display, pi-thinking-collapse, and pi-starline;
  none of them need to be disabled. With pi-starline absent (or its click
  feature off) the plugin handles summary clicks itself.

## Development

```bash
pnpm --filter @xzzpig/pi-group-collapse run typecheck
pnpm --filter @xzzpig/pi-group-collapse test
pnpm --filter @xzzpig/pi-group-collapse run build:types
```
