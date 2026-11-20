# Fork Changelog

Release history for `@xzzpig/pi-goal-x`; version headings refer only to this fork.
Upstream history: [CHANGELOG.md](./CHANGELOG.md).
Current upstream baseline (not a claim about older releases): [v0.34.1 / 27d9facf49e6](https://github.com/tmonk/pi-goal-x/tree/27d9facf49e66ee677770a74e26198a8bdcada8a).

Historical entries below were migrated from the repository's existing changelogs; missing dates and historical baselines have not been invented.

### Historical note with an upstream-version heading

The previous mixed log placed the following fork baseline-capture notes under upstream 0.31.2. A corresponding fork release is not established here; preserve the text without treating that upstream version as a fork release.

#### [0.31.2] — 2026-09-08

##### Changed

- Baseline capture is one-shot per goal and hangs off the existing `turn_start`
  handler behind a single guard (a focused goal whose `status` is `active`): the
  first execution turn opens the window and later turns never re-capture, with
  the in-memory flag backed by create-if-absent (`wx`) sidecar semantics so a
  second process cannot overwrite an existing baseline. There is no tool-name
  classification, no `tool_call` trigger, and no `task_started` fallback.
- Terminal transitions remove the baseline sidecar (completion, archival,
  clear). A rejected or failed audit keeps it so a retry measures the same
  window, and a paused goal keeps it because it can resume inside that window.
  `/goal-recovery` now also reports orphaned baselines (whose goal record is
  gone) and removes them with the usual confirmation and backup.
- Every extension-side git call is a fixed subcommand with array arguments at a
  2000 ms per-repository timeout and a 5000 ms scope-resolution budget, reading
  with `GIT_OPTIONAL_LOCKS=0` so no index lock is taken, and capture, delta, and
  rollback failures degrade silently: they never block goal creation,
  completion, or clearing.

##### Unchanged (explicitly verified)

- Outside a repository, with `changeManifest: "off"`, or when no baseline
  exists, the audit prompt is byte-for-byte what it was before this release and
  no git object is created.
- The auditor's tool whitelist, its `structured_output` verdict contract, the
  completion transaction, and the dashboard phase semantics are unchanged.

## [Unreleased]

### Fork changes

- 目标执行中，模型可通过 `propose_goal_draft` 的 `tweak: { goal_id, reason }` 直接提出目标调整，无需用户先运行 `/goal-tweak`。既有确认、自动确认策略和焦点/候选校验保持适用。
- 调整原因在差异与全文审核视图、基础确认及当次工具结果中单独展示，不写入目标正文或语义差异；继续讨论和取消沿用目标调整语义。
- 待办与审计进度面板的展开/收起按钮统一到可点击的底边框；待办有当前任务时可从同处恢复跟随，审计清单仍可在正文内滚动。
- 窄屏优先保留完整主按钮。底边框仅提示当前可用的快捷键，审计停止键单独展示；缩放、浮层或全屏布局重排使旧位置失效时，旧点击不会触发切换。

## [0.12.5] - 2026-11-19

### Fork changes

- 创建及调整最终确认支持正文滚动、固定决策区与安全鼠标操作；宽屏调整差异使用独立随包交付的共享并排排版，保留键盘和既有事务。

- 审计面板支持原生鼠标展开、收起与清单滚轮浏览；保留键盘、选字、浮层和挂起继续行为，不改变审计事务。

- 目标任务树自动跟随当前任务，展开当前分支并保留手动浏览；支持全屏模式鼠标滚轮、点击父任务展开/收起及返回当前任务。鼠标交互不改变任务进度，键盘导航仍然可用。

## [0.12.4] — 2026-11-17 (fork release)

- 完成审计 dashboard 改为显示本次实际生效的审计清单（默认或替换的 `auditor.checklist`，再追加 `checklistExtra`），由审计员按项目 ID 上报状态与依据；不再按百分比推算检查项，也不在终态自动补勾。
- 紧凑视图显示检查覆盖度和当前项，展开视图可滚动浏览完整清单、依据及工具诊断；保留旧进度估计兼容和同一审计挂起/继续。逐项状态只作展示，不增加完成门槛，最终仍由原结构化 verdict 决定。

## [0.12.3] — 2026-11-17 (fork release)

- 新增项目本地配置层 `.pi/pi-goal-x-settings.local.json`：按字段覆盖项目共享与个人全局配置；`/goal-settings` 与 Controls 支持三个编辑范围并展示来源，默认仍编辑项目共享层。

## [0.12.2] — 2026-11-15 (fork release)

- **Conflict-surface refactor, no behavior change.** The fork-only completion orchestration (audit lifecycle, `runGoalCompletionAuditor` delegation, supervisor handoff projection, result assembly) moved to `extensions/fork-completion-flow.ts` (513 lines); `extensions/goal-completion.ts` keeps the authoritative `commitGoalCompletion` transaction — the single write path every completion branch uses — and otherwise only re-exports `runGoalCompletionFlow`. Auditor usage projection lives in `extensions/fork-audit-usage.ts`, and the fork-only model-view prompt blocks (paused/budget gates, budget reminder, per-turn state snapshot) in `extensions/prompts/fork-model-view-prompts.ts`; `extensions/prompts/goal-prompts.ts` re-exports them (487 → 364 lines, upstream 321). Rendered reports, audit cards and snapshots are unchanged.
- **Conflict-surface refactor, no behavior change.** The nested `auditor` settings group is now defined once, in fork-only `extensions/goal-auditor-settings.ts`: its leaf table drives parsing, resolution, persistence and the `/goal-status` provenance rows instead of six parallel enumerations in `extensions/goal-settings.ts` (2046 → 1768 lines). Parsing diagnostics, defaulted leaves and persistence rules are unchanged; `goal-settings` and race tests stay green.

## [0.12.1] — 2026-11-05 (fork release)

- Import `Type` directly from the existing host-provided `typebox` peer for Pi 1.5 npm SDK compatibility; keep TypeBox schemas and the Pi 1.4 minimum unchanged.

## [0.12.0] — 2026-11-01 (fork release)

### Changed

- 未聚焦会话不再向模型提供任何其他目标引导：请求上下文不再生成 `[PI GOAL UNFOCUSED]` 提醒，载入/恢复/取消聚焦也不再追加隐藏的 `pi-goal-steering-event` 消息。旧键 `hideUnfocusedPrompt` 仍可解析、分层和保存，但不再影响行为，也不再出现在设置菜单与设置摘要中；`hideUnfocusedBanner` 继续独立控制未聚焦 UI。焦点仍为人工所有，需要焦点的工具校验、过期 checkpoint 拦截、聚焦目标的上下文/恢复/审计均不变；已持久化的旧消息原样重放，不做清洗或重写。

## [0.11.1]

### Fixed

- 协同 pi-subagents 延后有原生唤醒契约的后台工作期间的目标自动续跑，避免子代理结果或监督请求到达前重复发起 checkpoint、消耗自主运行额度。无监听者时保留原有续跑行为，用户输入及原生唤醒不受拦截。

## [0.11.0]

### Changed

- 同步上游 `v0.32.3` → `v0.34.1`，最低运行环境调整为 Pi 1.4；引入原生完整上下文边界、可配置命令与按键、可选的上下文占用显示以及会话归属和审计生命周期保护。
- 保留 fork 的独立子代理审计、只读监督旁路、常量工具面、主模型遥测精简和 Escape 后恢复同一审计。上游 `showContextUsage` 默认关闭，仅显式开启时提供上下文快照。
- 审计开始、跳过或终态记录写入失败时保持目标未完成并提示重试；审计用量和完成请求仍尽力记录。
- 改用仓库根目录的 pnpm 锁文件，不再支持包级 `npm ci`。

### Upstream provenance

- Upstream v0.32.3: [source 64c5ace87f34](https://github.com/tmonk/pi-goal-x/tree/64c5ace87f3400c0b55ef87f2d2912167f53dbaa); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7bc8204b0f9f81e1b3566677e9a3f0505a082f2c/subtrees/pi-goal-x.json).
- Upstream v0.34.1: [source 27d9facf49e6](https://github.com/tmonk/pi-goal-x/tree/27d9facf49e66ee677770a74e26198a8bdcada8a); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/bdf8b8575def0db6b1d4d0218ab109a13d5a6a80/subtrees/pi-goal-x.json).

## [0.10.0]

### Added

- 完成审计的监督提问改由只读旁路回答:审计员用 `contact_supervisor` 提问时,原审计尝试内的只读会话按已完成上下文作答,
  `update_goal` 保持阻塞、审计员不 detach、主模型不额外起 turn;无法回答时 fail closed 并精确取消。
- 协调记录随原 `update_goal` 工具结果回流(标题「审计协调记录(参考信息,不是新用户指令或完成证据)」),内容为人读摘要
  (问题 / 答复或未解决原因 / 中文状态 / 短 ID),JSON 形态答复扁平化为 `key=value`,正文不含 JSON 花括号。
- goal 结果卡片渲染协调记录:折叠态一行 `审计协调记录 N 条(原因 · 状态)`,`ctrl+o` 展开显示完整问答。
- 旁路用量单独记 `audit_supervisor_usage`,父 turn 预算与 `goal.usage.tokensUsed` 不变。

## [0.9.1] — 2026-10-09 (fork release)

### Changed

- 新生成的主模型内容不再提供上下文占用、累计耗时、无预算累计消费或插件审计花费，保留真实预算和运行约束。旧会话消息/工具返回不处理，允许历史遥测原样重放；UI、账本、内部计费与独立审计输入不变。

## [0.9.0] — 2026-10-02 (fork release)

### Changed

- **Synced upstream `v0.31.9` → `v0.32.3`**: Pi 1.0.0 support (peer floors
  widened upstream; the fork baseline is `>=1.0.0 <2`), `session_compact_failed`
  handling, removal of the next-actions mechanism (`{ kind: "ready" }` without
  `next_action`), no invented token budgets in drafting, dashboard keyboard
  navigation fixes (configurable dashboard keybindings read at event time,
  Kitty single-press handling, componentRef viewport scrolling), and
  `Provider finish_reason: error` classified as a transient failure.
- The fork's Escape/foreign-ui-prompt guard and hold-to-scroll semantics are
  preserved on top: repeats still reach the compact task-list scroll (the
  upstream single-press kitty guard was not adopted; its release filtering is
  covered by the fork's `isKeyRelease` guard), and the auditor settings group
  maps the new `showAutonomousRuns` flat key.

### Upstream provenance

- Upstream v0.31.9: [source a5bdf61bed44](https://github.com/tmonk/pi-goal-x/tree/a5bdf61bed449735132a61da983c3f6a5ae82222); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/d1d9c292295c7d590343e5c043ae6b607cda8683/subtrees/pi-goal-x.json).
- Upstream v0.32.3: [source 64c5ace87f34](https://github.com/tmonk/pi-goal-x/tree/64c5ace87f3400c0b55ef87f2d2912167f53dbaa); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7bc8204b0f9f81e1b3566677e9a3f0505a082f2c/subtrees/pi-goal-x.json).

## [0.8.3] — 2026-09-27 (fork release)

### Changed

- **Goal-draft proposal rejections are now visible in the transcript.** The
  collapsed `propose_goal_draft` result heading was the generic
  "Goal No goal is set." one-liner for every non-confirm outcome, so the
  decision — and the adjustment reason the user typed in the dialog — stayed
  invisible until the result was expanded. The result now carries a
  structured `draftOutcome` detail, and the renderer shows
  `Goal draft rejected — reason:` with the verbatim typed text (bounded in
  the collapsed view, full text when expanded), `Goal draft rejected — no
  reason given` for a plain continue, and `Goal draft cancelled — no goal
  was created` for a discard.

## [0.8.2] — 2026-09-26 (fork release)

### Fixed

- **Dashboard shortcuts no longer re-fire when a keystroke's key-release
  arrives late.** pi runs with the kitty keyboard protocol's press/release
  reporting, so every keystroke arrives as two escape sequences that
  `matchesKey` matches identically; pi-tui drops releases only on the
  focused-component path, while the dashboard's raw `onTerminalInput`
  listener received both. When the terminal or a session layer delivers the
  release long after the press (Warp window refocus, multiplexer
  detach/attach), Esc re-aborted/re-paused and Ctrl+Shift+A/T re-toggled
  their state on refocus. The listener now drops release events outright
  (mirroring pi-tui's `tui.js` focused-component filter and the
  `tui-alt-screen` viewport-listener guards) and skips repeat events on the
  state-changing branches while held-key navigation chords keep scrolling.
- **Followed upstream pi-subagents v0.71.0 `completionGuard` removal**: the
  runtime-registered default goal-auditor definition and its package test no
  longer set the dropped `RuntimeAgentDefinition` field.

### Changed

- **Synced upstream v0.31.6 → v0.31.9.** Adopted the `goalPromptParts`
  `{state, counters}` split (the fork's live-context channel already consumed
  that shape), `contextUsageLine`, the `goalsRoot` setting (with
  `PI_GOAL_ROOT` shared storage; upstream's key allowlist set was not adopted
  — the fork's settings switch already emits `unknown_key` diagnostics),
  `hideUnfocusedPrompt`, the post-budget reminder wiring in the
  `/goal-tweak` flow, previous-audit rejection warm-context (gated behind
  `auditor.warmContext`), orphaned-baseline reporting, and the
  `modelBudgetLine` rename. Deliberately not adopted: upstream's auditor
  checklist rewording and `<approved/>` verdict protocol (the fork keeps its
  base checklist / `auditor.checklist` override and the structured_output
  protocol per the 0.8.0 design) and the upstream `runGoalQuestionnaire`
  flow (the fork questionnaire UI is retained).

### Upstream provenance

- Upstream v0.31.6: [source 50f677edc103](https://github.com/tmonk/pi-goal-x/tree/50f677edc1038acd02c0c1652ad0d0d9694e0553); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/e3e5f3753dc8e6187e9df7930706793df3514e26/subtrees/pi-goal-x.json).
- Upstream v0.31.9: [source a5bdf61bed44](https://github.com/tmonk/pi-goal-x/tree/a5bdf61bed449735132a61da983c3f6a5ae82222); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/d1d9c292295c7d590343e5c043ae6b607cda8683/subtrees/pi-goal-x.json).

## [0.8.1] — 2026-09-20 (fork release)

### Changed

- **Esc during a completion audit parks the audit and “continue” reuses the
  SAME auditor subagent** instead of killing it and later starting a fresh one.
  Esc no longer sends the delegation cancel immediately: the child keeps
  running and its event listeners stay attached while the Escape dialog asks
  whether to finish the audit or complete without it. Choosing **Continue
  audit** resumes the same attempt to its verdict (approved → completes;
  disapproved → rejection card); choosing **Mark complete without audit**
  cancels the child at that point and records `audit_skipped`. If focus moves
  on while the dialog is open (e.g. `/goal-unfocus`), the parked child is
  cancelled so no orphan keeps running. The terminal-timeout cap still bounds
  a parked audit, and an already-finished parked child is never double-
  cancelled. Usage accounting (`audit_usage` ledger + tool-result usage) is
  preserved on every Escape path: continue, bypass, and focus-lost. The
  non-parkable dependency-stub path (old “continue working” behavior) is
  kept as a fallback.

### Fixed

- **Completion audits no longer fail with `Unknown agent: goal-auditor` when
  the default auditor is runtime-registered.** 0.8.0 resolved the registered
  agent through a runtime-registry query issued from Goal-X's own
  ExtensionAPI, but pi-subagents keys that registry (a WeakMap) by the
  *owning* extension's API identity: the registering listener stores the entry
  under its own object, so a query from another extension can never observe
  its own registration. With the packaged `goal-auditor.md` intentionally
  removed, every default-config audit died at the launch preflight, so
  `update_goal(complete)` could not be independently reviewed at all.
  The preflight now trusts Goal-X's own record of the registration it handed
  to the pi-subagents owner — name plus the merged definition — instead of
  querying a registry keyed by another object. Delegation itself was never
  broken: pi-subagents resolves the agent under the key it registered, so the
  same attempt still launches.
- **The audit preflight fails closed with actionable diagnostics.** Only a
  live registration whose name matches the selected `auditor.agent` (and whose
  effective allowlist retains `report_auditor_progress`) is accepted. A
  missing registration, a differently named `auditor.agent`, and a stripped
  protocol tool each fail closed with a message naming the cause and the
  remedy; a configured `goal-auditor` (e.g. a pre-0.8.0 ejected file) shadows
  the runtime registration and keeps auditing through ordinary discovery.

## [0.8.0] — 2026-09-19 (fork release)

### Changed

- **Completion audits are customized through the nested `auditor` settings
  group instead of agent markdown overrides.** New prompt-injection fields
  (read per audit, effective immediately): `auditor.instructions`,
  `auditor.checklist` (replaces the built-in checklist),
  `auditor.checklistExtra`, `auditor.evidenceRequests`,
  `auditor.strictness` (`balanced`/`strict`/`lenient` posture preset),
  `auditor.reportFormat`, and `auditor.feedbackNotes` (fixed note appended to
  rejection feedback). New request-tier fields: `auditor.warmContext` toggle
  plus migrated `auditor.agent`/`provider`/`model`/`thinkingLevel`/`timeoutMs`/
  `disabled`/`changeManifest`/`changeManifestDepth`. All operator payloads are
  escaped, the injection order is fixed, and with everything unset the audit
  prompt stays byte-for-byte identical.

- **The default `goal-auditor` agent is registered at runtime** with the
  installed pi-subagents owner via the `pi-subagents:runtime-agent-register:v1`
  contract (`extensions/goal-auditor-registration.ts`), replacing the package
  `agents/goal-auditor.md`. The definition tier of the settings group
  (`systemPromptExtra`, `extensions`, `subagentOnlyExtensions`, `skills`,
  `skillPath`, `tools`, `excludeTools`, `mcpDirectTools`, `defaultReads`,
  `inheritProjectContext`, `inheritSkills`, and the fork's `sandbox` /
  `permissionProfile` profile selectors) merges into the registered
  definition at session start (new session or /reload to apply). The
  child-only progress provider, the protocol tools, and the verdict contract
  stay code-owned: configuration can no longer break the five-stage step
  feedback or the preflight fail-closed guards. Registration is skipped when a
  configured `goal-auditor` agent already exists, so pre-0.8.0 ejected
  markdown files keep working.

- **The audit preflight resolves runtime-registered agents.** The
  `resolveSubagentLaunchContract` fail-fast check uses file-only discovery,
  which cannot see the session-start runtime registration; the audit now falls
  back to the runtime-aware merged view (`discoverAgentsWithRuntime`) when the
  file view reports `missing_agent` and the ExtensionAPI is available, so bare
  `pi -e` audits start normally instead of failing with `Unknown agent:
  goal-auditor`. The fallback still fails closed when the runtime view also
  lacks the agent or the effective allowlist loses `report_auditor_progress`.

### Removed

- **`/goal-subagent-eject`** — runtime registration plus the `auditor`
  settings group replace whole-file ejection. Previously ejected
  `goal-auditor.md` files keep working (registration is skipped for them);
  delete the file to return to the code-owned default, or point
  `auditor.agent` at a custom definition.
- The package `agents/goal-auditor.md` and the standalone
  `PI_SUBAGENT_EXTRA_AGENT_DIRS` materialization used by bare `pi -e` runs
  (runtime registration covers that mode).

### Migration

- Flat settings keys `auditorAgent`, `auditorTimeoutMs`, `provider`, `model`,
  `thinkingLevel`, `disabled`, `changeManifest`, and `changeManifestDepth`
  parse as deprecated aliases of their `auditor.*` leaves; the nested spelling
  wins within the same file. `/goal-settings` and `saveGoalSettingsFileConfig`
  write the nested form.

## [0.7.5] — 2026-09-19 (fork release)

### Changed

- **Conflict-surface refactor, no behavior change.** The pi-subagents delegation executor moved to fork-only `extensions/goal-auditor-delegation.ts` (`extensions/goal-auditor.ts` keeps prompt building and re-exports, cutting its diff from ~672+/248− to ~57+/280−); `extensions/goal-policy.ts` and `tests/goal-layered-settings.test.ts` are byte-identical to upstream again; the post-compact reminder tests dropped during the v0.31.5 API gap were restored; `package-lock.json` was restored to upstream bytes (unconsumed by this pnpm monorepo).

## [0.7.4] — 2026-09-18 (fork release)

### Changed

- **Synced upstream v0.31.5 → v0.31.6** (upstream patch release → fork patch
  bump). Adopted upstream's prompt-cache fix (#67/#68): the context hook now
  appends live goal state (`pi-goal-live-context`) at the request tail instead
  of prepending it, `compactGoalCheckpointContext` rewrites every checkpoint
  marker in place (no more mid-history deletion that shifted the cache
  prefix), `before_agent_start` no longer injects changing state into the
  system prompt, and `cacheGoalHistory` moves existing Anthropic/Bedrock
  cache breakpoints before the transient tail. Fork additions are preserved:
  the persisted `pi-goal-context-event` channel (re-sent on session_compact),
  `pi-goal-state-event` snapshots, the ui_prompt_start/end Escape-to-dialog
  depth (reset on session_start), the change-manifest baseline capture, and
  the constant tool-surface install. `goal-context-filter.test.ts` was
  rewritten for `compactGoalCheckpointContext` semantics (in-place rewrite,
  not drop).

### Upstream provenance

- Upstream v0.31.5: [source 5a7c4cd5b3d3](https://github.com/tmonk/pi-goal-x/tree/5a7c4cd5b3d3bfb07a33f1babdaed8eedc4b9987); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7afaaf8848e4e1aa7f61d98beb8ff3b9320d9013/subtrees/pi-goal-x.json).
- Upstream v0.31.6: [source 50f677edc103](https://github.com/tmonk/pi-goal-x/tree/50f677edc1038acd02c0c1652ad0d0d9694e0553); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/e3e5f3753dc8e6187e9df7930706793df3514e26/subtrees/pi-goal-x.json).

## [0.7.2] — 2026-09-16 (fork release)

### Changed

- **Synced upstream v0.31.2 → v0.31.4** (upstream patch releases → fork patch
  bump). Upstream v0.31.3/v0.31.4 introduce the autonomous-run scheduler: a
  durable scheduling state on the goal (`goal.scheduler`) with `ready`/`wait`
  continuation declarations, wake tokens, polling checks, and a per-run
  allowance capped by the new `maxAutonomousRuns` setting. `update_goal`
  accepts an optional `continuation` (ready or wait) alongside its status
  choices; checkpoint dispatch is now authorized by the scheduler's claim.
  The fork keeps its own per-turn state snapshots (`pi-goal-state-event`) and
  change-manifest baseline on top of the new scheduling system.

### Upstream provenance

- Upstream v0.31.2: [source 30e1da004ab7](https://github.com/tmonk/pi-goal-x/tree/30e1da004ab716479fd27da8bf35c099e4b6b59e); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/ee4a1017cdb67fbf07cd17f63dd704fd1d36b0a7/subtrees/pi-goal-x.json).
- Upstream v0.31.4: [source 323fd4c3b079](https://github.com/tmonk/pi-goal-x/tree/323fd4c3b07902e5b354f7d8b7fa0b7ae5bf072f); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/ae38ad47c4883b78aab7df7a681ea2498b4d0e99/subtrees/pi-goal-x.json).
- Upstream v0.31.3: [upstream release history at recorded source](https://github.com/tmonk/pi-goal-x/blob/27d9facf49e66ee677770a74e26198a8bdcada8a/CHANGELOG.md). This links release-history evidence, not a separately verified historical checkout.

## [0.7.1] — 2026-09-13 (fork release)

### Fixed

- **The independent completion audit's child-session spend is no longer
  discarded.** `goal-auditor` now reads the `usage` of the delegation terminal
  response — the pi-subagents child session's tokens, turns, and cost — on every
  terminal path: approved, disapproved, provider error, terminal timeout, and
  user cancellation. The payload is validated before it can enter accounting;
  absent or malformed usage is ignored instead of being charged as `NaN` or a
  negative counter.
- **Tracing that spend into the session's own cost totals.**
  `update_goal({ status: "complete" })` now returns the audit usage on its tool
  result in pi's tool-result `Usage` shape (`totalTokens` plus an object `cost`
  with a `total`). The shape matters: pi-subagents reports `cost` as a plain
  number, and pi only accounts tool results that carry the object form, so the
  raw delegation usage cannot be attached as-is. With this, the host counts the
  audit spend in the session — footer `$`, `/session` Cost (grouped under
  `Tools/summaries`, because a tool result carries no model attribution) and the
  cumulative token counters. Every completion branch carries it: approved,
  rejected, audit aborted → continue working, Escape bypass, and **both**
  focused-operation cancels (one right after the audit settles, one after the
  Escape dialog). When the delegation reports no usage the returned result keeps
  its previous shape and no `usage` field appears.
- **A separate durable account for the audit spend.** A new `audit_usage`
  ledger event records tokens (with input/output/cache-read/cache-write splits),
  cost, and turns for each audit. `goal.usage.tokensUsed` is deliberately left
  untouched so the goal's token budget keeps its parent-turn-only meaning; the
  same numbers are shown on the audit card, in the goal activity feed, and in
  the compaction summary.

### Notes

- The audit verdict contract, the completion transaction, the auditor's tool
  whitelist, and every user-facing completion message are unchanged. Cost
  reporting never influences a verdict or a completion decision.
- `/subagent-cost` still does not list the delegated auditor. That command only
  recognizes `subagent`/`bg_wait` tool results and workflow receipts, and the
  audit is an extension-to-extension delegation rather than a tool call; use the
  audit card, the goal activity feed, or the session's own cost totals instead.
- The blocker Oracle's nested session remains outside this accounting and is not
  covered by this release.

## [0.7.0] — 2026-09-13 (fork release)

### Added

- **The completion audit receives a git change manifest.** When the working
  directory is inside a repository, the first execution turn after a goal is
  confirmed captures a baseline — `HEAD`, a `git stash create` snapshot of the
  tracked content, and a `status --porcelain --untracked-files=all` fingerprint —
  in `.pi/goals/<id>.baseline.json`. The completion audit is then given the
  resulting window as machine-collected evidence: one section per repository
  (the primary repository, ancestors found by an upward walk, recursive
  submodules, and nested repositories found by a bounded depth scan, innermost
  owner winning) with per-path add/delete counts and directly executable
  `git -C <root> diff <base>` commands, so the read-only auditor pulls the diffs
  it wants instead of the prompt carrying them. The block is labelled as *not*
  the executor's claim, `executor_claim` stays marked UNTRUSTED, and the
  checklist tells the auditor that manifest entries never substitute for
  verification. No diff body is ever inlined (`diff --git`, `@@`, `+`/`-`
  lines), the rendering is capped at 6000 characters, and pi-goal-x's own state
  (`.pi/goals/`, `.pi/subagents/`, the goal event ledger, the pool snapshot) is
  excluded from the window.
- **`/goal-clear` offers to roll the workspace back.** After the clear
  confirmation, a second prompt reports how many files the goal window changed
  and offers to restore them; **No** is the default, so a stray Enter still only
  clears the goal. Rolling back restores modified and deleted tracked files to
  their baseline content (`git restore --source=<base> --worktree`, never the
  index) and deletes the files created inside the window. No repository HEAD is
  ever reset, so commits inside submodules or nested repositories are reported
  as unrolled back instead of being discarded. The current changes are copied
  into `.pi/goals/archived/rollback_<timestamp>_<goalId>/` first — one binary
  patch per repository plus copies of every file scheduled for deletion — and
  the discard fails closed (abandoned with a reason, workspace untouched) when
  that backup cannot be written completely; the rollback is also never offered
  without a baseline, without in-window changes, or without an interactive UI.
  The user's `git stash` list is never read or written.
- `/goal-settings` gained `changeManifest` (`auto` by default, `off` disables
  collection) and `changeManifestDepth` (nested-repository scan depth below the
  repository root, default `1`, `0` disables the downward scan), both usable in
  the project and global settings files.

## [0.6.1] — 2026-09-12 (fork release)

### Changed

- **The proposal dialog accepts the adjustment in place.** Choosing
  `Continue chatting — keep refining` in the confirmation dialog now opens the
  answer editor instead of deciding immediately, so the user can type what to
  change without rejecting the draft and waiting a turn. The option label and
  every decision semantic are unchanged (`Confirm` creates the goal, `Cancel`
  discards it, continuing keeps drafting active and the goal untouched).
- A non-empty entry reaches the agent verbatim in the `propose_goal_draft`
  tool result; an empty (or dismissed) entry is exactly the previous plain
  continue outcome, so nobody is trapped in the editor. The same behavior is
  available on hosts that can only show `select`/`input` dialogs.
- The confirmation text now carries one hint line that advertises the direct
  input, and the `/goal` + `/sisyphus` drafting protocol tells the agent the
  typed adjustment arrives in the tool result.

## [0.6.0] — 2026-09-12 (fork release)

### Removed

- **The `goal_questionnaire` tool is no longer registered.** Guided drafting no
  longer ships a questionnaire tool: its model-visible definition (name,
  description, prompt snippet, and the `questions` JSON schema — measured at
  772 bytes) sat in the tool block of every request for the whole session, so
  removing it shrinks the prompt prefix permanently. The extension now
  registers six tools instead of seven. Structured clarification during
  drafting is delegated to the optional
  [`@eko24ive/pi-ask`](https://www.npmjs.com/package/@eko24ive/pi-ask) package
  (`ask_user`): install it and the agent asks through it, leave it out and the
  agent asks in plain chat. pi-goal-x does not depend on pi-ask, bundles
  nothing from it, and its `pi.extensions` manifest still points at the goal
  extension only.
- **E5 questionnaire Q&A echo removed.** The confirmed-goal report no longer
  carries a clarification summary: `ActiveGoalDraft.questionnaireEcho` and
  `formatQuestionnaireAnswers` are gone. `buildGoalCreatedReport` keeps its
  optional `detailedSummary` argument for the direct-creation path.
- Removed the already-unused `isHeadlessQuestionSufficientForDraft` helper
  together with the tool-side questionnaire helpers.

### Changed

- `goalDraftingPrompt` now directs drafting clarification to the installed
  `ask_user` tool and falls back to plain conversation when it is absent.
- `goal-questionnaire.ts` keeps only the goal-owned confirm dialog
  (`runGoalQuestionnaire`, `showProposalDialog`, and the `select`/`input`
  fallback for hosts without a custom UI). It is no longer part of the model
  surface; the file name is unchanged.
- `DRAFTING_GOAL_TOOLS` now contains only `propose_goal_draft`;
  `ALL_REGISTERED_GOAL_TOOLS` is six tools (five execution + the proposal
  tool). The surface stays constant for the whole session — no conditional
  registration and no extra `setActiveTools` call.
- README and docs describe the six-tool surface and the pi-ask delegation.

### Unchanged (explicitly verified)

- The confirm dialog is byte-for-byte the same surface: Confirm / Continue
  Chatting / Cancel, the `┌─ TASKS ─┐` plan box, the `a` auditor toggle, the
  `select`/`input` fallback on non-TUI hosts, and `PI_GOAL_AUTO_CONFIRM=1`.

## [0.5.2] — 2026-09-12 (fork release)

### Fixed

- **Escape now belongs to the open dialog.** pi core (>= 0.84.4) reports every
  blocking `ctx.ui.*` call through `ui_prompt_start`/`ui_prompt_end`; the goal
  now tracks that span depth and yields to it, together with goal-owned modals
  and TUI overlays. Before this, pressing Escape to close another extension's
  window (a `select`/`confirm`/`input`/`editor`/`custom` dialog without
  `overlay: true`, which replaces the editor instead of pushing an overlay)
  aborted the completion audit that was running — or paused the active goal and
  aborted the current turn. Escape resumes its goal meaning as soon as the
  dialog closes. Nested dialogs are covered by core's outermost-span only
  contract; a leaked span is cleared at session start/shutdown so Escape can
  never stay trapped.

  Known residual gap: pi core's own editor-replacing selectors (`/model`,
  `/tree`, `/settings`, session picker) emit no `ui_prompt` span and are not TUI
  overlays, so Escape there still reaches the goal. Closing that gap needs a pi
  core change.

### Changed

- **`@earendil-works/pi-coding-agent` floor raised to `>=0.84.4`** (devDependency
  `^0.85.1`): the `ui_prompt_start`/`ui_prompt_end` events and their types do
  not exist before 0.84.4.
- **`@xzzpig/pi-subagents` is now resolved through the pnpm workspace**
  (`workspace:*`, matching `pi-agent-role`) instead of the registry `0.10.0`
  tarball, whose raw TypeScript sources under `node_modules` made the unit test
  suite unloadable under Node 24. The published dependency therefore moves from
  `0.10.0` to `0.13.0` (pnpm rewrites `workspace:*` to the real version when
  packing/publishing; verified in the packed tarball).

### Tests

- New `tests/goal-escape-ui-prompt.test.ts` covers the foreign-dialog guard:
  Escape yields while a span is open and pauses again after it closes, a running
  audit is not aborted while a dialog is open but is aborted once it closes,
  stray `ui_prompt_end` events never underflow the depth, and `session_start`
  clears a leaked span.
- `tests/goal-settings.test.ts` isolates the global settings layer for the two
  `auditorTimeoutMs` default assertions, so a machine-level
  `~/.pi/agent/pi-goal-x-settings.json` can no longer change the result.

## [0.5.1] — 2026-09-10 (fork release)

### Added

- **Configurable completion-audit wall-clock cap (`auditorTimeoutMs`).** The
  layered settings (global/project) now accept `auditorTimeoutMs`: a positive
  integer of milliseconds, at most `2147483647` (the Node.js timer ceiling).
  The resolved value feeds both the delegation request `timeoutMs` and the
  local terminal timer so the two can never drift; unset or invalid values
  fall back to the built-in 30-minute default, keeping existing behavior
  unchanged. The 5-second launch-handshake and cancellation-acknowledgement
  guards stay internal and are deliberately not configurable. `/goal-settings`
  gains a Completion-auditor row for it with the same validation and
  provenance display as other leaves.

### Fixed

- **Updated a stale package-discovery test expectation.**
  `tests/goal-auditor-package.test.ts` asserted that the child-only progress
  provider appears in the preflight `extensionArgs` under its
  frontmatter-relative path; the current `pi-subagents` fork normalizes
  child-only extension paths to absolute form (as the sibling
  materialization test already expects), so the assertion now matches on the
  provider file name instead of the relative string. Pre-existing failure on
  the workspace symlink layout; unrelated to the timeout setting itself.
- Fork release 0.5.1 (fork feature release; no upstream sync);
  `@xzzpig/pi-subagents` dependency re-verified at the tested 0.10.0 fork
  release.

## [0.5.0] — 2026-09-10 (fork release)

### Changed

- **Synced upstream v0.30.5 → v0.31.2.** Adopted upstream 0.31.0's
  non-conflicting features: ordered atomic `update_goal_task` batches (1–100
  updates with full rollback on invalid transitions and per-item ledger
  events), per-goal ledger indexes (`goal-ledger-index.ts`) with version-3
  checkpoint rebuilds and UTF-8 byte offsets, content-keyed task snapshots
  (`goal-task-index.ts`), lossless `get_goal` detail pages (`goal-detail.ts`),
  warm settings caching, text-layout caches, bounded auditor-stream previews
  (`recentNonEmptyLines`/`labelForReadOnlyTool`/`estimateAuditProgress`),
  auditor session model-runtime sharing for the Oracle
  (`makeAuditorResourceLoader`/`resolveAuditorSessionModelOptions`), the
  session-context filter chained ahead of checkpoint filtering, and upstream's
  deterministic-id fix for the flaky checkpoint-marker test. Upstream
  README/logo and upstream-changelog edits are absorbed; this fork changelog
  keeps its own release history.
- **The constant seven-tool surface is preserved (user decision).** Upstream
  0.31.0 replaced the fork's constant-surface `installGoalTools` with dynamic
  applicable-tool profiles (`installGoalToolProfile`/`installDraftingToolProfile`
  + `applicableGoalTools`), advertising fewer tools per goal state in exchange
  for `setActiveTools` churn on every state/draft transition — which
  invalidates the provider prompt-cache prefix. The conflict was escalated to
  the user, who chose to keep the fork's constant surface: `installGoalTools`
  and the `executionToolDraftGuardMessage` execute() guards remain, upstream's
  dynamic profile machinery and per-turn system-prompt steering blocks were
  dropped, and the checkpoint context filter remains the cache-stable
  per-message `filterGoalCheckpointContext`. The upstream `goal_question` tool
  (removed in 0.4.0 as redundant) was not re-adopted.
- Fork release 0.5.0 (upstream minor release 0.30.5 → 0.31.2 per the fork
  versioning rules); `@xzzpig/pi-subagents` dependency re-verified at the
  tested 0.10.0 fork release.

### Upstream provenance

- Upstream v0.30.5: [source 59826ec818aa](https://github.com/tmonk/pi-goal-x/tree/59826ec818aa8883329a74c62000d18aa1e1dbfe); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/af752e7486050f4ff11fcc4839abc6df6cacd461/subtrees/pi-goal-x.json).
- Upstream v0.31.2: [source 30e1da004ab7](https://github.com/tmonk/pi-goal-x/tree/30e1da004ab716479fd27da8bf35c099e4b6b59e); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/ee4a1017cdb67fbf07cd17f63dd704fd1d36b0a7/subtrees/pi-goal-x.json).

## [0.4.1] — 2026-09-10

### Fixed

- **Completion auditor launches declare project trust.** The auditor's launch
  contract now carries `projectTrusted` and, when the project is trusted,
  `trustedProjectCwd` from the host context, so the `pi-subagents`
  sandbox-profile trust check resolves a project-scoped sandbox policy for the
  auditor child instead of treating the launch as untrusted. Without the flag an
  auditor whose agent file selects a `sandbox:` profile would be refused when its
  policy comes from a trusted project layer.

### Changed

- **Typecheck gate restored.** `tsconfig.json` now targets ES2023 instead of
  ES2022, which resolves the `findLast`/`findLastIndex` errors reported for the
  `pi-subagents` sources this project includes. Typecheck-only change
  (`noEmit: true`); the published files and runtime behavior are unaffected.

## [0.4.0] — 2026-09-06 (fork release)

### Fixed

- **The goal extension no longer invalidates the provider prompt cache.**
  Two mechanisms rebuilt the front of the request prefix, where every change
  invalidates the entire cached history (tools → system → messages; in long
  contexts each rebuild re-processes the whole conversation at full input
  price):
  1. *Per-turn system-prompt injection.* `before_agent_start` prepended a goal
     block to the system prompt on every user turn — and the block contained
     volatile fields (`Usage:` line, task counters) that changed on
     essentially every turn of an active goal, so every user turn paid a
     full-cache miss. One-shot steering notes ([GOAL STALLED], [TOKEN BUDGET
     REACHED], the post-compaction resync, the stale-checkpoint note,
     [PI GOAL UNFOCUSED]) each added an appear+disappear pair of misses on
     top, and never reached auto-continue turns at all (`before_agent_start`
     does not fire on `sendCustomMessage`-triggered turns).
  2. *Drafting↔execution tool-profile switches.* Entering or leaving a guided
     draft called `setActiveTools`, which both swaps the tools block (the very
     first element of the cache prefix) and unconditionally rebuilds the base
     system prompt (`setActiveToolsByName` → `_rebuildSystemPrompt`). Every
     draft cycle cost two full-cache resets — zero prefix hit, not even the
     tools block.

### Changed

- **Goal context now lives entirely in append-only messages; the system
  prompt carries no goal content.**
  - A full goal-context message (`pi-goal-context-event`, display:false) is
    persisted when the goal is created, re-sent after every compaction (the
    summary eats the earlier copy), and re-sent on session load when the
    branch has no copy after its last compaction entry (restart edge,
    cross-branch focus, legacy sessions). It carries the complete objective,
    verification contract, the lifecycle policy ([OUTCOMES]) that previously
    rode the system prompt, sisyphus discipline, and the task tree.
  - The per-turn state snapshot (`pi-goal-state-event`) is dispatched on
    user-driven turns too: `before_agent_start` returns it as the event
    `message` (a supported result field — it lands in the first LLM request
    of the turn and is persisted). Continuation turns keep the 0.3.2
    snapshot-before-marker mechanism; the snapshot's closing line adapts to
    the dispatch mode. Paused and budget_limited goals get the same snapshot
    with their standing gate text; one-shot notes (stall, budget wrap-up,
    unresolved auditor rejection) fold into the snapshot and are consumed.
  - The unfocused-with-open-goals notice became a one-shot edge-triggered
    steering message (`pi-goal-steering-event`) on focus transitions instead
    of a per-turn system block. The stale-checkpoint note rides the
    `before_agent_start` message return instead of a system prompt override.
  - Post-compaction handling now re-sends the full context message directly
    from `session_compact` (mid-run auto-compaction queues it into the live
    run's next request); `buildPostCompactionGoalDelta`,
    `shouldInjectPostCompactReminder`, and the
    `armPostCompactReminder`/`consumePostCompactReminder` runtime pair are
    removed. `armPostBudgetReminder` remains, consumed by the snapshot
    builders.
- **The tool surface is constant for the whole session.** `installGoalTools()`
  activates all seven registered goal tools once at session start on top of
  the host's selection, and no lifecycle event, command, draft transition, or
  settings change ever calls `setActiveTools` again. Drafting isolation is
  guard-based: `create_goal`/`update_goal`/`set_goal_tasks`/`update_goal_task`
  return a redirect message while `core.goalDraftActive` is set (get_goal
  stays callable for reads); `disableTasks` stays enforced inside the task
  tools' own guards. The three/five/drafting profile constants remain for
  tests but no longer drive `setActiveTools`.
- Removed the redundant `goal_question` tool: a single-question
  `goal_questionnaire` call renders the identical dialog and submits on the
  first answer, and an empty options list is a free-text prompt. The drafting
  guidance now directs every structured question to `goal_questionnaire`
  (registered surface: seven tools — five execution + two drafting).
- The `@xzzpig/pi-subagents` dependency is pinned to the tested 0.9.0 fork
  release (the version the typecheck, unit suite, and real-pi end-to-end run
  all exercise); 0.6.0 was a stale pre-sync pin.
- Removed dead code: `goalPrompt`/`buildGoalPrompt`,
  `objectiveEditedPrompt`, the deprecated `continuationPrompt` wrapper, and
  the prompt-fragment cache. Known limitations unchanged and recorded: a
  steer-delivered user message (`prompt()` while streaming) does not fire
  `before_agent_start` and gets no snapshot for that turn; stall detection
  still runs at user turns only, so a silently dead auto-continue chain is
  noticed only when the user returns. Snapshot/context-message growth stays
  bounded by pi auto-compaction (~0.5–1 KB per turn, no volatile counters).

## [0.3.2] — 2026-09-06 (fork release)

### Fixed

- **Goal state now reaches the model on auto-continue turns.** Verified
  against the real pi runtime (0.83–0.84.4): `before_agent_start` never fires
  on `sendCustomMessage`-triggered turns, so the v2 design's assumption that
  "before_agent_start injects the authoritative state once per turn" silently
  failed for exactly the turns auto-continue produces — a continuation-turn
  request carried only the 70-byte checkpoint marker (or, after a user turn,
  a stale leftover system block). Every continuation dispatch now persists a
  bounded state snapshot message (`pi-goal-state-event`, v3 details) right
  before the checkpoint marker, carrying the objective excerpt, status, budget
  line, current task with its contract, the task gate, and a compact rules
  digest; the one-time post-compaction delta folds into the snapshot that
  follows a compaction (it previously stayed armed until a user turn arrived).

### Changed

- **Provider-context checkpoint handling is now a pure per-message filter.**
  The `context` handler replaces `compactGoalCheckpointContext`
  (drop-all-but-last + rewrite) with `filterGoalCheckpointContext`, which
  drops every `pi-goal-event` checkpoint marker from the request. Dropping
  historical markers shifted the message sequence mid-history and invalidated
  the provider prompt cache after the first continuation of every session;
  the surviving-marker rewrite bought nothing (the persisted v2 content
  already equals `checkpointTriggerPrompt` output). Because each marker's
  filter decision is immutable and every marker is paired with the snapshot
  that precedes it, the request context is append-only and prefix-stable
  across requests, so prompt caches keep hitting. Audit events
  (`pi-goal-audit-event`) and state snapshots pass through untouched.
  Snapshot content grows the session by roughly 0.5–1 KB per continuation
  turn; pi's auto-compaction remains the bound, and snapshot content carries
  no volatile usage counters so it stays byte-identical between state
  changes.
- `GoalRuntime` gained the required `sendStateSnapshot(ctx, goal,
  checkpointSeq)` hook; `GoalCheckpointDetailsV2` markers themselves are
  unchanged (content still ≤ `CHECKPOINT_TRIGGER_MAX_CHARS`).

## [0.3.1] — 2026-09-05 (fork release)

### Changed

- **Synced upstream v0.30.0 → v0.30.5** (patch releases). Adopted upstream's
  `networkRecovery` settings-key validation (`maxAttempts` / `maxDelayMs`
  nested-key diagnostics) and the live-pi e2e network-recovery regression
  tests. Upstream 0.30.5 makes goal recovery survive provider-side aborts
  (`stopReason:"aborted"` arriving without a user abort signal) and classifies
  HTTP 429 rate-limit payloads as recoverable transient errors, with
  quota/billing exhaustion staying fail-fast. Upstream README/logo and
  upstream-changelog edits are absorbed; this fork changelog keeps its own
  release history. Fork features preserved: delegation-based completion
  auditor, `auditorAgent`, `max` thinking level, and the `subagents.agents`
  manifest block.

### Upstream provenance

- Upstream v0.30.0: [source 9644b09ac995](https://github.com/tmonk/pi-goal-x/tree/9644b09ac99526b9b9e9c6e0ba195a5b2b756f34); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/4930a3af6c01c12cc14d1d07e19ed9394499a835/subtrees/pi-goal-x.json).
- Upstream v0.30.5: [source 59826ec818aa](https://github.com/tmonk/pi-goal-x/tree/59826ec818aa8883329a74c62000d18aa1e1dbfe); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/af752e7486050f4ff11fcc4839abc6df6cacd461/subtrees/pi-goal-x.json).

## [0.3.0] — 2026-08-24 (fork release)

### Changed

- **Synced upstream v0.27.4 → v0.30.0.** Adopted the layered global/project
  settings rewrite (per-leaf provenance, scope-aware `/goal-settings` editing,
  Blocker Oracle settings), the §61 minimal auditor prompt metadata, and
  upstream's checkpoint-recovery/context-measurement tooling — with the
  delegation-based completion auditor, `auditorAgent` setting, `max` thinking
  level, and `@xzzpig/pi-subagents` integration preserved as fork features.
  Upstream 0.28–0.30 highlights: opt-in read-only blocker Oracle (#26),
  single-source active-goal prompt, UI/model payload separation, layered
  settings (#27), hideUnfocusedBanner (#29), bounded network-error recovery
  (#36), model-context measurement harness (#34).

### Upstream provenance

- Upstream v0.27.4: [source a2b6568b615c](https://github.com/tmonk/pi-goal-x/tree/a2b6568b615c639c76a1924ec2731e9a933876ce); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/21f274fad1239a86403774ff8774fa639e9c6b95/subtrees/pi-goal-x.json).
- Upstream v0.30.0: [source 9644b09ac995](https://github.com/tmonk/pi-goal-x/tree/9644b09ac99526b9b9e9c6e0ba195a5b2b756f34); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/4930a3af6c01c12cc14d1d07e19ed9394499a835/subtrees/pi-goal-x.json).
