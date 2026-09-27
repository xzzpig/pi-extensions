## Why

`pi-permission-system` fork 的核心分歧——可配置的 bash 包装器兜底（`wrapperFloors`）——已经在代码中实现并对外文档化（包 README 的 Fork notice、`docs/configuration.md`、`schemas/permissions.schema.json` 的字段说明），但 openspec 里没有任何 spec 描述它：这段行为契约目前只存在于 `subtrees/pi-permission-system.json` 的 `notes` 里。

`notes` 是维护记录（接缝位置、每次同步需重做的手工步骤），不是规范。用 notes 承载行为契约的代价是：每次 `git subtree pull` 之后，判断"哪些行为必须保留"只能读散文，且无法校验、无法在评审时逐条对照。把这段契约固化为 spec，可以让同步时的取舍有明确依据，也让 notes 只保留它真正该记的东西。

## What Changes

- 新增 capability `bash-wrapper-floors`，把**既有实现**的行为契约写为规范：包装器识别范围、内层命令作为独立单元门控、仅不可静态解析的内容兜底为 `ask`、`wrapperFloors` 配置（`fallback` 默认 / `always` 上游行为）、纯读取器豁免，以及与显式规则、`yoloMode`、会话授权的交互。
- **不改变任何运行行为**：本 change 只补规范，代码已实现且已文档化。
- 该能力在 `subtrees/pi-permission-system.json` `notes` 中的架构叙述改由本 spec 承载，notes 只保留上游接缝、每次同步需重做的手工步骤与"不要再引入"的决定。

## Capabilities

### New Capabilities

- `bash-wrapper-floors`: 定义 fork 对 bash 包装器命令（`eval`、`bash -c`、`sudo`、`env`、`xargs`、`timeout`、`find -exec` 等）与不可静态解析内容的分级门控行为，以及 `wrapperFloors` 配置项的语义。

### Modified Capabilities

无。本 change 不改动任何既有 capability 的要求。

## Impact

- 归档后新增 `openspec/specs/bash-wrapper-floors/spec.md`。
- 相关实现（本 change 只读引用，不修改）：`packages/pi-permission-system/src/access-intent/bash/wrapper-floors.ts`（fork-only 包装器分类器）、`src/handlers/gates/bash-command.ts`（`resolveWrapperUnit` 兜底决策）、`src/config/extension-config.ts`（默认 `fallback`）、`src/session/permission-session.ts`（`getWrapperFloors`）。
- 对外文档：`packages/pi-permission-system/README.md`、`docs/configuration.md`、`schemas/permissions.schema.json` 已经是该行为的权威描述，spec 与它们必须一致。
- 无 API、依赖或运行行为变化。
