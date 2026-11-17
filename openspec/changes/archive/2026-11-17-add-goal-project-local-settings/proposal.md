# 提案：Goal-X 项目本地配置层

## Why

目前 Goal-X 只有全局与项目两个配置文件来源，无法同时保留个人全局偏好、Git 管理的团队配置，以及仅对当前项目生效且不入 Git 的个人覆盖。以本仓库为例，审计纪律应共享，而审计模型选择应留在个人工作区，不应替换全局文件或依赖生成合并文件。

## What Changes

- 自动读取 `<cwd>/.pi/pi-goal-x-settings.local.json`，对全部受支持的 Goal-X 配置增加 `local` 层；优先级为已有配置项环境变量 > local > project > global > 默认值。
- 延续逐字段继承、数组整体替换、显式合法 false/0 覆盖与删除字段恢复继承的语义，不新增 null 清除协议。
- `/goal-settings` 完整支持 global/project/local 三个编辑范围及 Controls 子菜单，默认仍编辑 project；显示最终值、来源、本层值和被高层覆盖提示。
- 将 local 纳入校验、诊断、来源报告、缓存和原子写入；保留既有路径环境变量及旧 API 的原义。
- 本仓库忽略该本地文件名，提供三来源配置说明；插件不得自动修改用户仓库的 Git 忽略规则。
- 不迁移用户现有配置，不恢复 auditor provider/model 环境变量，不增加通用配置框架或其他包的配置能力。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `goal-lifecycle`：补充 Goal-X 三层文件配置、设置编辑与来源追踪契约，保持既有目标生命周期和完成审计事务不变。

## Impact

- 主要涉及 `packages/pi-goal-x/extensions/goal-settings.ts`、`goal-commands.ts`、`widgets/goal-controls-dialog.ts` 及 fork-only 配置辅助模块。
- 扩展设置范围、来源与快照类型，兼容旧 global/project 调用者；检查配置消费者、缓存与 per-goal auditor override 的顺序。
- 增加 fork-only 自动化测试及真实 Pi TUI 验收；遵循 subtree 最小接缝纪律并更新确有同步成本的元数据条目。
- 文档以 fork-only `docs/` 文件为主，纳入打包清单；README 仅作已有 Settings 内容的必要事实修正，发布说明进 CHANGELOG。
- 后续实现可调整根 `.gitignore`，但不得改写工作区原有 `.pi/pi-goal-x-settings.json`、全局个人文件或自动搬迁模型设置。
- 不新增运行时依赖，不修改 pi-subagents，不提交、推送或发布。
