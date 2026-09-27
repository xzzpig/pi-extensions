## Why

`pi-tool-display` fork 新增的 `bashCommandDisplay` 选项（`full` / `collapsed` / `auto`）已经在代码中实现（fork-only 的 `src/bash-command-display.ts` 及其接缝）、在配置面板与设置检查器中暴露、并有 18 个单元测试覆盖，但 openspec 里没有对应的 spec：这段行为契约目前只存在于 `subtrees/pi-tool-display.json` 的 `notes` 里（其中一条按日期的叙述）。

`git subtree pull` 之后，判断"折叠行为、宽度钳制与展开优先这些保证是否被上游改动破坏"需要读代码与测试。把它固化为 spec，可以让同步取舍有清单可依，也让 notes 只保留维护契约。

## What Changes

- 新增 capability `bash-command-display`，把**既有实现**的行为契约写为规范：配置取值与默认值、折叠为单行的规则、ANSI 感知的宽度钳制与宽度回退顺序、`auto` 模式的时机判定、展开优先、以及"只影响命令行渲染、不改变实际执行命令"的不变式。
- **不改变任何运行行为**：本 change 只补规范。
- 该能力在 `subtrees/pi-tool-display.json` `notes` 中的叙述改由本 spec 承载，notes 只保留上游接缝、每次同步需重做的手工步骤与"不要再引入"的决定。

## Capabilities

### New Capabilities

- `bash-command-display`: 定义 bash 工具调用行中命令行的显示模式（`full` / `collapsed` / `auto`）、折叠与宽度钳制规则、展开行为，以及显示层不改变执行语义的保证。

### Modified Capabilities

无。本 change 不改动任何既有 capability 的要求。

## Impact

- 归档后新增 `openspec/specs/bash-command-display/spec.md`。
- 相关实现（只读引用，不修改）：`packages/pi-tool-display/src/bash-command-display.ts`（fork-only 折叠/钳制/模式判定）、`src/types.ts`（默认 `full`）、`src/config-modal.ts`（配置面板与设置检查器）、`src/presets.ts`（`configsEqual`）。
- 对外文档：`packages/pi-tool-display/README.md` 描述该选项，spec 与它必须一致。
- 无 API、依赖或运行行为变化。
