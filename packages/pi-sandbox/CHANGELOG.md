# Changelog

All notable changes to the `@xzzpig/pi-sandbox` fork are documented here.
This fork tracks [`carderne/pi-sandbox`](https://github.com/carderne/pi-sandbox)
via git subtree; entries below describe only fork-specific deviations from
upstream.

## 0.5.0

### Added

- **Named sandbox profiles for subagents.** The global `<agentDir>/sandbox.json`
  may define a `profiles` map whose entries a `pi-subagents` child selects by
  name from agent frontmatter (`sandbox: reviewer-strict`). A profile replaces
  `network.allowedDomains`, `filesystem.allowRead`, and
  `filesystem.allowWrite` so it can narrow a role, while
  `network.deniedDomains`, `filesystem.denyRead`, and `filesystem.denyWrite` are
  unioned so no profile or allow list can drop an inherited hard denial.
  `inheritGlobalConfig` (default `true`) keeps the ordinary global configuration
  as the profile's base; `false` starts from the built-in safe defaults instead.
  Project layers participate only after Pi marked the project trusted. A
  selected profile never disables the sandbox, network isolation, or filesystem
  isolation.
- **Profile-only hard-deny hardening.** `denyRead` is checked before the native
  `read` tool can prompt, malformed profile deny lists are rejected instead of
  being ignored, and a literal `denyWrite` path forces
  `protectNonexistentFiles` so Bash cannot create a hard-denied target before it
  exists. Ordinary (profile-free) configuration keeps its previous behavior.
- **Startup acknowledgement and failure diagnostics for the child launcher.** A
  profile child writes a bounded acknowledgement once its policy is active, and
  writes the failure reason (including the available profile names) to a
  diagnostics file the launcher reads back.

### Fixed

- **A headless child no longer fails profile startup over cosmetic UI.** The
  status footer is rendered only in TUI sessions, and a failing notification can
  no longer mark a working sandbox as failed — previously a print/json child
  (which never initializes a theme) blocked every sandboxed subagent.
- **Launch environment values are captured at registration.** The
  acknowledgement channel, project trust flag, and diagnostics path are read
  while the launcher's transient environment is active, instead of later in
  `session_start` after those keys were restored.
- **An in-process child no longer sets the host exit code** when its profile is
  blocked; only a standalone child process reports that failure through its exit
  status.

## 0.4.1

### Changed

- **Synced upstream 0.6.5 → 0.6.6.** Adopted upstream's bundled-seccomp
  helper exposure on Linux (`buildRuntimeConfig` gains a platform parameter
  and adds the runtime's `vendor/seccomp` directory to `allowRead`, resolved
  from `@xzzpig/sandbox-runtime`), the `sandboxUserShell: false` config that
  skips sandboxing of user shell (`!cmd`) input, the exec teardown fix that
  stops hangs after an agent subprocess daemonizes while holding stdio pipes
  (#76), and `allowPty` passthrough to the sandbox extension (#75). Fork
  features preserved: the `network.disabled` guard composes with upstream's
  `sandboxUserShell` early return in the `user_bash` handler, and
  `protectNonexistentFiles` lstat existence filtering is unchanged. Upstream
  tests are taken with the fork's denyWrite / protectNonexistentFiles /
  network.disabled tests re-appended.

## 0.4.0

### Added

- **`network.disabled` switch.** Setting `"network": { "disabled": true }`
  in `sandbox.json` turns off every network restriction while keeping the
  filesystem sandbox fully active: no domain prompts for bash or `!cmd`, no
  OS-level network isolation (macOS seatbelt emits `(allow network*)`; Linux
  bwrap skips `--unshare-net`), no local proxy listeners, and
  `NODE_USE_ENV_PROXY` is no longer set. The status footer reports
  "network unrestricted" and `/sandbox` marks the configuration accordingly;
  the `allowedDomains: ["*"]` warning is suppressed as meaningless in this
  mode. Defaults to absent/false, preserving upstream behavior exactly.
  Requires `@xzzpig/sandbox-runtime` 0.0.71+ (its `network.disabled` support).

## 0.1.0

### Added

- **Optional pi-tool-display bash rendering integration.** After registering
  the sandboxed `bash` tool, the fork reaches pi-tool-display's decoration API
  through a guarded dynamic import of
  `pi-tool-display/tool-display-api-consumer` and decorates the tool with
  `{ kind: "bash", overrideExistingRenderers: true }` — pi-tool-display takes
  over rendering (spinner + elapsed time, configurable output modes) while the
  fork keeps full control of execution and permission handling. There is no
  hard dependency: when pi-tool-display is absent (import fails) or loads
  later (decoration queued and drained once the API is installed), the bash
  tool safely keeps pi's built-in default rendering and sandbox behavior is
  unchanged. The integration is documented in the README, including the
  coexistence requirement to keep `pi-tool-display`'s
  `registerToolOverrides.bash` set to `false` so pi-tool-display does not
  register its own (non-sandboxed) bash tool.

### Changed

- Initial fork of `carderne/pi-sandbox` v0.6.5, published as
  `@xzzpig/pi-sandbox`.