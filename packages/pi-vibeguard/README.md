# pi-vibeguard

[English](README.md) | [中文](README-CN.md)

> **Local fork (`@xzzpig/pi-vibeguard`)** of [`@aizigao/pi-vibeguard`](https://github.com/aizigao/pi-vibeguard) (imported via git subtree, upstream v0.1.2).
> On top of upstream it adds two mapping-viewer commands:
>
> - `/vibeguard:list` — table of the current session's live placeholder mappings: CATEGORY | PLACEHOLDER | ORIGINAL (masked by default, press `r` to reveal) | TTL remaining; scroll with arrows / j/k / PgUp / PgDn, close with `q` or Esc.
> - `/vibeguard:stats` — per-category summary of live mappings, sorted by count.
>
> It also adds **session-scoped temporary suspension**: `/vibeguard:disable [category]` / `/vibeguard:enable [category]`, `/vibeguard:status`, and an interactive category picker at `/vibeguard:categories` — suspend redaction at runtime without restarting pi or editing the config file.
>
> Command output renders to the local TUI only and never enters the LLM context.

Inspired by [VibeGuard](https://github.com/inkdust2021/VibeGuard) and [opencode-vibeguard](https://github.com/inkdust2021/opencode-vibeguard).

A pi extension that:

- Replaces configured sensitive strings with placeholders **before requests are sent to the LLM provider** (the provider never sees plaintext)
- Restores placeholders back to the original text **after the model output completes** (more natural local display/persistence)
- Restores placeholders **before tool execution** (e.g. `bash` / `write` / `edit`) so local tools run with real values

Placeholder format (aligned with VibeGuard):

- Prefix: `__VG_`
- Shape: `__VG_<CATEGORY>_<hash12>__` or `__VG_<CATEGORY>_<hash12>_<N>__`
- `hash12` is the first 12 hex chars of `HMAC-SHA256(session-random secret, original)`, stable within a session and irreversible to the provider

## Install

### Local (project)

1. Copy `index.ts` to `.pi/extensions/vibeguard.ts`
2. Put `vibeguard.config.json` in your project root
3. Restart pi or run `/reload`

### npm (global)

```bash
pi install npm:@aizigao/pi-vibeguard
```

## Configuration

Config lookup order (first match wins):

1. Path specified by env var `PI_VIBEGUARD_CONFIG`
2. Project root: `./vibeguard.config.json`
3. Project `.pi` dir: `./.pi/vibeguard.config.json`
4. Global dir: `~/.pi/agent/vibeguard.config.json`

See `vibeguard.config.json.example` for a complete example.

```jsonc
{
  "enabled": true,
  "debug": false,
  "placeholder_prefix": "__VG_",
  "session": {
    "ttl": "1h",
    "max_mappings": 100000
  },
  "patterns": {
    "keywords": [
      { "value": "my-api-key-123", "category": "API_KEY" }
    ],
    "regex": [
      { "pattern": "sk-[A-Za-z0-9]{48}", "category": "OPENAI_KEY" },
      { "pattern": "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+", "category": "GITHUB_TOKEN" },
      { "pattern": "AKIA[0-9A-Z]{16}", "category": "AWS_ACCESS_KEY" }
    ],
    "builtin": ["email", "china_phone", "china_id", "uuid", "ipv4", "mac"],
    "exclude": ["example.com", "localhost", "127.0.0.1", "0.0.0.0"]
  }
}
```

> Safety note: if the config file is missing or `enabled=false`, the extension becomes a no-op.

## Behavior

When a sensitive value is matched, it is replaced with a placeholder (e.g. `sk-a0d309c77dd44d57be0f1a675c0zzzzz`). The LLM only sees the placeholder and may echo it back.

Example session:

```
User: Echo this value back verbatim: sk-a0d309c77dd44d57be0f1a675c0zzzzz

LLM:  sk-a0d309c77dd44d57be0f1a675c0zzzzz

User: Now output it as a character array

LLM:  ['_', '_', 'V', 'G', '_', 'O', 'P', 'E', 'N', 'A', 'I', '_', 'K', 
       'E', 'Y', '_', 'c', '1', '1', '3', 'f', '0', '6', 'b', 'c',
       '5', '0', 'a', '_', '_']
```

The LLM provider **never receives the original value** — it only sees placeholders. The LLM's output also contains placeholders, which is expected and harmless.

## Temporary suspension (session-scoped)

Sometimes you want redaction off for a while (e.g. asking the model to work with real example data). You can **temporarily suspend** redaction at runtime — no restart, no config edit.

Semantics:

- **While suspended, only NEW content skips redaction**: new user/tool/assistant content passes through as plaintext and produces no new placeholders.
- **Historical placeholders are unaffected**: placeholders already created earlier in the session are still automatically restored — both restore paths (before tool execution, and after assistant output) keep working while suspended.
- **State is session-scoped, in-memory only**: it lives in the current pi session and resets to the config `enabled` value after a pi restart or a new session. The on-disk `vibeguard.config.json` is never modified.

### Commands

| Command | Effect |
| --- | --- |
| `/vibeguard:disable` | Suspend everything — new content is no longer redacted (history still restores) |
| `/vibeguard:disable <CATEGORY>` | Suspend only that category, e.g. `/vibeguard:disable API_KEY` (unknown category prints the available list) |
| `/vibeguard:enable` | Full resume — all rules redact again |
| `/vibeguard:enable <CATEGORY>` | Resume only that category |
| `/vibeguard:status` | Show whether rules are active or which categories are suspended |
| `/vibeguard:categories` | Open the interactive category picker: `Space`/`Enter` toggles the focused row (row 0 = global), `↑/↓` `j/k` navigate, `q`/`Esc` closes |

Category names are case-insensitive. The status bar reflects the state: `VibeGuard[OFF]` (globally suspended), `VibeGuard[OFF:EMAIL,MAC]` (per-category suspended), `VibeGuard[ON]` (active).

### Example

```text
> /vibeguard:disable
  VibeGuard: 已整体挂起 —— 新内容不再脱敏；会话历史中的占位符仍会照常恢复（/vibeguard:enable 恢复）

  # New prompt: the phone number you type is sent to the model as plaintext …
  > /vibeguard:enable
  VibeGuard: 已整体恢复 —— 新内容将重新脱敏
```

## Debug

Set `PI_VIBEGUARD_DEBUG=1` environment variable or `"debug": true` in config.

```bash
PI_VIBEGUARD_DEBUG=1 pi
```

## License

MIT
