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

## 分组标题与耗时

折叠和展开使用相同的单行标题，例如 `▸ ✗ 耗时 3.2s · 分组 工具调用×4 · 思考×3 · 工具失败×1 · bash×3 read×1`。所有计数使用「名称×次数」；有足够空间时，标题也会显示 `通知警告×1`、`通知错误×1` 等异常数量。屏幕变窄时，依次省略工具明细、耗时和异常数量，优先保留原有的成员计数和异常标记。

`耗时 3.2s` 指该组最早成员开始到最晚成员结束的实际经过时间。它包含组内间隔，并行执行不会重复计时，也不包含等待整轮结束或等待折叠的时间。成员缺少可靠计时证据时，只省略耗时，不改变分组状态。使用扩展自定义渲染器的消息，以及无法安全验证的过大或不透明数据，都不会提供计时证据。

耗时只保存在当前视图的内存中。执行 `/reload`、恢复会话或重建转录后，历史组仍显示工具明细和异常数量，但不显示或补算耗时。自动压缩后即使继续同一轮，新视图中完整观测到的组也可计时；跨重建的旧起点不会沿用。

## What it does

- **Groups by visible order**: contiguous tools, thinking runs, and
  configured special messages form one group; assistant text, user
  messages, native diagnostics, and any kept (visible) item split groups.
- **Folds only on a real settle**: a turn folds when Pi reports the final
  `agent_settled`, the result is provably normal, and every member has
  stopped. Parallel tools must all finish; unknown evidence never counts
  as success.
- **Two-level view**: a folded group renders one width-aware title bar
  (`▸ ✗ 分组 工具调用×4 · 思考×3 · 工具失败×1 · bash×3 read×1`).
  The bar reports tool failures and notification warnings/errors separately
  when space permits, in addition to the `✗`/`⚠` marker. An accent-colored arrow
  and label distinguish the bar from message text; a neutral background
  follows the host theme when it provides a panel color. Expanding keeps
  the same title with `▾` and restores the members' original rendering
  byte-for-byte — no member list, no indentation, no changes to members'
  own expand states. When the group was opened and its actual end can be
  located safely, a single `▴ 收起分组` row at the end collapses that
  same group without changing any member's own expand state. Narrow
  terminals drop tool-name details first, then elapsed time, then exception
  quantities; a lower-priority field cannot replace a higher-priority one.
  These optional details give way before any of the original title;
  a still narrower terminal omits the label before sacrificing core
  statistics or exception markers. If the bottom control cannot fit or be
  safely located, it is omitted and the title and commands remain available.
- **Group elapsed time**: `耗时 3.2s` is the span from the earliest observed
  member start to the latest member end, including gaps inside the group.
  Parallel calls do not count twice; time waiting for the turn to settle or
  for a later turn to fold an abnormal group is not included. Missing or
  ambiguous member timing omits this field. Custom messages using a
  renderer callback are not timed: the callback may render from state that
  is not part of the message. Even with the built-in renderer, large or
  opaque metadata can prevent reliable timing. Timing lives only in the current
  view: after `/reload`, session resume, or transcript rebuild, history still
  shows the tool and exception counts but does not show elapsed time.
- **Group spacing**: provably owned placeholders of hidden thinking and
  notifications fold with their members. A group gets a single external
  blank line when needed next to visible content; existing spacing and
  meaningful content are preserved rather than globally trimmed.
- **Independent group objects**: a title or bottom-control click toggles
  the group, never the tool or message carrying that row. Works with
  pi-starline's click resolution (via a versioned explicit-target protocol)
  and without it; drags, double clicks, selections, links, and wheel
  events keep their native meaning.

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

The arrow and visible content confirm these operations. Successful and
no-op commands do not append status notifications: Pi's shared status text
must not cause previously grouped notifications to be reclassified merely
because this plugin acknowledged a command. Invalid arguments still show
a warning.

## Boundaries (first version)

- Interactive main-session TUI only; RPC/JSON/print and other extensions'
  self-built transcripts (pi-btw, fleet) are untouched.
- A tool that returned a result is done, even if it spawned background
  processes; this plugin does not track them.
- Renderer-level hiding (e.g. pi-tool-display hidden output) is respected:
  expanding a group never forces hidden content back on.
- Temporary notifications that the session did not persist are not
  replayed on reload. A notification losing the host's tail position is
  re-evaluated, not automatically removed from its group. Pi may redraw
  historical status rows using the latest status text; this plugin does
  not freeze the host's notification builders or shared text. Verified
  content that becomes `keep`, or whose source cannot be verified, remains
  visible and forms a boundary.
- If the host no longer exposes all required notification-source methods,
  notification grouping is disabled and a warning is shown once per session.
  Notifications stay visible; ordinary tool grouping remains available. If
  the notification-spacing seam is unavailable, original notification
  spacing remains visible and a warning explains the fallback.
- Works alongside pi-tool-display, pi-thinking-collapse, and pi-starline;
  none of them need to be disabled. With pi-starline absent (or its click
  feature off) the plugin handles title and bottom-control clicks itself.

## Development

```bash
pnpm --filter @xzzpig/pi-group-collapse run typecheck
pnpm --filter @xzzpig/pi-group-collapse test
pnpm --filter @xzzpig/pi-group-collapse run build:types
```
