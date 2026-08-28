# Changelog

## 0.1.1
- Config lookup (first match wins):
  1. `PI_VIBEGUARD_CONFIG` env var
  2. `./vibeguard.config.json` (project root)
  3. `./.pi/vibeguard.config.json` (project .pi dir)
  4. `~/.pi/agent/vibeguard.config.json` (global)

## 0.1.0

- Initial release: pi-vibeguard extension
- Replace sensitive strings with VibeGuard-compatible placeholders before LLM requests
- Restore placeholders before tool execution
- Config format compatible with opencode-vibeguard
- Built-in patterns: email, china_phone, china_id, uuid, ipv4, mac
- Support for keyword and regex patterns with exclude list
- Placeholder format: `__VG_<CATEGORY>_<hash12>__` (HMAC-SHA256)
- Session-specific random secret ensures placeholders are irreversible to the provider
- Zero external dependencies (node: built-ins only)
