# Changelog

All notable changes to the `@xzzpig/sandbox-runtime` fork are documented here.
This fork tracks [`carderne/sandbox-runtime`](https://github.com/carderne/sandbox-runtime)
(itself derived from Anthropic's sandbox-runtime) via git subtree; entries below
describe only fork-specific deviations from upstream.

## 0.0.74

### Changed

- Fixed embedded-session filesystem policy when the host and session cwd differ: glob patterns keep their syntax while becoming session-relative, and both string/argv runtime wrappers scope Linux scans and macOS mandatory deny rules to the explicit per-command cwd without process-wide chdir.
- Synced upstream `v0.0.72` → `v0.0.76`: dedicated `/tmp/agents` setup, private `/proc` dependency diagnostics, and complete `denyMandatoryCwdFiles` plumbing through `wrapWithSandbox`.
- Kept native `network.disabled` precedence and `protectNonexistentFiles`. The mandatory-CWD switch composes with the fork's nonexistent-path filter without dropping explicit `denyWrite` rules.
- Preserved the upstream npm lock dependency graph; only the two root name/version pairs follow the independently versioned fork.

## 0.0.73

### Changed

- **Conflict-surface refactor, no behavior change.** `pathEntryLstatExists` is now exported (also re-exported from the package root) for the pi-sandbox fork, whose duplicate `pathEntryExists` was removed; the network-disabled precedence logic consolidated into fork-only `src/sandbox/fork-network.ts` (`isNetworkDisabled`); the protectNonexistentFiles tests moved from `test/sandbox/mandatory-deny-paths.test.ts` (byte-identical to upstream again) to fork-only `test/sandbox/protect-nonexistent-files.test.ts`.

## 0.0.72

### Changed

- **Synced to upstream `v0.0.72`** (from `v0.0.70`), which bundles two upstream
  releases: `feat: add independent sandbox manager instances (#20)` — separate
  `createSandboxManager()` sessions with their own policy and proxies, a reworked
  proxy/lifecycle core in `sandbox-manager.ts`, a Windows `srt-win` installer and
  proxy-port-range pass, plus new `manager-instances` / `winsrt` / `proxy-env-vars`
  coverage — and `fix: reject sandbox commands when the network proxy is unavailable
(#19)`. The fork's `network.disabled` and `filesystem.protectNonexistentFiles`
  behavior is re-applied on top of the refactor and is unchanged.
- `wrapWithSandbox()` now fails closed when network restriction is requested but no
  proxy is running (upstream #19): a per-call `network` block that omits `disabled`
  after a session initialized with `network.disabled: true` now throws
  `Sandbox network proxy is not initialized` instead of silently emitting a
  hard-blocked command. Toggle network enforcement with `reset()` + `initialize()`.
  Callers that pass no per-call `network` block (e.g. pi-sandbox) are unaffected.

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
