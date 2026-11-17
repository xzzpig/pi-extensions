# Fork Changelog

Release history for `@xzzpig/pi-subagents`; version headings refer only to this fork.
Upstream history: [CHANGELOG.md](./CHANGELOG.md).
Current upstream baseline (not a claim about older releases): [v0.88.0 / c99503aed6d6](https://github.com/nicobailon/pi-subagents/tree/c99503aed6d6b20d2397a1767f7d60730efe3963).

Historical entries below were migrated from the repository's existing changelogs; missing dates and historical baselines have not been invented.

### Undated historical fork changes

These notes were already present without a release version; they are not new unreleased changes.

#### Previous fork changes

### Changed

- **Synced upstream `v0.74.0` → `v0.75.0`**: background subagents work on Pi 1.0.0
  again (upstream's own fix for the dropped `@earendil-works/pi-agent-core/node`;
  the fork's best-effort `resolveHostPeerAliases` already covered this), per-launch
  Claude Code `model`/`thinking` (`:level`/`--effort`, enforced by
  `subagents.maxThinking`/`modelScope`), `registerRequiredChildExtensions`
  `requireForAllRunners`, child launches on extension-registered virtual models with
  corrected verification (`session?.virtualModelId`), failing config load on invalid
  `authorityPolicy`/`permissions`/`toolBudget` values, async runs recorded in
  `run-history.jsonl`, MCP tool-name `-`→`_` conversion, parent-side bash
  `command.status`/`yield`/`cancel` for native children, and Windows npm-installed
  external CLIs. The fork's projectTrusted threading, `hostAvailableBuiltins`
  (`getHostBuiltinToolNames`), `sandbox`/`permission-profile` agent fields,
  env-capture restore, `.then(() => undefined)` steer/followUp wrappers, and the
  `projectScopedProfileTrustError` import were re-applied beside upstream's changes.

- **Synced upstream `v0.72.0` → `v0.74.0`**: fenced ```` ```js workflow ```` blocks
  replacing `workflowScript`/`workflowScriptPath` (`workflow: true`), `toolActivation`
  (eager/dynamic/auto) and `disabledFeatures` config, Pi built-in MCP selections
  (`mcp:` tools, codemode in children), `subagents.modelScope` `scoped` token,
  `agentOverrides.<name>.advertise`, untrusted-project respect for children,
  `/reload` no longer killing background workflows, and the undici 8.10.2 security
  bump. The fork's projectTrusted/sandbox/permissionProfile threading, native
  fleet transcript, context injection, and `as StreamFn` casts were re-applied;
  upstream's duplicate `sessionProjectTrust` fields were dropped in favor of the
  fork's `currentProjectTrusted`/`trustedProjectCwd`. The shim fixture gains the
  Pi 1.0.0 normalized `systemPromptOptions` shape.
- Peer range follows the workspace Pi 1.0.0 baseline (`>=1.0.0 <2` for pi-ai);
  devDeps pin pi-agent-core/pi-ai/pi-tui at exact `1.0.0` per the fork manifest
  invariant.
- Synced upstream `v0.71.0` → `v0.72.0`: lazy subagent executor/Fleet loading,
  global npm root discovery for package agents, external inspector
  registration (`pi-subagents/inspectors` API, lazy `openSubagentFleet`
  loading with the `getInspectorPlugins` getter), fast-mode accepting any
  native `openai-codex/*` model via provider-prefix matching, watchdog helper
  model calls routed through `modelRegistry.streamSimple`, `typebox` moved to
  an optional peer dependency, and the `before_agent_start` advertised-agent
  wait. The fork's `events`/inspector wiring, context injection,
  sandbox/permission-profile threading, and the eject delegation were
  re-applied on top; SDK pins stay at pi `0.87.0` (upstream pairing) with the
  fork's `as StreamFn` casts extended to the three retargeted watchdog/audit
  stream call sites.
- Synced upstream `v0.68.0` → `v0.71.0`: workflow terminal proof and readable
  child session names, runner-side stripping of inherited Git routing
  environment, symlinked prompt workflow file discovery, runner exit
  code/signal reporting for dead runners, structured-only child terminal
  settlement, compiled Bun host package root discovery, and the
  `subagent-runner-bootstrap` entry with tool-activation smoke coverage.
- SDK baseline raised to pi `0.87.0` (devDependencies); the
  `pi-coding-agent` type/runtime shim gains the `streamSimple` registry
  member.
- Fork `sandbox` / `permissionProfile` / `hostAvailableBuiltins` threading
  and the fleet-native transcript renderer were re-applied on top of the
  upstream runner refactor; upstream's removal of `completionGuard` was
  adopted.

## [0.25.1] - 2026-11-15 (fork)

### Changed

- **Conflict-surface refactor, no behavior change.** Fleet transcript reading now
  lives in one shared reader (`shared/fleet-transcript-reader.ts`); the TUI fleet
  pane only keeps its renderer, so both the run-status and transcript views parse
  child sessions through the same code.
- The fork's tool-result handler moved out of the upstream run closure into
  fork-only `src/runs/foreground/fork-tool-result-handler.ts` (budget blocking,
  mutating-failure escalation, supervisor progress publication, bounded
  call-id de-duplication unchanged); `execution.ts` keeps one factory call.
- Packaging identity (repository URL, files allowlist, lockfile policy) is
  enforced by `scripts/check-fork-identity.mjs` instead of per-package replay prose.

## [0.25.0] - 2026-11-13 (fork)

### Changed

- **Synced upstream `v0.84.0` → `v0.88.0`**: latest child progress in the
  widget, paused `timeoutMs` while a child waits for a supervisor answer,
  monotonic run clocks, truncated-reply detection, `list` search filter,
  forked-session cleanup, workflow child-launch approval through `tool_call`
  handlers, editor-hint API, and Pi Desktop / Windows / MCP fixes.
- Re-applied every fork seam on the new upstream shapes: supervisor responder
  side channel (with upstream's `endedRequests` lifecycle), context injection,
  sandbox/permission profiles, goal auto-continuation gate, native Fleet
  transcripts, host-available builtins, tool-budget blocked detection, and the
  `@xzzpig` package identity.
- Extended the lightweight SDK shim with the Pi 1.2 `ExtensionToolContext` /
  `ToolDefinition.exposure` surface used by the new deferred
  `subagent_launch` tool, and registered the new upstream real-SDK test in
  `fork-test-environment.mjs`.
- Kept the fork's shared `handleToolResult` dedup path for tool results while
  adopting upstream's `progressText` propagation so the widget shows the
  latest successful child progress.

### Upstream provenance

- Upstream v0.84.0: [source 0398b9e8d6f0](https://github.com/nicobailon/pi-subagents/tree/0398b9e8d6f03dc6054dbf13dfe851c7a20bff3a); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/f9e51d2d2c3116fd3ae63ed4e19d0ea1eeb1bf82/subtrees/pi-subagents.json).
- Upstream v0.88.0: [source c99503aed6d6](https://github.com/nicobailon/pi-subagents/tree/c99503aed6d6b20d2397a1767f7d60730efe3963); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/49ccf05e5135153bb7c3cb4e47e408b84cd38374/subtrees/pi-subagents.json).

## [0.24.2] - 2026-11-01 (fork)

### 维护

- 同步内嵌共享库依赖至 pi-components 0.5.0；fleet 继续使用既有无状态渲染入口，不隐式启用新的有状态展示策略。

## [0.24.1] - 2026-10-31 (fork)

### Fixed

- Coordinate goal auto-continuation with current-session async, workflow and
  detached foreground runs while their native parent wake or result handoff is
  pending. Preserve completion ownership and scheduled wake policy through
  live and restored job projections without intercepting native notifications.

## [0.24.0] - 2026-10-30 (fork)

### Security

- Sync upstream `v0.83.1` → `v0.84.0`, including the workflow-script sandbox
  hardening for GHSA-6v8j-6w28-2w8r and the corresponding regression tests.

### Changed

- Adopt upstream's 90-day retention window for resumable background runs and
  results, while retaining its existing reference and active-run protections.
- Explain when a background child cannot load an extension-provided model while
  preserving the fork's trust, sandbox, and permission-profile launch seams.

### Upstream provenance

- Upstream v0.83.1: [source 312082429bda](https://github.com/nicobailon/pi-subagents/tree/312082429bda07714fe0fe7729fe8d4935de4c5a); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/ba8b518d6237d5ce6b43353dc2f735832d743ecb/subtrees/pi-subagents.json).
- Upstream v0.84.0: [source 0398b9e8d6f0](https://github.com/nicobailon/pi-subagents/tree/0398b9e8d6f03dc6054dbf13dfe851c7a20bff3a); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/f9e51d2d2c3116fd3ae63ed4e19d0ea1eeb1bf82/subtrees/pi-subagents.json).

## [0.23.0] - 2026-10-29 (fork)

### Changed

- Sync upstream `v0.77.0` → `v0.83.1`, including session-scoped background
  lifecycle, held wakes and notification recovery, Rex placement, and the
  `undici` 8.12.3 security update. The minimum supported Pi version is 1.2.
- Publish the compiled, bundled `dist-pkg` artifact while retaining the fork's
  public subpaths, supervisor routing, native Fleet transcript, and bundled
  `pi-components` dependency.
- Foreground children receive their own extension bindings without inheriting
  the parent's bindings; permission profiles remain pinned and the parent
  process environment is restored after startup.
- Failed child commands return Pi's error result with a failed command status
  instead of throwing, so later commands can still run.

### Upstream provenance

- Upstream v0.77.0: [source 1ac9b964eb9c](https://github.com/nicobailon/pi-subagents/tree/1ac9b964eb9cda1662507c52f5277764637daccc); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7ecf2299f09844d1730e6b86af8d791a6453e899/subtrees/pi-subagents.json).
- Upstream v0.83.1: [source 312082429bda](https://github.com/nicobailon/pi-subagents/tree/312082429bda07714fe0fe7729fe8d4935de4c5a); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/ba8b518d6237d5ce6b43353dc2f735832d743ecb/subtrees/pi-subagents.json).

## [0.22.0]

### Added

- 新增 `@xzzpig/pi-subagents/supervisor-routing` 导出:版本化的父会话内 supervisor 响应器注册
  (`registerSupervisorResponderViaEvents`),作用域为 sessionId + delegation requestId + ownerRunId + nodeId + agent。
- 结构化委派执行器新增内部 launch hooks:在真实 foreground runId 分配、canonical agent 解析之后、
  任何 child prompt 之前触发 `beforeNativeChildLaunch`,不改变模型可见的 request schema 或子进程环境。
- 原生 supervisor 通道支持独占接管:被接管的提问不再唤醒主模型、不再触发 detach,回复仍走文件权威写入。

## [0.21.0] - 2026-10-10 (fork)

### Changed

- Sync upstream `v0.75.0` → `v0.77.0`: slimmer tool declarations, bounded inline
  result previews, opt-in native runner launchers, calendar schedules, reviewed
  worktree cleanup, reliable parent wakes, and canonical mission storage paths.
- Context injection now excludes untrusted project contributions and refreshes
  across trust changes without retaining a stale project advertisement.
- Preserve sandbox/permission profiles, context injection, native Fleet transcripts,
  and the Pi 1.0.0 baseline; align the test fixture with the SDK APIs used upstream.

### Fixed

- Read each tool result's own tool name before the pending-call fallback, so an
  overlapping blocked bash call is not attributed to an unfinished read.
- Retry failed native Fleet transcript reads without caching the failure.
- Preserve permission-profile enforcement when native launchers route children to
  background runners, including explicit empty extension lists.
- Treat Pi 1 command `isError` results as failures while retaining targeted
  cancellation and run-abort semantics.

### Upstream provenance

- Upstream v0.75.0: [source ad56bf92fe01](https://github.com/nicobailon/pi-subagents/tree/ad56bf92fe01a2a5abd962938c619eb2a22ca47d); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/c34d3358f81d7fabbe7b0b337be406d2d1739eb0/subtrees/pi-subagents.json).
- Upstream v0.77.0: [source 1ac9b964eb9c](https://github.com/nicobailon/pi-subagents/tree/1ac9b964eb9cda1662507c52f5277764637daccc); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7ecf2299f09844d1730e6b86af8d791a6453e899/subtrees/pi-subagents.json).

## [0.16.0] - 2026-09-22

### Changed

- **A child in a subdirectory of a trusted project inherits the sandbox trust
  stamp** (OpenSpec change `add-project-scoped-profiles`). The launcher's
  `PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED` emission (`hasTrustedProfileProjectCwd`)
  now treats a child cwd equal to or a descendant of the parent session's
  trusted project cwd as trusted, matching the platform's
  `findNearestTrustEntry` ancestor semantics, so a project's sandbox-profile
  definitions apply from any subdirectory of a trusted project root instead of
  only from the exact root cwd. The selection-side `projectScopedProfileTrustError`
  guard keeps its exact-cwd matching unchanged.

## [0.15.1] - 2026-09-19

### Changed

- **Conflict-surface refactor, no behavior change.** The agent-eject implementation moved to fork-only `src/agents/agent-eject.ts`; the sandbox/permission-profile resolution and launch-env construction moved to fork-only `src/runs/shared/profile-extensions.ts` and `profile-launch-env.ts` (all error messages byte-identical); profile-name validation and project-trust error copies were deduplicated into the fork-only shared modules; fork test blocks moved out of five upstream test files (now byte-identical to upstream) into `test/unit/fork-*.test.ts`; fork documentation chapters moved to `docs/fork-extensions.md`.

## [0.15.0] - 2026-09-17

### Changed

- **Synced to upstream v0.68.0 (adopted upstream removal of automatic model switching).** The upstream architecture no longer retries a different model within the same launch (`fallbackModels`), continues read-only HTTP 429 work on a different model, or persists model exclusions; each launch now resolves exactly one model and retries that same model at most twice. The fork adopts that removal wholesale while keeping its sandbox-profile, permission-profile, context-injection, silent-span, ejectable-agent, and fleet-native-transcript features on top.
- **Pane-native remote Pi placement (Herdr) is now part of the fork.** Upstream v0.68.0 adds running subagents on saved remote machines via Herdr panes, consolidates `src/inspectors/herdr/` into `src/inspectors/`, and splits the async execution tests into part files; the fork keeps its own `openSubagentFleetFromStatus` wrapper with an `inspectorPlugins` passthrough.
- Test fixtures were adapted for the fork's own version number (the bridge identity check compares `packageVersion` to the fork's package version) and for NixOS hosts where `/usr/bin`/`/bin` are not FHS-populated (mock `mktemp`/`rm`/`cat` are supplied in the deterministic remote PATH and the deterministic-PATH assertion tolerates host-injected suffixes).

### Upstream provenance

- Upstream v0.68.0: [source f3ccf47dc236](https://github.com/nicobailon/pi-subagents/tree/f3ccf47dc236b6c0fcc0d897cec4a9e6da3e916d); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/9aea4eef84c30f5c049acd6b688f309bb4d14abc/subtrees/pi-subagents.json).

## [0.14.0] - 2026-09-13

### Fixed

- **The fleet inspector no longer drops replayed thinking and assistant messages.** The structured transcript view upserted thinking and assistant text per turn (`upsertText`, whose contract is latest-wins), so a whole child turn collapsed into its last thinking block and last answer — measured on real transcripts, 38 thinking blocks became 1 entry, and it rendered at the very top of the panel while the view auto-followed the bottom. Replay now appends one entry per persisted assistant message, opens a new turn after a finished answer (so the reader's tail window no longer needs the original user record to separate turns), and reads a 600-record window instead of 240 (still capped by the 2 MiB byte limit).

### Added

- **Thinking expansion in the fleet inspector.** Replayed thinking blocks are collapsed by default to a `Thinking (t/T to expand)` label; the new `toggleThinking` Fleet binding (`t`/`T`) expands and collapses them. The plain-text view (`v`) carries no thinking entries, so the toggle stays inert there.

## [0.13.0] - 2026-09-11

### Changed

- **Sandbox profile env is pinned per child launch.** Every child launch now writes `PI_SUBAGENT_PERMISSION_PROFILE` explicitly (cleared when the child declares no profile) and drops launcher-owned `PI_SUBAGENT_*PROFILE*` keys from the runner's inherited environment, so a spawned child can neither inherit a host-session role selection nor override its own. The launch also sets `PI_SUBAGENT_PERMISSION_PROFILE_PINNED=1` to tell the permission system that this process owns a launched selection.

### Added

- **Public agent discovery API.** `pi-subagents/agents` now exports `discoverAgentsWithRuntime(pi, cwd, scope, preferredModelProvider?)` alongside the existing registration surface, plus the `AgentConfig`, `AgentDiscoveryDiagnostic`, `AgentDiscoveryResult`, and `AgentScope` types. It returns the same merged view the subagent executor uses — builtin, package, user, and project agent files combined with agents registered at runtime — so an independent extension can offer the launcher's agent list instead of re-implementing discovery. The extension's own runtime discovery now calls the same function.

## [0.12.0] - 2026-09-11

### Added

- **`permission-profile` agent frontmatter.** A custom agent can select a named `pi-permission-system` permission profile (global-only `profiles` registry) with `permission-profile: <name>` — a validated scalar selector, never an inline policy. The field is serialized, round-tripped through eject/settings overrides, and propagated through foreground/background/async/workflow launches, recovery descriptors, and status projections alongside the sandbox profile.
- **Transient profile channel.** When the field is set, the child receives the bare validated name via the transient `PI_SUBAGENT_PERMISSION_PROFILE` env var and `pi-subagents` injects the installed `pi-permission-system` extension into the child launch even under an explicit `extensions` allowlist, so the child's permission system applies the selected profile. Launch fails closed when the package is missing, a capability ceiling denies child extensions, or the runner is not a native Pi child (`external-cli`/`external-job` reject the field).

## [0.11.0] - 2026-09-11

### Added

- **Silent span marker for user-initiated dialogs (pi-notify protocol).**
  The fleet inspector and the `/subagents admin` management dialogs emit the
  literal `pi-notify:ui_span_silent` bus event (payload `{ reason: "fleet" |
  "admin" }`) synchronously before opening their `ctx.ui.*` dialog, so the
  pi-notify generic UI-prompt adapter produces no notification and no Herdr
  wait entry for them. Emission is observational (bare try/catch) and uses the
  literal event name with no dependency on the `@xzzpig/pi-notify` package, so
  installs without pi-notify are unaffected. Both fleet open paths are wired
  — the `/subagents-fleet` command and the fleet status widget — via the new
  optional `FleetViewOptions.events` field; the subagent-executor agent-waiting
  confirmations (worktree cleanup, authority confirmation) deliberately do not
  emit the marker.

## [0.10.0] - 2026-09-10 (fork release)

### Added

- **`sandbox: <profile-name>` for native agents.** Agent frontmatter (or a
  builtin override) may select one named `pi-sandbox` profile from the user's
  global `<agentDir>/sandbox.json`. The selector is a scalar name only: objects,
  empty values, path-like names, and the literal `false` are rejected, and the
  field is refused for `external-cli` and `external-job` runners. The launcher
  resolves and injects the installed `pi-sandbox` extension plus a startup guard
  even when `extensions` is an explicit allowlist; a missing package, unreadable
  manifest, capability-ceiling denial, unknown profile, or failed sandbox
  initialization fails the launch before the child's first model turn.
- **Startup acknowledgement is verified before the first turn.** The guard
  blocks the child when the profile never acknowledged successful startup, and
  only the validated profile identity is persisted in async status, nested-event,
  and intercom projections. The project trust decision travels with the child as
  a boolean; a project-scoped selector is rejected unless the project is trusted
  and the child cwd matches the trusted project root exactly.
- **A blocked child reports its real reason.** A startup block publishes its
  failure through the child startup diagnostics channel (including the available
  profile names), so callers see the profile error instead of "Subagent produced
  no output (possible model cold-start or empty response)", and the failure is
  classified as `startupBlocked` rather than a retryable model failure — it no
  longer records a 24-hour model exclusion or triggers pointless model fallback.

### Changed

- **Sandbox configuration is never injected into the child.** Only the selected
  profile name, the trust snapshot, the startup acknowledgement channel, and the
  diagnostics path cross the launch boundary, and those keys are restored on the
  host immediately after the child session is created. Launches without a
  `sandbox` selector keep the previous behavior unchanged.

## [0.9.0] - 2026-09-05 (fork release)

### Changed

- **Synced upstream v0.56.0 → v0.65.0.** Highlights: subagents now run as
  native Pi `AgentSession`s instead of spawned `pi` CLI processes (#1844),
  managed worktrees gain validated `baseRef` and per-project nesting,
  compact workflow lane summaries, fail-closed model selection, agent scan
  dirs (`subagents.agentScanDirs`), a file-watched agent discovery cache,
  and the `pi-subagents/pi-args` subpath rename to `pi-subagents/child-tool-plan`.
  Upstream's own tests now cover `resolvePermissionSystemExtension()`
  (child-tool-plan-permission-system.test.ts); the fork's `@xzzpig`
  candidate-priority test merged into that suite.
- Dropped the fork's Pi SDK `streamFn` option-naming divergence: upstream
  ships `agentStreamOptions()` (dual `streamFn`/`streamFunction`) at every
  call site, which is strictly more compatible than the fork's single-name form.
- Raised dev-dependency SDK baseline stays at 0.84.2 while adopting
  upstream's oxlint tooling.

### Preserved fork features across the merge

- `@xzzpig/pi-permission-system` priority in `resolvePermissionSystemExtension()`
  (re-applied to the new `src/runs/shared/child-tool-plan.ts`).
- Context injection: `injectToContext` frontmatter, `subagents.injectAgents`
  setting, session snapshot + `before_agent_start` injection, and
  `/subagents-doctor` reporting, re-woven into upstream's
  `discoverAgentSnapshot` discovery architecture.
- Fleet native transcript rendering (`v` key renderer toggle, native module
  loader, mode-aware transcript cache) plus mouse-wheel scrolling, extended
  to upstream's new `trustedFiles`/`trustedFileRoot` transcript read options.
- Foreground tool-result normalization with bounded `toolCallId` de-duplication
  for mixed Pi host event shapes, ported to upstream's `processEvent`
  child-session event architecture (shared `handleToolResult` path).
- The shared agent-eject API (`src/api/agent-management.ts`,
  `ejectAgentDefinition`) used by pi-goal-x, adapted to upstream's renamed
  imports (`resolveEffectiveThinking`, `child-tool-plan`).
- Fork package naming (`@xzzpig/pi-subagents`), env-isolated test scripts,
  `prepack` bundle build, and `@xzzpig/pi-components` bundledDependencies.

### Upstream provenance

- Upstream v0.56.0: [source a0e2b9e31de5](https://github.com/nicobailon/pi-subagents/tree/a0e2b9e31de5970215a567e20e2d781bbbddf235); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/b2de5e5a8f4c9de10d2e04e21982d2e9841484ad/subtrees/pi-subagents.json).
- Upstream v0.65.0: [source 9300403c7408](https://github.com/nicobailon/pi-subagents/tree/9300403c7408800a9436ba8ca1b854f8ca96a991); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/c06f620f42aaec6b7f1685823232b84637b8d50f/subtrees/pi-subagents.json).

## [0.8.0] - 2026-08-24 (fork release)

### Changed

- **Synced upstream v0.53.0 → v0.56.0.** Highlights: opt-in `fast` mode for
  allowlisted OpenAI-Codex subagents, bounded extension launch bindings,
  max thinking ceiling, default provider setting, external job follow-ups,
  safer completion-guard evidence, and workflow output/artifact routing —
  merged on top of the fork's permission-system priority, SDK streamFn
  naming, and fleet-native-transcript adaptations.

### Added

- **Fleet inspector native transcript rendering.** `/subagents-fleet` now
  renders structured session transcripts through `@xzzpig/pi-components`
  native components (tool calls via `ToolExecutionComponent`, messages via the
  native message components). A new adapter (`src/tui/fleet-native-transcript.ts`)
  converts persisted child-transcript JSONL records into library entries,
  fills the tool-component registry per cache generation, synthesizes results
  for calls without a result record, and degrades truncated (>32KB) argument
  payloads to renderable entries with a truncation preview + result notice.
- **`v` key toggles the renderer.** Switches the inspector between the native
  transcript and the legacy rail renderer (rebindable via
  `FLEET_KEYBINDING_ACTIONS`; session-scoped state; inactive in Prompt Audit
  mode). When the native module is missing or fails to load, the legacy
  renderer is used automatically.

### Changed

- `@xzzpig/pi-components@0.3.0` is bundled via `bundledDependencies` (private,
  never published to npm); `prepack` rebuilds it so the bundle always carries
  fresh `dist`.
- Tool-call theming follows the host's global theme: the shared library never
  re-initializes an already-active theme (fixes dark-theme tool backgrounds in
  the main session after opening the inspector).

### Fixed

- Truncated or corrupt `argsPayload` records no longer produce empty tool
  entries; they degrade with the recorded preview and outcome visible.

### Upstream provenance

- Upstream v0.53.0: [source c91f4de5ea95](https://github.com/nicobailon/pi-subagents/tree/c91f4de5ea956f0d1fcab9e44eba079fa2f917dd); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/89ba2222123e6cdf051ddd51684314953975f2fe/subtrees/pi-subagents.json).
- Upstream v0.56.0: [source a0e2b9e31de5](https://github.com/nicobailon/pi-subagents/tree/a0e2b9e31de5970215a567e20e2d781bbbddf235); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/b2de5e5a8f4c9de10d2e04e21982d2e9841484ad/subtrees/pi-subagents.json).

## [0.7.0] - 2026-08-24

## [0.6.0] - 2026-08-23

### Added
- Context injection: agents that opt in with `injectToContext: true` frontmatter, plus names listed under the new `subagents.injectAgents` setting, are pre-declared to the parent agent in a compact `<available_subagents>` system-prompt block. The union resolves once per session (canonical names or aliases; builtins allowed), stays byte-identical across turns to preserve provider prompt caching, skips disabled and capability-ceiling-restricted agents and spawned child sessions, ignores unknown setting names (reported by `/subagents-doctor`), and never duplicates itself on forked or resumed sessions.

## [0.5.0] - 2026-08-22

### Changed
- Synced the fork with upstream pi-subagents v0.53.0 (runtime agent registration API, keyed workflow receipts, TTL-based model-fallback exclusion, RPC schedule management, council mode; legacy chain workflow internals removed upstream in #1166).

### Fixed
- Preserved local compatibility fixes across the merge: `@xzzpig/pi-permission-system` priority in `resolvePermissionSystemExtension()`, foreground tool-result normalization for mixed Pi host event shapes, and the shared `ejectAgentDefinition` helper (adapted to upstream's `availableAgentNames` rename).

### Upstream provenance

- Upstream v0.53.0: [source c91f4de5ea95](https://github.com/nicobailon/pi-subagents/tree/c91f4de5ea956f0d1fcab9e44eba079fa2f917dd); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/89ba2222123e6cdf051ddd51684314953975f2fe/subtrees/pi-subagents.json).

## [0.4.2] - 2026-08-20

### Fixed

- Normalize native `message_end` tool-result events into the foreground progress snapshot, alongside `tool_result_end`, with `toolCallId` de-duplication. This keeps bounded tool-result records available to structured delegation consumers across Pi host event shapes.
- Verify an ejected agent's copied skills and launch tool plan before reporting success; failed verification removes only the file created by that eject attempt.

## [0.4.0] - 2026-08-16

### Changed
- Synced the fork with upstream pi-subagents v0.50.0 while preserving local compatibility fixes (@xzzpig/pi-permission-system priority in resolvePermissionSystemExtension(), Pi SDK 0.83 streamFn option naming).

### Upstream provenance

- Upstream v0.50.0: [source c091da1d9b66](https://github.com/nicobailon/pi-subagents/tree/c091da1d9b660c1940ef5dc78cfeeace1aecd435); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/9b9d7d621a821612db7e230f5d6f4980e6d28b69/subtrees/pi-subagents.json).

## [0.3.0] - 2026-08-14

### Changed
- Synced the fork with upstream pi-subagents v0.49.0 while preserving local compatibility fixes.

### Upstream provenance

- Upstream v0.49.0: [source 9752fdfd5de0](https://github.com/nicobailon/pi-subagents/tree/9752fdfd5de0d63cb0ac1036b76988691694e866); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/50019ff639b2f3119b73be6fd614a5f37b40c084/subtrees/pi-subagents.json).
