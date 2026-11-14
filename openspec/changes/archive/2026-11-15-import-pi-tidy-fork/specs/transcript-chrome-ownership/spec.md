# Spec Delta

## Purpose

定义本仓库转录装饰面的单一所有权与共存契约：每个渲染面只有一个插件生效，多个插件补丁同一组件时按链式组合而非互相覆盖。

## ADDED Requirements

### Requirement: 每个转录渲染面只有一个生效者

系统 SHALL 为每个转录渲染面指定唯一负责的插件：工具框归 `pi-tool-display`，用户消息与干净复制归 `pi-tidy`，组级折叠归 `pi-group-collapse`，pill 与状态栏归 `pi-starline`，最终回复框、代码块分节与错误行去重归 `pi-tidy`。前置配置就位后，同一渲染面 MUST NOT 被两个插件同时绘制，MUST NOT 出现嵌套边框或重复装饰。

#### Scenario: 工具框只有一层边框

- **WHEN** `pi-tool-display` 与 `pi-tidy` 同时安装，且 `pi-tidy` 的 `frameTools` 为 `false`
- **THEN** 每个工具框只出现一层边框，且该边框来自 `pi-tool-display`

#### Scenario: 用户消息只有一个渲染者

- **WHEN** `pi-starline`、`pi-tool-display` 与 `pi-tidy` 同时安装，且 `pi-tool-display` 的 `enableNativeUserMessageBox` 已设为 `false`
- **THEN** 用户消息由 `pi-tidy` 按 `tidy.userMessageStyle` 绘制，`pi-starline` 不绘制用户消息

### Requirement: 同一组件的多个补丁按链式组合

当多个插件 patch 同一个组件方法时，系统 MUST 以链式方式组合：后安装的补丁 MUST 调用它替换掉的前一个实现，MUST NOT 丢弃其返回值，MUST NOT 假设自己是唯一补丁。某个补丁被卸载后，剩余补丁 MUST 继续按原语义工作。

#### Scenario: 助手消息同时被两个插件 patch

- **WHEN** `pi-group-collapse` 为隐藏思考 patch `AssistantMessageComponent.prototype.render`，`pi-tidy` 为最终回复框 patch 同一方法
- **THEN** 最终回复框包裹的是思考已按组策略处理后的内容，两者同时生效

#### Scenario: 某个插件卸载后其余补丁仍生效

- **WHEN** 其中一个插件被卸载，或 `/reload` 后不再安装补丁
- **THEN** 另一个插件的补丁继续生效，且不因缺少下游实现而抛错

### Requirement: Starline 不再拥有用户消息与干净复制

`@xzzpig/pi-starline` MUST NOT patch `UserMessageComponent`，MUST NOT 实现选区清洗，MUST NOT 保留 `colors.userMessageBorder`、`colors.userMessageText`、`colorSources.userMessages`、`userMessagePaddingY`、`mouse.transcriptCleanCopy` 的生效语义。检测到这些键时 MUST 按进程给出一次性提示，说明已由 `pi-tidy` 接管。

#### Scenario: 旧配置键给出一次性提示

- **WHEN** 配置文件中仍含 `colorSources.userMessages`
- **THEN** 进程内首次加载配置时提示一次该键已迁移，之后不再重复提示

#### Scenario: 旧键不再影响渲染

- **WHEN** 配置中把 `colors.userMessageText` 设为某个颜色
- **THEN** 用户消息文字颜色不随该键变化，改由 `tidy.userMessageColors` 决定

### Requirement: 不改其他插件的默认配置

系统 MUST NOT 修改 `pi-tool-display` 的 `enableNativeUserMessageBox` 默认值或源码，MUST NOT 为达成渲染面独占而改变其他上游包的默认体验。文档 MUST 给出所需的前置配置；未设置该键时两个插件同时绘制用户消息属于配置未完成，不是缺陷。

#### Scenario: pi-tool-display 的默认值保持上游值

- **WHEN** 对比本仓库的 `pi-tool-display` 与其上游同一版本
- **THEN** `enableNativeUserMessageBox` 的默认值相同，该包无因本次变更产生的分歧

#### Scenario: 文档给出前置配置

- **WHEN** 用户阅读 `pi-tidy` 或 `pi-starline` 的文档
- **THEN** 文档明确说明需把 `enableNativeUserMessageBox` 设为 `false`，才能让 `pi-tidy` 独占用户消息面

### Requirement: 工具框与组级折叠的所有权不变

本次变更 MUST NOT 改变 `pi-tool-display` 对工具框、diff、输出预算与自定义工具覆盖的所有权，MUST NOT 改变 `pi-group-collapse` 对组级折叠、成员规则与展开还原的所有权。`pi-tidy` 在这些渲染面上 MUST 保持关闭。

#### Scenario: 组级折叠仍按 pi-group-collapse 规则执行

- **WHEN** 用户配置 `group-collapse.json` 将某个工具设为 `keep`
- **THEN** 该工具保持可见并分隔组，行为与本次变更前一致

#### Scenario: 工具输出预算仍由 pi-tool-display 决定

- **WHEN** 用户设置 `pi-tool-display` 的 `bashOutputMode`
- **THEN** bash 输出按该设置显示，`pi-tidy` 不参与决定
