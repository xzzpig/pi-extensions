# 提案

## Why

BTW 虽然复用了 Pi 原生消息和工具组件，但丢失助手流式状态、重建消息实例且未连接工具显示定义，导致思考被提前折叠、无法展开，以及工具插件样式缺失。需要在不扩大 BTW 执行权限的前提下，对齐主会话中最常用的内容显示与交互。

## What Changes

- 为共享 transcript 增加可选的有状态展示层，保留消息身份、真实流式状态和局部展开状态；旧的无状态接口继续可用。
- BTW 接入该展示层，支持思考点击展开和键盘切换，修复视口、主题、组件内部重绘后的缓存失效。
- 复用宿主进程中已安装的原生组件补丁，兼容 `pi-thinking-collapse`、`pi-tool-display` 用户消息框等已有显示行为。
- 为 `pi-tool-display` 增加版本化、只读的显示能力接口，向 BTW 提供其支持的工具 renderer；保留子会话工具自身 renderer，未支持的工具降级为 Pi 原生显示。
- 明确有限兼容范围：不复制整个主会话、不自动在子会话加载主会话扩展、不保证任意插件的主界面布局和消息事件改写效果。
- 补充状态、插件兼容、隔离性与真实 TUI 验证。

## Capabilities

### New Capabilities

无。共享 transcript 领域已由 `transcript-builder-api` 承载，不另建同域能力。

### Modified Capabilities

- `transcript-builder-api`：扩展有状态展示、BTW 显示插件兼容及权限隔离要求；将旧迁移的行为等价约束限定为存量接口，不阻止 BTW 显式采用新展示能力。

## Impact

- `packages/pi-components`：新增可选的展示控制器、组件注册与失效机制，保留现有构造 API 和无状态渲染调用方式。
- `packages/pi-btw`：通过 fork-only 展示适配模块和最小入口接缝接入；保持现有扩展白名单、工作区与会话权限模型。
- `packages/pi-tool-display`：新增 fork-only 显示提供者及已有 API 的增量能力，避免共享注册工具的执行定义。
- 不更改 fleet inspector 的默认行为；仅运行其回归测试，防止共享库变动破坏现有消费者。
- 不修改 Pi 核心，不新增必装显示插件，不在本轮规划中发布、提交或实现代码。
