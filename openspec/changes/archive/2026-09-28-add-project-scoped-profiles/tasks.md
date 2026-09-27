## 1. pi-permission-system：项目 profile 注册表与同名合并

（本组纪律：新逻辑进 fork-only `src/policy/profile-scope.ts`；`permission-manager.ts` / `rule.ts` / `config-loader.ts` 只动既存 fork seam，见 design D7）

- [x] 1.1 在 `config-loader.ts`（upstream，shrinking 既有 fork 编辑）移除「项目配置含 `profiles` 即整体拒绝」的规则（`allowProfiles` 语义收窄/移除），项目配置的 `profiles` 透传至结果；验证：项目配置含 `profiles` 的解析单测从「拒绝+issue」改为「正常解析且 `parsed.profiles` 被保留」，且不对上游文件做格式化/无关改动
- [x] 1.2 在 `profile-scope.ts`（fork-only）扩展 `ProfileScopeSelection`：新增 `projectProfiles` 与 `projectTrusted` 入参；未信任 → 项目注册表视为空；验证：resolveProfileScope 相关单测覆盖（信任+同名合并、未信任只见全局、未信任新增名→invalid、无选择→undefined）
- [x] 1.3 在 `profile-scope.ts`（fork-only）新增 `resolveProfileScopes`：返回可区分的全局同名 / 项目同名两层 scope（`[origin, ScopeConfig][]`）+ invalid profile 名 + 未应用警告列表；验证：单测断言两层 origin 与警告文本
- [x] 1.4 在 `permission-manager.ts`（upstream 既有 seam，只扩不新缝）把现有 `resolveProfileScope` 调用块替换为对 `resolveProfileScopes(...)` 的最小调用 + spread；`ModuleOrigin` / `RuleOrigin` 联合类型在 `rule.ts`（upstream 既有缝）追加 `"profile-global"` / `"profile-project"`；验证：作用域合并单测断言 origin 分别为两值、项目逐 pattern 覆盖、未提及 pattern 保留全局同名、全局 deny 保留；本组 upstream 文件改动仅限单调用线与 union 追加
- [x] 1.5 「项目 profiles 未应用」警告：经 `resolveProfileScopes` 的 warnings 汇入 `getConfigIssues`（复用既有 fork 的 invalidProfileName 展示路径，不在 upstream 文件新增独立块）；验证：`getConfigIssues` 单测断言警告文本与 N 统计，且受信任项目无此警告
- [x] 1.6 新增跨会话/解析端到端单测（fork-only 测试文件，不从 upstream 测试文件内新增 describe）：受信任项目用前端块选择项目 profile、未信任项目选择同样名退化到全局同名、未信任项目选择新增名 fail-closed（allow→ask）；验证：对应场景单测通过且 `pnpm --filter pi-permission-system test` 全绿

## 2. pi-sandbox：项目 profile 注册表与同名合并

（本组纪律：全部新逻辑进 fork-only `src/profile-config.ts`，`src/config.ts` 保持与上游字节稳定）

- [x] 2.1 在 `src/profile-config.ts`（fork-only）新增 `mergeProfileObjects(globalProfile, projectProfile)`：顶层浅合（复用 `config.ts` 已 export 的 `mergeObjects`）＋数组沿用 `mergeProfileConfig` 惯例（allow 替换 `replaceConfiguredArray`、deny 并集 `unionConfiguredArrays` 且不可清空），`preserveRestrictedBoolean` 对合并结果继续生效；验证：合并单测覆盖 allow 替换、deny 并集保留全局、项目清空 deny 被拒、敏感放宽项受基线钳制
- [x] 2.2 在 `src/profile-config.ts`（fork-only）扩展 `resolveProfile`：接受信任的项目注册表 → 全局同名 + 项目同名（信任时）`mergeProfileObjects`，项目独有名直接解析；未信任时项目注册表不参与；验证：resolveProfile 单测覆盖同名合并、独有名、未信任忽略
- [x] 2.3 在 `src/profile-config.ts`（fork-only）改 `loadConfig`：项目配置含 `profiles` 从抛错改为「剥除 + 警告」（未信任），受信任时正常参与；警告复用现有 UI/诊断通道（有 UI notify warning、无 UI 写 `SANDBOX_DIAGNOSTICS_PATH`）；验证：单测断言未信任项目「profiles 不参与解析 + 警告出现 + 不抛错」，受信任项目正常合并
- [x] 2.4 在 `src/profile-config.ts`（fork-only）扩展探测视图：`listGlobalSandboxProfiles` 改为「全局 + 受信任项目」合并列表（不改函数签名或改签名走内部兼容），供 launcher/UI 展示项目 profile 名称；验证：单测断言受信任项目名出现在列表、未信任不出现
- [x] 2.5 全量 `pnpm --filter pi-sandbox test` 通过，含既有 profile 未信任 throw 场景改为警告场景的回归更新（在 fork-only `test/profiles-config.test.ts` 内调整，`test/config.test.ts` 等上游文件零改动）

## 3. pi-subagents：互操作与诊断验证

（本组纪律：尽量零代码改动；必须改时走 fork-only 文件 + 最小 seam）

- [x] 3.1 确认 sandbox 信任贯穿（`PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED` + 平台 `isProjectTrusted()`）与 permission 侧 `ctx.isProjectTrusted()` 对同一项目给出一致结果；验证：两包信任隔离单测各断言项目受信/未受信结论一致（可加对照测试）
- [x] 3.2 未信任项目含项目 profiles 时，child 启动诊断与宿主警告不互为冲突（警告不改变退出码、不阻断）；验证：launcher→child 集成单测断言未信任项目场景收到警告而非失败、选择未定义名场景仍失败且诊断正确
- [x] 3.3 选择侧 guard（`projectScopedProfileTrustError`）与新定义侧共存验证：项目 agent 选择「项目定义 profile」在受信项目内通过，未受信仍被 guard 拒绝（行为与 change 前一致）；验证：preflight/executor 单测覆盖两种状态

## 4. 文档与全量验证（含二开纪律审计）

- [x] 4.1 更新 `packages/pi-permission-system/docs/configuration.md`：项目 profiles 语法、信任门、同名合并顺序（全局同名在下、项目同名在上）、未信任警告、示例；更新 `packages/pi-sandbox` 配置文档与 `packages/pi-subagents/docs/agents.md`（若提及 profile 来源）；fork 章节只放 fork-only doc（不在上游文档里铺开）；验证：prettier 检查通过
- [x] 4.2 二开纪律审计：对 permission-manager.ts / rule.ts / config-loader.ts 三个 upstream 文件跑 `git diff --numstat` vs `-w`，断言 raw == -w（无格式噪声）；`src/config.ts`（sandbox）相对上游 numstat 与改动前一致；验证：审计命令输出零噪声
- [x] 4.3 更新 `subtrees/pi-permission-system.json` 与 `subtrees/pi-sandbox.json` 的 notes：记录项目级 profiles 分歧簇（resolveProfileScopes 在 fork-only、permission-manager/rule.ts seam 位置、config-loader 移除的拒绝逻辑、每次 sync 重付指令）；验证：notes 含「re-apply on each future sync」清单且 `direnv reload` 通过
- [x] 4.4 全量验证：`pnpm --filter pi-permission-system run typecheck && pnpm --filter pi-permission-system test`、`pnpm --filter pi-sandbox run typecheck && pnpm --filter pi-sandbox test`、`pnpm --filter pi-subagents run typecheck`、`openspec validate add-project-scoped-profiles --strict`、`pnpm exec prettier --check .`；验证：全部零失败
- [x] 4.5 CHANGELOG 与版本备注：注明「项目配置含 profiles 从拒绝/报错改为信任门 + 忽略警告」的破坏性（错误→警告）转变；验证：CHANGELOG 条目存在且描述准确

## 5. e2e 真机验证（pi-plugin-e2e-test 方法论）

真机验证在隔离的 /tmp 环境跑真实 pi runtime（pi + tmux + `pi-e2e-env.sh`），以 session JSONL、磁盘文件、pane 输出为证据；发布前执行一次，需 pi 模型凭证与 tmux。每组场景先确定证据清单再启动。

- [x] 5.1 受信任项目：项目 profile 实际生效——`/tmp/pi-profile-e2e` 建 `.pi/sandbox.json` 定义 `profiles: { project-dev: { filesystem: { allowWrite: ["build/"] } } }`，配 `.pi/settings.json` 触发平台信任门（避免默认 true 失效），模拟 `/trust` 后启动 pi；验证：bash 写 `build/` 成功、写 `build/../secret` 被拦，session JSONL 出现 profile 相关 entry
- [x] 5.2 未受信任项目：项目 profile 不生效且警告可见——同目录**不**信任，pane 出现「项目定义了 N 个 sandbox profile，未应用（项目未受信任）」通知（`capture` 断言），启动不失败、bash 写 `build/` 被拒；验证：pane 文本 + session JSONL
- [x] 5.3 同名合并真机：全局配置同名 profile 含 `denyWrite`，项目同名 profile 只加 `allowWrite`——受信任下 bash 对 deny 路径仍被拒；验证：真实命令行为与合并单测一致（sandbox 硬隔离生效）
- [x] 5.4 子目录启动：从项目根受信任后，在 `packages/svc` 子目录启动 pi（`--continue` 同 session-dir 亦可），项目 profile 仍生效；验证：pane 行为 + session JSONL
- [x] 5.5 permission profile 真机：受信任项目中 `.pi/extensions/pi-permission-system/config.json` 定义项目 profile，子代理 agent frontmatter 选择它——受信时该 profile 规则生效、未受信时警告且 allow→ask clamp；验证：pane 通知 + 权限弹窗/会话记录（`permission-system show` 输出 origin 含 profile-project）
