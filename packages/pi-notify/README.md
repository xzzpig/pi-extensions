# @xzzpig/pi-notify

Cross-device notifications for Pi. Supports **OSC terminal notifications** (OSC 9 / 99 / 777) and **ntfy push channels** with configurable priority, icons, and per-instance event subscriptions. Integrates with `pi-ask`, `pi-permission-system`, `pi-subagents`, and exposes a public `publishNotification` API for third-party plugins.

## Install

```bash
pi install npm:@xzzpig/pi-notify
```

From this monorepo:

```bash
pi install ./packages/pi-notify
```

## Migration from `@xzzpig/pi-terminal-notifications`

1. Uninstall the old package: `pi remove @xzzpig/pi-terminal-notifications`
2. Install the new package: `pi install npm:@xzzpig/pi-notify`
3. Migrate `~/.pi/agent/extensions/pi-terminal-notifications/config.json` to the new format (see [Configuration](#configuration) below).
4. Restart the session (`/reload`).

The old package is deprecated and will be removed from npm in a future release.

## Configuration

Global config: `~/.pi/agent/extensions/pi-notify/config.json`

**Trusted** project config: `./.pi/pi-notify.json` (partial overlay; merges by channel id; unknown project configs are never read).

The full schema is available at `config/config.schema.json` or from the published jsDelivr URL.

### Defaults

Without any config file, the built-in `terminal` OSC channel is enabled with the default six events:

| Event ID              | Title                               | Default priority |
| --------------------- | ----------------------------------- | ---------------- |
| `agent-completed`     | Pi finished the task                | 3                |
| `agent-error`         | Pi encountered an error             | 5                |
| `input-required`      | Pi needs your input                 | 4                |
| `permission-required` | Pi needs permission                 | 4                |
| `context-compacted`   | Pi compacted the context            | 2                |
| `task-completed`      | Pi completed a task                 | 3                |
| `integration-error`   | Pi encountered an integration error | 5                |

`context-compacted` is not in the default subscription set; it must be added explicitly.

### Example

```json
{
  "$schema": "https://raw.githubusercontent.com/xzzpig/pi-extensions/main/packages/pi-notify/config/config.schema.json",
  "version": 1,
  "enabled": true,
  "herdr": { "enabled": true },
  "channels": [
    {
      "id": "terminal",
      "type": "osc",
      "events": [
        "agent-completed",
        "agent-error",
        "input-required",
        "permission-required",
        "task-completed",
        "integration-error"
      ],
      "osc": { "fallback": "osc9", "termPrograms": { "MyTerminal": "osc777" } }
    },
    {
      "id": "phone",
      "type": "ntfy",
      "events": [
        "agent-completed",
        "agent-error",
        "input-required",
        "permission-required",
        "task-completed",
        "integration-error"
      ],
      "ntfy": {
        "serverUrl": "https://ntfy.sh",
        "topic": "${PI_NOTIFY_TOPIC}",
        "token": "${PI_NOTIFY_TOKEN}",
        "priority": 3,
        "timeoutMs": 5000,
        "eventOptions": {
          "agent-error": { "priority": 5 },
          "permission-required": { "priority": 4, "icon": null }
        }
      }
    }
  ]
}
```

### Environment variable expansion

String values are expanded with `dotenv-expand@13.0.0` semantics:

- `$VAR` and `${VAR}` — expand from the process environment
- `${VAR:-default}` — use a default value when the variable is unset or empty
- `\$VAR` — literal `$VAR`
- `$(...)` — never executed as a shell command

**WARNING:** The pinned version `13.0.0` is safe. The v1000 line introduces `$(...)` command substitution and MUST NOT be used.

### Project overlay

A trusted project may provide a partial overlay that merges by channel id:

```json
{
  "channels": [{ "id": "phone", "ntfy": { "topic": "${PROJECT_NTFY_TOPIC}" } }]
}
```

Changing a channel's `type` discards the inherited type-specific config; only
`id`, `enabled`, and `events` survive.

## OSC Terminal Protocol

Protocol auto-selection order:

1. `KITTY_WINDOW_ID` present → **OSC 99** (kitty)
2. `TERM_PROGRAM` mapping → user override or built-in
3. Fallback → **OSC 9** (default)

| `TERM_PROGRAM`     | Protocol | Notes                                                             |
| ------------------ | -------- | ----------------------------------------------------------------- |
| `ghostty`          | OSC 777  | Ghostty 1.2.0+                                                    |
| `iTerm.app`        | OSC 9    | body only                                                         |
| `WezTerm`          | OSC 777  |                                                                   |
| `WarpTerminal`     | OSC 777  |                                                                   |
| `vscode`           | OSC 99   | VS Code 1.111+ (Enable `terminal.integrated.enableNotifications`) |
| missing or unknown | OSC 9    |                                                                   |

OSC sequences are only written in TUI mode. Each OSC 99 notification gets a unique identifier. All text is sanitized (control characters stripped, `;` → `:`, whitespace collapsed, 512 Unicode code point limit).

## ntfy Push Protocol

- POST to `{serverUrl}/{topic}` with plain text body
- Headers: `Title`, `Priority`, `Icon` (optional), `Authorization: Bearer <token>` (optional)
- Priority resolution: `eventOptions[event].priority` > explicit instance `priority` > built-in per-event level
- Icon resolution: `eventOptions[event].icon` > explicit instance `icon` > default Pi icon (versioned jsDelivr URL)
- `null` icon explicitly disables the Icon header
- Default timeout: 5000 ms (positive finite integer; no upper limit)
- **Fire-and-forget**: failures are never retried; no integration-error is produced
- Delivery errors are sanitized (status code only, no token/URL leak)

## Herdr Blocked State

The `herdr:blocked` contract is maintained independently of the notification
`enabled` flag. `herdr.enabled` (default `true`) controls whether blocked-state
events are published. The state machine tracks the first active ask/permission
item and clears only when all items resolve.

## Public API

Import from `@xzzpig/pi-notify/api`:

```typescript
import {
  publishNotification,
  NOTIFICATION_EVENT_IDS,
  isPiNotifyPublishPayload,
} from "@xzzpig/pi-notify/api";
```

- `PI_NOTIFY_PUBLISH_EVENT` — channel name
- `NOTIFICATION_EVENT_IDS` — closed array of event IDs
- `NotificationEventId` — union type
- `PiNotifyPublishPayload` — interface (`eventId`, `source`, `label?`)
- `PiNotifyEventBus` — `{ emit(channel, data): unknown }`
- `isPiNotifyPublishPayload(value)` — type guard
- `assertPiNotifyPublishPayload(value)` — throws `TypeError` on invalid payload
- `publishNotification({ events, eventId, source, label })` — emits a validated payload on the event bus

Raw `pi-notify:publish` events from untrusted plugins are validated
defensively; invalid payloads are silently ignored with a local warning.

> **Calling `publishNotification`** — call it only while Pi's extension
> context is active: inside `session_start`/`session_shutdown` handlers, event
> listeners (`pi.events.on`), or other Pi lifecycle callbacks. `events.emit`
> is guarded by Pi's context assertion, so calling it from a delayed
> `setTimeout`/`setInterval` callback, a background async task, or after the
> session has ended (`ctx.newSession()`/`fork()`/`switchSession()`/`reload()`,
> or as a headless `--print` run finishes) throws Pi's
> `extension ctx is stale after session replacement or reload` error.
> Build/release events should be published inside the Pi callbacks that
> observe them, never from detached timers.

## Development

```bash
# from the repository root
pnpm install
pnpm --filter @xzzpig/pi-notify run typecheck
pnpm --filter @xzzpig/pi-notify test
```

### Live ntfy smoke test

```bash
PI_NOTIFY_SMOKE_TEST=1 \
  PI_NOTIFY_SMOKE_URL=https://ntfy.sh \
  PI_NOTIFY_SMOKE_TOPIC=my-topic \
  pnpm --filter @xzzpig/pi-notify test
```

## License

MIT
