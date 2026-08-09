# @xzzpig/pi-terminal-notifications

`@xzzpig/pi-terminal-notifications` sends a desktop notification when Pi settles or
needs input, and mirrors pending input to Herdr through `herdr:blocked`.

It observes three public cross-extension APIs:

- `@eko24ive/pi-ask` lifecycle events.
- `@xzzpig/pi-permission-system` UI prompt, direct decision, and forwarded
  decision events. Forwarded requests are correlated with the parent response
  by `requestId`.

The extension is observational. A notification or event listener failure never
blocks Pi, a permission decision, or an agent loop.

## Install

Install the published package:

```bash
pi install npm:@xzzpig/pi-terminal-notifications
```

From a checkout of this monorepo:

```bash
pi install ./packages/pi-terminal-notifications
```

From the Git monorepo, load only this extension:

```json
{
  "packages": [
    {
      "source": "git:github.com/xzzpig/pi-extensions@main",
      "extensions": ["packages/pi-terminal-notifications/extensions/index.ts"]
    }
  ]
}
```

## Notification Protocols

The extension emits exactly one notification sequence per event. It resolves
`TERM_PROGRAM` against built-in mappings, then falls back to `osc99` when the
variable is unset or no mapping matches.

| `TERM_PROGRAM`     | Default protocol |
| ------------------ | ---------------- |
| `ghostty`          | `osc9`           |
| `iTerm.app`        | `osc9`           |
| `WezTerm`          | `osc9`           |
| `kitty`            | `osc99`          |
| `vscode`           | `osc99`          |
| `WarpTerminal`     | `osc777`         |
| missing or unknown | `osc99`          |

The defaults follow the documented notification protocols of
[iTerm2](https://iterm2.com/documentation-escape-codes.html),
[WezTerm](https://wezterm.org/escape-sequences.html),
[Ghostty](https://ghostty.org/docs/vt/osc/9), and
[kitty](https://sw.kovidgoyal.net/kitty/desktop-notifications/). The VS Code
and Warp mappings match the Herdr terminal notification profiles maintained in
the accompanying NixOS configuration.

All payload text is stripped of terminal control characters, OSC separators,
and excessive whitespace before it is written. This prevents application text
from escaping the selected notification protocol.

## Configuration

The optional global configuration file is:

```text
~/.pi/agent/extensions/pi-terminal-notifications/config.json
```

Start from [`config/config.example.json`](./config/config.example.json). Its
`termPrograms` object extends or overrides the built-in mappings; `fallback`
changes the protocol used for an unknown terminal.

```json
{
  "fallback": "osc99",
  "termPrograms": {
    "WezTerm": "osc777",
    "MyTerminal": "osc9"
  }
}
```

Valid protocol names are `osc9`, `osc99`, and `osc777`. Invalid, unreadable,
or missing configuration safely uses the built-in defaults. The JSON schema is
available at [`config/config.schema.json`](./config/config.schema.json).

## Permission And Herdr Lifecycle

A `pi-ask` or visible permission prompt marks Herdr as blocked. The state is
cleared only after all active asks and prompts finish. For a direct permission
ask, the local `permissions:decision` event resolves the prompt.

For a permission ask forwarded from a child session, the parent UI emits
`permissions:ui_prompt` with a non-null `forwarding` context. After the parent
successfully persists its response, `pi-permission-system` emits exactly one
`permissions:forwarded_decision` with the same `requestId`; this extension uses
that event to resolve the parent-side blocked state. The child later emits its
own `permissions:decision` when its original gate consumes the response. The
extension does not read private forwarding files, and session shutdown clears
any remaining state.

Terminal control sequences are written only in Pi TUI mode. Herdr lifecycle
state is still maintained in other modes.

## Development

From the repository root:

```bash
pnpm --filter @xzzpig/pi-terminal-notifications run typecheck
pnpm --filter @xzzpig/pi-terminal-notifications test
```
