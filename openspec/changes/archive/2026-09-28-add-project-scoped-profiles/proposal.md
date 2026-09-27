# Proposal: add-project-scoped-profiles

## Why

`pi-permission-system` 的命名 permission profile 与 `pi-sandbox` 的命名 sandbox profile 目前只能在全局配置（`~/.pi/...`）中定义：项目配置文件只要出现 `profiles` 键就会被整体拒绝（permission 侧 fail-closed）或显式报错（sandbox 侧）。团队无法把 profile 随仓库提交——每个项目要声明自己的读写路径、允许的域名或 agent 角色权限，只能改全局配置（影响所有项目）或依赖操作员手工维护。这让「clone 即用」的项目级安全契约无法落地。

## What Changes

- **pi-permission-system**：允许项目配置（`<cwd>/.pi/extensions/pi-permission-system/config.json`）定义 `profiles` 注册表；去掉现有「项目配置含 profiles 整体拒绝」的规则。
- **pi-sandbox**：允许项目配置（`<cwd>/.pi/sandbox.json`）定义 `profiles` 注册表；去掉现有「项目 sandbox.json 不得定义 profiles」的显式报错。
- **同名合并**：项目 profile 与全局同名 profile 按模式/字段级合并（不覆盖全局 deny、不可清空）；项目独有的新名字直接可用。
- **信任门**：项目 profiles 仅在平台项目信任（`ctx.isProjectTrusted()`）为真时参与解析与合并；未信任项目的 profiles 被忽略并给出警告（替代 sandbox 侧现在的启动失败）。项目目录树的祖先信任决策天然覆盖子目录启动。
- **选择侧不变**：launcher 已有的项目 agent 选择 profile 的信任 guard（`projectScopedProfileTrustError`）继续生效；本次只放开「定义」侧。

## Capabilities

### New Capabilities

- `project-sandbox-profiles`: 在受信任的项目中定义与合并 sandbox profile，并在未信任时忽略且警告。
- `project-permission-profiles`: 在受信任的项目中定义与合并 permission profile，并在未信任时忽略且警告。

### Modified Capabilities

<!-- openspec/specs 下尚无 agent-sandbox-profiles / agent-permission-profiles 的既有 capability（均在各自 change 内、未 sync），因此不修改现有 capability，新能力按 New Capabilities 声明。 -->

## Impact

- `packages/pi-permission-system`（upstream subtree 二开）：配置 schema 与 loader、`resolveProfileScope` / `permission-manager` 作用域装配、信任状态的传入与警告、`/permission-system show` 的 origin 视图。
- `packages/pi-sandbox`（upstream subtree 二开）：profile 解析（新增 profile×profile 合并）、`listGlobalSandboxProfiles` → 合并视图、未信任时 throw → 忽略+警告、启动诊断。
- `packages/pi-subagents`（upstream subtree 二开）：项目 profile 定义的信任检查与警告/诊断传递通道（选择侧 guard 已存在，需互操作验证）。
- **二开分歧纪律约束**：新逻辑全部落 fork-only 文件（`profile-scope.ts`、`profile-config.ts`）；upstream 文件（`permission-manager.ts`、`rule.ts`、`config-loader.ts`、sandbox `config.ts`）只动既存 fork seam 或零改动，`subtrees/*.json` notes 记录分歧簇与 sync 重付指令；测试与文档 fork 章节只进 fork-only 文件。
- 文档：pi-permission-system `docs/configuration.md`、pi-sandbox 配置文档、两包 README；测试覆盖合并语义、信任门、未信任警告、子目录继承。
