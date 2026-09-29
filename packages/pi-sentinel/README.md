# @xzzpig/pi-sentinel

Declarative natural-language sentinels for the [pi](https://pi.dev/) coding agent.

`pi-permission-system` answers "is this path allowed?" with deterministic rules.
`pi-sentinel` answers "is this action _wise_?" with a side-loop LLM audit: you
declare when to trigger, what to check in natural language, and what happens
when the audit finds a problem. It never touches the main loop's context except
to inject a finding, and it cannot recurse into itself.

- **Six triggers** — `tool_call`, `tool_result`, `turn_end`, `agent_end`,
  `context_tokens`, `event`.
- **Two modes** — `blocking` gates a tool call before it runs; `background`
  audits asynchronously and injects `warn`/`fail` findings.
- **Structured verdicts** — the auditor must call `audit_verdict`
  (`pass`/`warn`/`fail` + message); free text is never parsed.
- **Config in three scopes** — global `~/.pi/agent/sentinel.json`, project
  `.pi/sentinel.json` (trusted projects only), and session-level rules added at
  runtime with `/sentinel:configure`.

## Install

```bash
pi install npm:@xzzpig/pi-sentinel
```

Pi core packages are peer dependencies; the plugin runs against your host Pi.

## Configuration

Create `~/.pi/agent/sentinel.json` (global) or `.pi/sentinel.json` (project).
Project values win per key, and a project rule with the same `name` replaces the
global one entirely.

```json
{
  "defaults": {
    "model": "anthropic/claude-haiku-4-5",
    "thinking": "off",
    "timeoutMs": 30000,
    "cache": true,
    "cacheTtlMs": 600000,
    "maxConcurrent": 3,
    "dedupeCooldownMs": 600000,
    "maxWindowTokens": 20000,
    "configure": {
      "model": "anthropic/claude-sonnet-4-5"
    }
  },
  "rules": [
    {
      "name": "bash-safety",
      "trigger": { "type": "tool_call", "tools": ["bash"] },
      "mode": "blocking",
      "prompt": "检查这条命令是否包含危险的递归删除、磁盘写入或凭据外泄：{{input.command}}",
      "tools": ["read"],
      "maxTurns": 4,
      "overlap": "parallel",
      "onFailure": "open",
      "cache": true,
      "cacheTtlMs": 600000,
      "timeoutMs": 30000,
      "enabled": true
    },
    {
      "name": "edit-style",
      "trigger": { "type": "tool_result", "tools": ["edit", "write"] },
      "mode": "background",
      "prompt": "检查这次编辑是否符合项目约定：{{content}}",
      "model": "openai/gpt-5-mini",
      "thinking": "low",
      "maxTurns": 1,
      "window": { "messages": 10 },
      "overlap": "ignore",
      "onFailure": "open",
      "dedupe": true,
      "includeThinking": true,
      "includeToolInputs": true,
      "includeToolOutputs": true
    },
    {
      "name": "turn-review",
      "trigger": { "type": "turn_end" },
      "mode": "background",
      "prompt": "回顾第 {{turnIndex}} 轮是否偏离目标：{{assistant}}",
      "overlap": "ignore"
    },
    {
      "name": "agent-wrapup",
      "trigger": { "type": "agent_end" },
      "mode": "background",
      "prompt": "本次循环共 {{messageCount}} 条消息，检查是否有未完成项。",
      "window": { "full": true }
    },
    {
      "name": "context-drift",
      "trigger": { "type": "context_tokens", "threshold": 100000 },
      "mode": "background",
      "prompt": "检查自上次审计以来的增量是否仍围绕目标：{{json messages}}",
      "overlap": "replace",
      "cache": false
    }
  ],
  "fleetKeybindings": {
    "selectUp": ["up", "k"],
    "selectDown": ["down", "j"],
    "steer": ["s"],
    "refresh": ["r"],
    "close": ["escape", "q"]
  }
}
```

A bad file or a single bad rule never aborts the session: the file is skipped
with a warning, and only the offending rule is dropped. With no loaded rules the
plugin is completely silent.

### `defaults`

| Key                | Type   | Default  | Meaning                                       |
| ------------------ | ------ | -------- | --------------------------------------------- |
| `model`            | string | —        | Default audit model (`provider/modelId`)      |
| `thinking`         | string | `"off"`  | Default thinking level                        |
| `timeoutMs`        | int    | —        | Default audit timeout (blocking 30s / bg 60s) |
| `cache`            | bool   | `true`   | Verdict cache switch                          |
| `cacheTtlMs`       | int    | `600000` | Verdict cache TTL                             |
| `maxConcurrent`    | int    | `3`      | Global concurrent audit limit (FIFO)          |
| `dedupeCooldownMs` | int    | `600000` | Finding injection dedupe window               |
| `maxWindowTokens`  | int    | `20000`  | Audit scope token cap (chars/4 estimate)      |
| `configure.model`  | string | —        | Model for the `/sentinel:configure` dialog    |

### Rule fields

| Field                                                          | Required                 | Default                          | Meaning                                                                                                         |
| -------------------------------------------------------------- | ------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `name`                                                         | yes                      | —                                | Unique per session; merge key                                                                                   |
| `trigger.type`                                                 | yes                      | —                                | `tool_call` \| `tool_result` \| `turn_end` \| `agent_end` \| `context_tokens` \| `event`                        |
| `trigger.tools`                                                | no                       | all                              | minimatch patterns for the reported tool name (tool triggers)                                                   |
| `trigger.threshold`                                            | yes for `context_tokens` | —                                | Fire once per crossed multiple of this token count                                                              |
| `trigger.event`                                                | yes for `event`          | —                                | Event name: bare = plugin bus channel (unvalidated); `core:` = host extension event (must be a known host name) |
| `mode`                                                         | yes                      | —                                | `blocking` (only `tool_call`) \| `background` (all six triggers)                                                |
| `prompt`                                                       | yes                      | —                                | Handlebars check instruction                                                                                    |
| `model`                                                        | no                       | resolution chain                 | Audit model                                                                                                     |
| `thinking`                                                     | no                       | `defaults.thinking`              | Thinking level                                                                                                  |
| `tools`                                                        | no                       | `[]`                             | Auditor tool whitelist (host built-ins only)                                                                    |
| `maxTurns`                                                     | no                       | `4` with tools, else `1`         | Side-loop turn limit                                                                                            |
| `window`                                                       | no                       | per trigger                      | `{messages: N}` \| `{tokens: N}` \| `{full: true}`                                                              |
| `overlap`                                                      | no                       | blocking `parallel`, bg `ignore` | `parallel` \| `serial` \| `ignore` \| `replace`                                                                 |
| `onFailure`                                                    | no                       | `"open"`                         | `open` allows, `closed` blocks on audit failure                                                                 |
| `cache` / `cacheTtlMs`                                         | no                       | from `defaults`                  | Per-rule verdict cache                                                                                          |
| `timeoutMs`                                                    | no                       | from `defaults`                  | Per-rule audit timeout                                                                                          |
| `enabled`                                                      | no                       | `true`                           | File-level switch (loaded but not triggered when `false`)                                                       |
| `dedupe`                                                       | no                       | `true`                           | Finding dedupe switch (background only)                                                                         |
| `includeThinking` / `includeToolInputs` / `includeToolOutputs` | no                       | `true`                           | Serialization switches                                                                                          |

Unknown fields, illegal enum values, an illegal `mode` × `trigger.type`
combination, and extension/MCP tool names in the auditor `tools` whitelist all
fail just that rule.

### Event triggers

The `event` trigger fires whenever a named event is emitted; `trigger.event`
selects the source and is used verbatim:

- **Bare name** (e.g. `pi-subagents:done`) — subscribes a plugin event-bus
  channel (`pi.events`). Channel names are open and never validated: a typo or
  a channel nobody emits simply never fires, with no warning and no fleet
  error.
- **`core:` prefix** (e.g. `core:session_compact`) — subscribes a host
  extension event. The name after the prefix must be one of the host's known
  event names (such as `core:session_compact`, `core:turn_end`,
  `core:message_update`); an unknown name fails validation and the warning
  lists every legal value. `core:` is a reserved prefix: it always routes to
  host events, so a bus channel named `core:…` cannot be subscribed.

Two example rules:

```json
{
  "name": "subagent-review",
  "trigger": { "type": "event", "event": "pi-subagents:done" },
  "mode": "background",
  "prompt": "子代理任务已完成，请检查其结论是否可信：{{event.summary}}"
}
```

```json
{
  "name": "compact-review",
  "trigger": { "type": "event", "event": "core:session_compact" },
  "mode": "background",
  "prompt": "上下文刚被压缩，检查压缩摘要是否仍保留项目关键约定：{{json event}}"
}
```

The template root is `{ name, event }`: `name` is the configured event name
verbatim (including any `core:` prefix), and `event` is the payload — the host
event object itself for `core:` events, the emitted `data` for bus events
(non-object bus payloads are wrapped as `{ "value": … }`). Unserializable
payload members render as `"[unserializable]"` and long strings are truncated.
Without a `window` the scope block is the serialized event JSON (the `include*`
switches have no effect there; they apply only when a `window` override
switches the scope to a conversation transcript). Event rules must be
`background` — only `tool_call` can be `blocking`. Subscriptions live with the
configuration: they survive session switches and tree navigation, follow hot
reloads, and are torn down at session shutdown.

**Cost warning**: host events include per-token streams such as
`core:message_update`. Subscribing one fires an LLM audit on every single
emission — the system deliberately does not guard against hot events, so the
token bill is yours to manage. Prefer low-frequency events and set `overlap`
explicitly (`ignore`, the background default, merges repeat firings while an
audit is running); the global `maxConcurrent` semaphore is the last backstop.

`/sentinel:test` works for event rules too: the simulated content becomes the
payload (`name` stays the configured event name), e.g.
`/sentinel:test compact-review {"reason":"manual compact"}`.

### Template variables

`prompt` is rendered with Handlebars, pinned to `noEscape: true`, non-strict
(missing paths render as an empty string and are reported in the audit's
diagnostics), and the closed helper set `json`, `truncate`, `now`.

| Trigger          | Variables                                                                |
| ---------------- | ------------------------------------------------------------------------ |
| `tool_call`      | `tool`, `toolCallId`, `input` (`{{json input}}`, `{{input.command}}`, …) |
| `tool_result`    | `tool`, `toolCallId`, `input`, `content`, `isError`                      |
| `turn_end`       | `turnIndex`, `assistant`, `toolResults`                                  |
| `agent_end`      | `messageCount`                                                           |
| `event`          | `name`, `event` payload (`{{event.<field>}}`, `{{json event}}`)          |
| `context_tokens` | `tokens`, `threshold`, `level`, `messages` (increment since last firing) |

Every audit message is two-part: the rendered prompt plus a fixed
`--- 审计范围 ---` scope block. Tool triggers and `event` rules default to the
serialized event JSON; conversation triggers serialize `role + text`
transcripts, honoring the three `include*` switches (thinking is inlined as
`[thinking: …]`, redacted thinking is always omitted, tool calls render as
`[name(args)]`, images as `[图片 N 项]`).

### Model resolution

Audit model: `rule.model` → `defaults.model` → session model.
Configure dialog: `defaults.configure.model` → `defaults.model` → session model.
Thinking: `rule.thinking` → `defaults.thinking` → `"off"`. An unresolvable or
unauthenticated model counts as an audit failure (and is reported in the UI).

## Commands

| Command                                     | What it does                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `/sentinel:list`                            | List every rule with live state; in interactive mode enable/disable/remove |
| `/sentinel:fleet`                           | TUI inspector: live details, ~1s refresh, steer running audits             |
| `/sentinel:test <rule> [simulated content]` | Dry run through the full pipeline with zero dispatch side effects          |
| `/sentinel:configure [description]`         | Background natural-language config dialog; writes only on confirmation     |

Session-level changes (enable/disable/remove, dialog writes) are appended to the
session as an op-log, take effect immediately, and are replayed when the session
is resumed or forked. Removing is limited to session-added rules; inherited
rules are masked with disable instead.

## Behavior notes

- **Overlap**: `parallel` runs concurrently; `serial` queues FIFO without
  dropping; `ignore` drops while busy; `replace` aborts a running _background_
  audit and starts over (blocking `replace` waits instead). A global
  `maxConcurrent` semaphore is shared by all rules; saturation queues
  `parallel`/`serial`, drops `ignore`, and aborts-then-queues `replace`.
- **Audit failure**: the rule enters a 30s negative cooldown. `onFailure: open`
  allows the call and notifies; `closed` blocks with an explicit reason.
  Background failures are dropped and recorded.
- **Caching**: keys mix the rule name, rule definition hash, rendered prompt,
  and scope text. Cache hits go through the full dispatch path, so a cached
  `fail` still blocks and a cached `warn` still annotates the tool result.
- **Blocking latency**: every matching `tool_call` costs one extra LLM round
  trip. Use a fast model, keep prompts short, leave the cache on, and keep the
  rule set small. Multiple blocking rules for one call run concurrently.
- **Loading order**: `tool_call` handlers run serially and the first `block`
  short-circuits, so a sentinel loaded after another blocker never sees that
  call (which is fine — blocked calls need no audit).

## Relationship to `pi-permission-system`

They are complementary. Use `pi-permission-system` for deterministic,
auditable allow/deny rules on paths and commands; use `pi-sentinel` for
judgment calls that need language understanding ("does this edit match the
project's conventions?"). Both gate `tool_call`; when both block, the first
loaded blocker wins.

## Privacy

An audit sends the command text, file contents, and tool output in its scope to
the audit model's provider. On sensitive repositories, point `model` at a
trusted or local provider, and use the rule `tools` whitelist to bound what the
auditor can read (it defaults to no tools at all). Prompt scope is minimized by
default (`tool_*` audits see only the single call; `context_tokens` sees only
the increment), and `maxWindowTokens` caps the scope.

## Known limitations

- The auditor must support tool calling, because the verdict is a tool call.
- `maxWindowTokens` estimates tokens as characters/4, which systematically
  underestimates CJK text; lower it for Chinese-heavy projects.
- The auditor tool whitelist is limited to host built-in tools
  (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`). Extension-registered
  and MCP tools can be matched by `trigger.tools` but cannot be given to the
  auditor.
- Config files are read at session start and after plugin writes; external
  edits need a session restart.
- `writeFileConfig` re-parses the file before writing, so entries the loader
  already considers invalid are not preserved: hand-written rules that fail
  validation and unknown top-level keys are dropped on the next plugin write
  (they are warned about when the file is read). Keep invalid drafts out of the
  live config file.

## License

MIT
