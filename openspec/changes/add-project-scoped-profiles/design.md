# Design: add-project-scoped-profiles

## Context

现状（见 proposal.md Why）：两个 profile 系统的「定义」端都硬编码为 global-only。

- `pi-permission-system`：`config-loader.ts` 的 `validateUnifiedConfig` 对 `allowProfiles: false` 的项目配置直接整体拒绝；`permission-manager.resolvePermissions` 里 `resolveProfileScope` 只查 `globalConfig.profiles`，合并通过 `mergeScopesWithOrigins`（`scope-merge.ts`）把 profile 作为单一作用域插入 `[global, project, profile, agent, project-agent]`。项目配置本无条件加载（无 trust 概念）。
- `pi-sandbox`：`profile-config.ts` 的 `resolveProfile` 只查全局注册表；`mergeProfileLayers` 已接收 `projectConfig` 与 `projectTrusted`；项目配置含 `profiles` 会在 `loadConfig` 抛错。项目配置默认不加载（`projectTrusted` 为 false 时跳过）。
- 平台信任：`ExtensionContext.isProjectTrusted()` 由 `SettingsManager` 提供，默认 true，仅当 cwd 存在信任敏感资源（`.pi/settings.json`、`.pi/extensions`、skills、prompts、themes、SYSTEM.md、`.agents/skills`）时按 `~/.pi/trust.json` 最近祖先决策判定；未决 → false（fail-safe）。无敏感资源时恒 true 且不打扰。
- 选择侧 guard 已存在：`pi-subagents` 的 `projectScopedProfileTrustError` 对「项目 agent 选择 profile」强制项目受信 + cwd 匹配；本次不改选择侧。

## Goals / Non-Goals

**Goals:**

- 项目配置可定义 profile 注册表，两个系统对称放开
- 同名项目 profile 与全局同名 profile 安全合并：permission 走 pattern 级、sandbox 走字段级，均不削弱全局 deny
- 项目 profiles 挂平台信任门；未信任 → 忽略但警告（明确替代 sandbox 现状的启动失败）
- 子目录启动继承项目根信任（复用平台祖先决策，不新增前缀匹配逻辑）
- 复用两包现有合并机制，最小新增代码面

**Non-Goals:**

- 不改选择侧：launcher 对项目 agent 选择 profile 的信任 guard、env/frontmatter 双通道、precedence 均不变
- 不做 profile 显式 `extends`（继承链）机制；需要时由同名合并 + `inheritGlobalConfig`（sandbox 已有）组合表达
- 不做跨项目 profile 共享/导出、不做用户级「个人项目」profile
- 不引入 profile 版本化或迁移

## Decisions

### D1. permission：同名合并 = 在 `mergeScopesWithOrigins` 插入两层，零新合并逻辑

现有调用把 profile 作为单一 `["profile", profileScope]` 插入。项目同名合并就是把插入从 1 层变 2 层：

```
mergeScopesWithOrigins([
  ["global", globalConfig],
  ["project", projectConfig],
  ["profile-global", outerProfileScope],   // 全局同名（在下）
  ["profile-project", innerProfileScope],  // 项目同名（在上，覆盖同 pattern）
  ["agent", agentConfig],
  ["project-agent", projectAgentConfig],
])
```

- `mergeFlatPermissions`（`permission-merge.ts`）已实现 surface 浅合 + pattern 深合，逐 pattern 覆盖、未提及保留——正是 D 要求的合并语义
- origin 跟踪自动区分 `profile-global` / `profile-project`，`/permission-system show` 与 review 日志零额外工作
- 失败关闭现成：invalid profile → `failClosedScopes.push("profile")` → `floorAllowsToAsk`
- 备选（否决）：在 `resolveProfileScope` 里预合成（合并两个 profile 成一个 scope）会丢失 origin 区分，且与现有「profile 是独立作用域」心智冲突

### D2. permission 信任门：解析期传 trust 标志，未信任时项目注册表为空 + 警告

`resolveProfileScope` 新增入参 `projectTrusted`（或 `projectProfiles` 已按信任裁剪）。未信任时：

- 项目新增名 → 解析为未知（现有 fail-closed 路径，零新逻辑）
- 存在项目同名定义 → 只用全局同名（profile-project 层不插入）
- 警告通过 `getConfigIssues` 合并渠道呈现（permission 已有 issues 列表机制）

permission 的 trust 状态来源：`PermissionManager`/handler 层有 `ExtensionContext`（`lifecycle.ts`、`session-turn-prep.ts` 已消费 `isProjectTrusted()`），在 resolve 入口传入。loader 保持纯函数。

备选（否决）：给「项目配置里写 permissions」整体加信任门——那会改变既有行为（现在项目直接写 permissions 无条件生效），超出本 change 范围且破坏兼容。

### D3. sandbox：新增 profile×profile 合并，复用 `mergeObjects` + `mergeProfileConfig` 数组惯例

`resolveProfile` 从「只查全局注册表」改为「全局同名 + 信任时项目同名」，新增一个小的 `mergeProfileObjects(globalProfile, projectProfile)`：

- 顶层浅合 `mergeObjects`（`config.ts` 现成：顶层 spread + network/filesystem 两级浅合）
- 数组字段沿 `mergeProfileConfig` 现成惯例：allow 类替换（`replaceConfiguredArray`）、deny 类并集（`unionConfiguredArrays`）→ 全局 deny 永不被顶掉或清空
- `preserveRestrictedBoolean` 对合并结果继续生效（敏感放宽项不能被项目同名 profile 启用）
- `inheritGlobalConfig` 语义不变（作用于 profile 与其继承基线之间，不参与 profile×profile 合并）

`loadConfig` 未信任路径：项目 `profiles` 从「抛出」改为「剥除（视为空）+ 警告」；新增 profile 名选择 → 仍走未知名称的既有 fail-closed 启动失败。`listGlobalSandboxProfiles` 改名/扩展为合并视图（信任时含项目名）。

### D4. 匿名警告通道统一：不阻断、可诊断

两包对「未信任项目有 profiles」只警告不失败：

- 有 UI：`ctx.ui.notify(..., "warning")`
- 无 UI child：sandbox 写启动诊断（`SANDBOX_DIAGNOSTICS_PATH` 现成）；permission 走 `getConfigIssues`（session 内可见）
- 警告文本统一模板：「项目定义了 N 个 <kind> profile，未应用（项目未受信任）」
- 与「选择未定义名称 → 失败」分开：警告不改变退出码；独立失败原因仍失败

### D5. 子目录复用平台信任，不新增前缀逻辑

不引入 `trustedCwd === cwd` 的精确匹配（现状 guard 用精确匹配，但那是选择侧；定义侧解析发生在 child 会话内，`isProjectTrusted()` 已是按祖先决策解析的布尔值）。项目根被信任 → 子目录内该布尔值同样为 true → 项目 profiles 生效，天然满足。无需额外 cwd 比较。

### D6. pi-subagents 触碰最小化

选择侧 guard 已存在，本次只在以下点验证/小幅适配：

- 若 child 的「未信任」状态需要透传给定义侧解析（sandbox 已有 `PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED` 贯穿），permission 侧确认 handler 能取到 `ctx.isProjectTrusted()` 即可，不新增 env
- 警告的 UI 呈现与现有 profile 启动告警共用通道

### D7. 二开分歧纪律落点（本 change 强制约束）

三个包均为 upstream subtree 二开（pi-permission-system ← gotgenes/pi-packages，pi-sandbox ← carderne/pi-sandbox，pi-subagents ← nicobailon/pi-subagents），本次每处改动 MUST 落点如下，并写进各自 `subtrees/*.json` notes：

| 改动                                                   | 落点                                                                                                                                     | 冲突面 | 纪律                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| permission 同名合并、trust 门、警告收集                | fork-only `src/policy/profile-scope.ts`（扩展 `ProfileScopeSelection`，新增 `resolveProfileScopes` 返回双层 scope + invalid + warnings） | 零     | 新逻辑全进 fork-only                                                                                                |
| permission-manager 装配                                | upstream `src/policy/permission-manager.ts`（已有 +82/-3 fork seam）                                                                     | 低     | 只扩既存 seam：把现有 `resolveProfileScope` 调用块替换为最小调用 `resolveProfileScopes(...)` + spread，不新增独立缝 |
| `RuleOrigin` 新增 `profile-global` / `profile-project` | upstream `src/policy/rule.ts`（已有 +4/-1 fork：`profile` 成员）                                                                         | 低     | 同一缝延续（union 追加两成员），记录为 recurring cost                                                               |
| 移除「项目 profiles 拒绝」                             | upstream `src/config/config-loader.ts`（已有 +63/-3 fork）                                                                               | 低     | **删除**既存 fork 编辑（shrinking，非新增）；`allowProfiles` 语义收窄或移除                                         |
| sandbox 同名合并、trust 门、警告、合并视图             | fork-only `src/profile-config.ts`                                                                                                        | 零     | `src/config.ts` 保持字节稳定（mergeObjects 已有 export，不再碰）                                                    |
| 测试                                                   | fork-only 测试文件（`permission-profiles-*.test.ts`、`profiles-config.test.ts` 等，不在 upstream 测试文件内新增 describe）               | 零     | fork 行为测试只在 fork-only 文件                                                                                    |
| pi-subagents                                           | 尽量零代码改动，只做互操作验证；必须改时走 fork-only 文件 + 最小 seam                                                                    | 低     | 同纪律                                                                                                              |

非目标重申：不在 upstream 文件内新增独立 fork 块、不对 upstream 文件做格式化/改写，`prettier` 只覆盖 fork-only 文件（见根 `.prettierignore`）。每次 sync 后按 `subtrees` notes 的重新应用清单重审。

## Risks / Trade-offs

- [项目同名 profile 与全局同名语义反转] → 防御性文档 + spec Scenario 明确覆盖「项目覆盖仅作用于未提及/同名 pattern，全局 deny 保留」（D1/D3 结构性保证，非文档承诺）
- [未信任项目「忽略但警告」可能被误读为「配置静默失效」] → 警告文本含 profile 数量与「未应用」字样；与失败场景（选择未定义名）的诊断分开，杜绝静默放宽
- [permission loader 纯函数性：trust 从 handler 传入增加调用面] → trust 仅作布尔入参传递，不改变 loader 的确定性（相同输入相同输出），可单测性保持
- [sandbox 现状「项目 profiles → 报错」的既有使用者] → 语义从「错误」变「警告/忽略」，破坏性变化仅在错误->警告一侧；release notes / CHANGELOG 注明
- [两个包对「项目信任」的判定来源不同步（sandbox 经 launcher env，permission 直接 ctx）] → 两者最终都锚定平台 `isProjectTrusted()`；以 spec 的信任门 requirement 作为行为契约，测试覆盖两种通道一致
- [upstream 文件 seam 增扩（permission-manager / rule.ts）在下次 `git subtree pull` 中碰撞] → 三处均为既有 fork 缝的延续（非新缝）；notes 记录每次 sync 重付指令；sync 后按纪律做 numstat 噪声审计（raw == -w）

## Migration Plan

1. 实现顺序：permission（D1/D2）→ sandbox（D3/D4）→ pi-subagents 互操作验证（D6）
2. 兼容性：未定义任何项目 profiles 的既有项目行为字节级不变（permission 项目配置的 `profiles` 从「拒绝」变「允许」只影响原本就写 `profiles` 的项目——那是破坏性面，已在 Risks 声明）
3. 回滚：单包独立发版；pi-permission-system / pi-sandbox 各自可回退版本，launcher env 契约不变
4. 发布前跑 tasks 第 5 组真机 e2e（pi-plugin-e2e-test 方法论）：受信任/未受信任/同名合并/子目录/permission 五场景，证据为 session JSONL + pane 文本 + 磁盘文件，隔离于 /tmp；单元与集成层绿队只证明代码正确，真机 e2e 证明 profile 信任门与合并语义在真实 pi 运行时（TUI 通知、sandbox 硬隔离、权限钳制）兑现

## Open Questions

无（探索阶段已通过用户确认拍板：同名合并、信任即一切、未信任忽略但警告、permission 挂信任门、子目录继承）。
