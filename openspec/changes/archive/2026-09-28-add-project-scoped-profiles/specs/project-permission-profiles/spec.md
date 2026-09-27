# project-permission-profiles Specification

## Purpose

允许项目在受信任的项目配置（`<cwd>/.pi/extensions/pi-permission-system/config.json`）中定义命名 permission profile，并与全局同名 profile 按 pattern 级合并；项目未受信任时，项目定义的 profile 被忽略并给出警告。

## ADDED Requirements

### Requirement: 项目配置可定义 permission profile

项目配置文件 SHALL 允许 `profiles` 名称映射，语法与全局配置一致（profile 名称为非空安全标识符，规则集结构与全局 profile 相同）。项目至少定义一个新的 profile 名称时，该名称可被 `permission-profile:` frontmatter / `PI_SUBAGENT_PERMISSION_PROFILE` 选择，如同全局定义。现有「项目配置含 `profiles` 键 → 整体拒绝（项目 scope invalid）」的规则 SHALL 移除。

#### Scenario: 项目定义新的 profile

- **WHEN** 受信任项目的配置定义 `profiles: { "docs-reviewer": { permission: { "read": "allow" } } }`，且 agent frontmatter 声明 `permission-profile: docs-reviewer`
- **THEN** profile 作为作用域参与权限合并（介于 project 与 agent 之间），`read` 规则生效

#### Scenario: 项目定义不存在的 profile 被选择

- **WHEN** 项目未受信任，agent 选择仅在项目配置中定义的 profile 名称
- **THEN** 该 profile 解析为未知名称 → profile 作用域 invalid → `allow` 被 clamp 为 `ask`（沿用 fail-closed），诊断指明该 profile 无法解析

### Requirement: 同名 profile 合并语义

项目 profile 与全局同名 profile 冲突时，系统 SHALL 在 `(surface, pattern)` 键上合并：项目 profile 覆盖全局同名 profile 的单个 pattern，未提及的 pattern 保留全局同名 profile 的值。合并只在决议时发生（每次权限解析重算），不修改任何配置文件。

#### Scenario: 同名合并覆盖单个 pattern

- **WHEN** 全局定义 `profiles: { "dev": { permission: { "bash/*": "ask", "read": "allow" } } }`，项目定义 `profiles: { "dev": { permission: { "read": "ask" } } }`
- **THEN** 合并后的 `dev` 有效规则为 `bash/*: ask`（保留全局）与 `read: ask`（项目覆盖），origin 标注区分全局 profile 贡献与项目 profile 贡献

### Requirement: 项目 profile 信任门

项目配置的 `profiles` 注册表 SHALL 仅在平台项目信任（`ctx.isProjectTrusted()` 为真）时参与 profile 解析与合并。项目未受信任时：项目新增 profile 名称解析为未知（fail-closed），同名选择退化为仅使用全局同名 profile；同时系统 SHALL 产生警告「项目定义了 N 个 permission profile，未应用（项目未受信任）」。

#### Scenario: 未信任项目忽略同名定义并仅用全局

- **WHEN** 项目未受信任，agent 选择 `dev`（全局与项目均定义该名称）
- **THEN** 使用全局 `dev` profile，项目 `dev` 的覆盖不生效，产生「未应用」警告，权限不退化放宽

#### Scenario: 未信任项目的新 profile 选择 fail-closed

- **WHEN** 项目未受信任，agent 选择仅在项目配置定义的 profile 名称
- **THEN** profile 解析为未知 → 该 agent 的 `allow` clamp 为 `ask`（沿用 fail-closed 语义与诊断消息）

#### Scenario: 受信任项目正常生效

- **WHEN** 项目受信任，项目配置存在 `profiles` 注册表
- **THEN** 项目 profiles 参与解析与同名合并，无「未应用」警告

### Requirement: 子目录启动继承信任

从受信任项目目录的任意子目录启动会话时，项目 profile SHALL 生效，效果与在项目根启动相同（平台祖先信任决策继承语义）。子目录无需单独信任决策。

#### Scenario: 子目录启动项目 profile 生效

- **WHEN** 项目根 `~/work/app` 受信任，agent 在 `~/work/app/packages/svc` 下选择项目定义的 profile
- **THEN** 项目 profile 正常解析生效，不因 cwd 非项目根而失败

### Requirement: 警告与诊断

「项目 profiles 未应用」警告 SHALL 与现有配置问题诊断合并呈现（`getConfigIssues` / UI 通知通道），且 MUST NOT 使信任的项目场景或未选择项目 profile 的场景产生任何额外错误。

#### Scenario: 未信任项目有 profiles 时产生警告、不阻断

- **WHEN** 项目未受信任且项目配置定义了 profiles，无论当前是否选择 profile
- **THEN** 产生「项目定义了 N 个 permission profile，未应用（项目未受信任）」警告，叠加在现有配置问题诊断上，权限解析不因警告本身失败

#### Scenario: 受信任或未定义 profiles 的项目无警告

- **WHEN** 项目受信任且项目配置定义了 profiles，或任何项目未定义 profiles
- **THEN** 不产生「未应用」警告，解析行为与 change 前一致
