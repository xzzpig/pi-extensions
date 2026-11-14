# tidy-transcript-rendering Specification

## Purpose

定义 `@xzzpig/pi-tidy` 二开后的转录渲染契约：保留哪些上游能力、fork 运行时默认值、工具框开关语义，以及宿主私有接口不可用时的降级行为。

## Requirements

### Requirement: fork 运行时默认值

`@xzzpig/pi-tidy` MUST 在入口处以 fork-only 模块覆盖运行时默认值，MUST NOT 修改上游 `DEFAULTS` 常量。默认关闭：工具框、整轮折叠、工具分组、并排 diff、bash 语法高亮、背景任务行、选区清洗、逐工具边框色。默认开启：消息框、错误行去重、hex 色块、最终回复框、代码块分节、用户消息样式。上游将 `userMessageStyle: "frame"` 与一般消息框耦合在 `frameMessages` 开关下，因此开启消息框时也会绘制 compaction、branch、skill 与 custom message 边框。

#### Scenario: 上游配置默认值未被改写

- **WHEN** 直接调用上游 `loadConfig()` 而不经过 fork 入口
- **THEN** 返回的仍是上游原始默认值，上游 `config` 相关测试通过

#### Scenario: 运行时按 fork 默认值生效

- **WHEN** 用户未配置 `tidy` 对象即启动会话
- **THEN** 工具框不出现，用户消息显示 frame，一般消息框、错误行去重与 hex 色块生效

### Requirement: 工具框开关与悬停跟踪解耦

fork MUST 提供 `frameTools` 配置键，默认 `false`。为 `false` 时 MUST NOT 安装工具框补丁，MUST NOT patch `ToolExecutionComponent`；同时 MUST 单独安装悬停跟踪，保证代码块复制控件的悬停高亮与手型光标仍可用。

#### Scenario: 关闭工具框后不 patch 工具组件

- **WHEN** `tidy.frameTools` 为 `false`
- **THEN** `ToolExecutionComponent.prototype.render` 保持宿主原实现，工具框由其他插件或宿主绘制

#### Scenario: 关闭工具框后代码块控件仍可悬停

- **WHEN** `tidy.frameTools` 为 `false`，且回复中出现围栏代码块
- **THEN** 代码块复制控件在指针悬停时高亮并显示手型光标，点击可复制该块文本

### Requirement: 错误行去重

当宿主对同一次失败按重试次数重复打印相同错误行时，系统 SHALL 保留第一行并为其加框，其余重复 MUST 折叠为 `×N` 计数。系统 MUST NOT 改动警告行、提示行与中止行。

#### Scenario: 三次重试只显示一行

- **WHEN** 一次请求失败并被重试三次，宿主打印三段相同错误
- **THEN** 显示一行带 `×3` 计数的加框错误，其余两段不再出现

#### Scenario: 警告不受影响

- **WHEN** 宿主输出一条 warning 行
- **THEN** 该行按宿主原样显示，不加框、不计重复

### Requirement: hex 色块

系统 SHALL 在消息文本中出现的颜色字面量前绘制一个用该颜色着色的 `●`。识别范围 MUST 包含 3 至 8 位十六进制、`rgb()` / `rgba()` 与 `hsl()` / `hsla()`。系统 MUST NOT 识别 CSS 命名色，MUST NOT 改动围栏代码块、行内代码与思考文本。

#### Scenario: 十六进制颜色加色块

- **WHEN** 助手回复包含 `#7f849c`
- **THEN** 该处显示为 `● #7f849c`，圆点使用 `#7f849c` 绘制

#### Scenario: 围栏代码块保持原样

- **WHEN** 颜色字面量出现在围栏代码块内
- **THEN** 该处不加色块，文本不变

### Requirement: 最终回复框

系统 SHALL 为已稳定结束的最终文本回复绘制边框，并在边框上标注作答的模型名与时间。样式 MUST 支持 `frame`、`rail`、`rules` 与 `off` 四种取值。系统 MUST NOT 为中间的工具调用消息绘制该边框，MUST NOT 改动回复内的 Markdown 渲染与鼠标目标。

#### Scenario: 最终回复带模型名

- **WHEN** 一轮正常结束并产出最终文本回复
- **THEN** 该回复被边框包裹，边框上显示该回复所属的模型名与时间

#### Scenario: 中间消息不绘制

- **WHEN** 助手发出仅含工具调用的中间消息
- **THEN** 该消息不被绘制为最终回复框

### Requirement: 最终回复框与 Pi 思考折叠协作

当启用 pi-tidy 最终回复框且 Pi 将最终回复中的思考块折叠时，fork MUST 在最终回复框外显示 Pi 原有的折叠思考提示；MUST 保留 Pi 原生点击展开/折叠行为，MUST NOT 把思考正文放进最终回复框，也 MUST NOT 为了兼容而关闭 `finalReplyStyle`。

#### Scenario: 完成回复的折叠提示位于最终框外

- **WHEN** 一条带思考块与文本的助手最终回复结束，且 `finalReplyStyle` 不是 `off`
- **THEN** `Thinking… (click to expand)` 显示在最终回复框之前；点击提示展开思考、再次点击恢复折叠，最终回复框始终保留

### Requirement: 代码块分节与复制

当系统绘制助手回复时，SHALL 将围栏代码块的两条围栏行替换为横线，并在开口行标注语言与复制控件。点击复制控件 MUST 将该代码块文本写入剪贴板。语言无可用语法时 MUST 回退到最接近的语法，MUST NOT 改变代码行本身的渲染。

#### Scenario: 代码块带语言标签与复制

- **WHEN** 回复包含一个 `ts` 围栏代码块
- **THEN** 开口横线显示 `ts` 与复制控件，点击后该块文本进入剪贴板

#### Scenario: 未知语言回退

- **WHEN** 围栏语言为宿主语法表未覆盖的语言
- **THEN** 使用最接近的语法着色，代码行不丢失

### Requirement: 私有 Pi 接口不可用时降级

当依赖的宿主私有接口不存在或已改名时，系统 MUST 保持宿主原样显示，MUST NOT 抛错，MUST NOT 静默改变其他插件的行为，并 SHALL 在会话开始提示一次受影响的能力。

#### Scenario: 错误行钩子不可安装

- **WHEN** 宿主不再暴露用于安装错误行钩子的接口
- **THEN** 错误行按宿主原样显示，会话开始时提示一次去重能力不可用

#### Scenario: 代码块接口不可用

- **WHEN** 宿主的 Markdown 组件不提供代码块渲染入口
- **THEN** 代码块保持宿主原样，`codeBlocks` 设置失效并提示一次

### Requirement: 上游字节稳定与最小接缝

`@xzzpig/pi-tidy` MUST 保持上游源码文件字节稳定，fork 逻辑 MUST 放在 fork-only 目录。上游文件中的接缝 MUST 控制在入口处的导入与调用两处，新增配置键 MUST 由 fork-only 模块承载。每条已接受的分歧 MUST 记录在该包 subtree 元数据的 `reapplyOnSync` 与 `knownDebt` 中。

#### Scenario: 同步上游后接缝可重建

- **WHEN** 执行一次上游 subtree 同步
- **THEN** 仅入口文件需要重新应用两处接缝，其余上游文件与上游字节一致

#### Scenario: 分歧可审计

- **WHEN** 运行仓库的 fork-divergence 审计
- **THEN** 该包报告未声明分歧为 0
