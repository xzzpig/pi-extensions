# project-sandbox-profiles Specification

## Purpose

允许项目在受信任的项目配置（`<cwd>/.pi/sandbox.json`）中定义命名 sandbox profile，并与全局同名 profile 按安全语义合并；项目未受信任时，项目定义的 profile 被忽略并给出警告。

## ADDED Requirements

### Requirement: 项目配置可定义 sandbox profile

项目 `sandbox.json` SHALL 允许 `profiles` 名称映射，语法与全局配置一致（profile 名称为非空安全标识符，字段集合与全局 profile 相同）。项目到少定义一个新的 profile 名称时，该名称可被 `sandbox:` / `PI_SUBAGENT_SANDBOX_PROFILE` 选择，如同全局定义。

#### Scenario: 项目定义新的 profile

- **WHEN** 受信任项目的 `sandbox.json` 定义 `profiles: { "project-dev": { filesystem: { allowWrite: ["build/"] } } }`，且 child 以 `sandbox: project-dev` 启动
- **THEN** profile 生效，其有效 sandbox 策略为全局基线（或全局同名 profile）与项目定义的合并结果，`build/` 可写

#### Scenario: 项目定义不存在的 profile 被选择

- **WHEN** 项目未受信任，child 选择仅在项目 `sandbox.json` 中定义的 profile 名称
- **THEN** 项目定义不参与解析，启动失败且诊断指明该 profile 未定义或项目未受信任，MUST NOT 以未约束的策略启动

### Requirement: 同名 profile 合并语义

项目 profile 与全局同名 profile 冲突时，系统 SHALL 合并：项目 profile 的字段覆盖或并集于全局同名 profile，但合并 MUST NOT 削弱全局的 deny 边界。数组字段沿用现有语义：allow 类（`allowRead`、`allowWrite`、`allowedDomains`、`allowUnixSockets` 等）由项目替换，deny 类（`denyRead`、`denyWrite`、`deniedDomains`、`protectNonexistentFiles` 等）取并集且不可被项目清空或移除。敏感放宽项（`allowBrowserProcess`、`enableWeaker*` 等）沿用 `preserveRestrictedBoolean` 语义：全局基线未启用的，项目 profile 不得启用。

#### Scenario: 同名合并保留全局 deny

- **WHEN** 全局定义 `profiles: { "dev": { filesystem: { denyWrite: ["/secrets"], allowWrite: ["/tmp"] } } }`，项目定义 `profiles: { "dev": { filesystem: { allowWrite: ["build/"] } } }`
- **THEN** 合并结果中 `allowWrite` 为 `["build/"]`（项目替换），`denyWrite` 仍含 `["/secrets"]`（全局 deny 保留）

#### Scenario: 项目合并不能启用全局基线未开启的敏感放宽

- **WHEN** 全局基线未启用 `allowBrowserProcess`，项目同名或新增 profile 尝试设置 `allowBrowserProcess: true`
- **THEN** profile 加载失败（保持不变量的 `preserveRestrictedBoolean` 行为），服务不降级启动

### Requirement: 项目 profile 信任门

项目 `sandbox.json` 的 `profiles` 注册表 SHALL 仅在平台项目信任（`ctx.isProjectTrusted()` 为真）时参与 profile 解析与合并。项目未受信任时：项目新增 profile 名称的解析视为「未知名称」处理（不发生放宽）；但系统 MUST NOT 因此直接启动失败——未信任导致的忽略 SHALL 产生警告，提示「项目定义了 N 个 sandbox profile，未应用（项目未受信任）」，且解析退化为仅使用全局注册表（无同名合并）。

#### Scenario: 未信任项目忽略 profile 并警告

- **WHEN** 项目未受信任，且项目 `sandbox.json` 存在 `profiles` 注册表
- **THEN** 项目 profiles 不参与解析，给出警告；若当前选择只存在于项目注册表的名称，则该启动失败（见「项目定义不存在的 profile 被选择」）
- **AND** 未选择任何项目独有 profile 时，行为等同于项目 profiles 为空：全局注册表正常使用，本次更改不引入额外失败

#### Scenario: 受信任项目正常生效

- **WHEN** 项目受信任，且项目 `sandbox.json` 存在 `profiles` 注册表
- **THEN** 项目 profiles 参与解析与同名合并，无警告，行为如「项目配置可定义 sandbox profile」与「同名 profile 合并语义」所述

### Requirement: 子目录启动继承信任

从受信任项目目录的任意子目录启动会话时，项目 profile SHALL 生效，效果与在项目根启动相同（平台 `findNearestTrustEntry` 祖先决策继承语义）。子目录无需单独信任决策。

#### Scenario: 子目录启动项目 profile 生效

- **WHEN** 项目根 `~/work/app` 受信任，child 在 `~/work/app/packages/svc` 下以项目定义的 profile 启动
- **THEN** 项目 profile 正常解析生效，不因 cwd 非项目根而失败

### Requirement: 警告通道

「项目 profiles 未应用」警告 SHALL 通过既有诊断/通知通道传递：有 UI 的会话显示通知，无 UI 的 child 写入启动诊断（`SANDBOX_DIAGNOSTICS_PATH`）并可在 stderr 可见。警告 MUST NOT 被当作失败（进程退出码不变），除非另有导致失败的独立原因（如选择未定义名称）。

#### Scenario: 未信任项目有 profiles 但未选择项目独有名

- **WHEN** 项目未受信任且项目 `sandbox.json` 定义了 profiles，但未选择任何仅在项目注册表存在的名称（选择落空或选择全局名）
- **THEN** 会话产生「项目定义了 N 个 sandbox profile，未应用（项目未受信任）」警告，进程正常启动，退出码不变

#### Scenario: 无 UI child 通过启动诊断收到警告

- **WHEN** 无 UI 的 child 在项目未受信任且项目 `sandbox.json` 定义了 profiles 时启动
- **THEN** 警告写入启动诊断（`SANDBOX_DIAGNOSTICS_PATH`）且可在 stderr 可见，child 不因警告本身失败
