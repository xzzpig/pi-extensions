# Changelog

All notable changes to the `@xzzpig/sandbox-runtime` fork are documented here.
This fork tracks [`carderne/sandbox-runtime`](https://github.com/carderne/sandbox-runtime)
(itself derived from Anthropic's sandbox-runtime) via git subtree; entries below
describe only fork-specific deviations from upstream.

## 0.0.71

### Added

- **`network.disabled` switch.** Setting `disabled: true` on the network config
  turns off all network policy enforcement while leaving filesystem and
  credential-env restrictions untouched: no network rules are emitted, no local
  mux/HTTP/SOCKS proxy or Linux bridge is started, macOS seatbelt profiles emit
  `(allow network*)`, and Linux bwrap commands skip `--unshare-net` so sandboxed
  processes share the host network namespace. Wrap paths compute the flag with
  the same per-call override precedence as `filesystem.disabled` (a per-call
  network block owns its `disabled` key outright). Note that toggling network
  enforcement back on for a running session requires `reset()` +
  `initialize()`: a proxy skipped at initialization time cannot be adopted by a
  later wrap-time override.

## 0.0.70 (fork baseline)

### Changed

- Renamed `protectNonexistentDangerousFiles` to `protectNonexistentFiles`
  (default `true`): when `false`, bwrap no longer mounts read-only placeholders
  over not-yet-existing dangerous files, so no temporary dotfiles are
  materialized in allowed write paths during command execution; existing files
  and dangling symlinks stay fully protected.
- Published locally as `@xzzpig/sandbox-runtime` (upstream package name kept
  out of npm).
