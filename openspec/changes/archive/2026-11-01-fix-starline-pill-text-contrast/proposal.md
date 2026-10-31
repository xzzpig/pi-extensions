# Proposal

## Why

pill 的正文颜色由 `contrastTextSgr()` 自动挑选，而它只输出 ANSI 基础色 `30`（黑）或 `97`（亮白）。这两个码的实际颜色由终端主题决定，不由 Starline 决定：herdr 当前主题把 ANSI black 映射为 `#616161`，于是中灰背景（`muted` 提升成的 `#828997`）上的文字只有 **1.76:1** 对比度，浅蓝 `#61AFEE` 上 2.62:1，绿 `#98C379` 上 3.07:1，远低于 WCAG 正文 4.5:1。表现就是状态栏整行发灰：第三方状态（`goal:` / `MCP:` / `Sandbox:`）、model、context、cost 都难读。

这不是用户配置错误，也无法靠配置彻底绕开：`fg:` 手写覆盖只能逐个段硬编码十六进制色，既失去主题自适应，又漏掉任何新出现的 pill。修在渲染层的对比色选择上，一次覆盖全部 pill 和气泡。

## What Changes

- pill 的深/浅文字改用 256 色立方中**由标准固定**的 `16`（黑）/ `231`（白），不再使用由终端 16 色主题映射的 `30`/`97`；同一组背景下对比度提升到 5.4–9.4:1。
- 深/浅判定逻辑不变：仍按背景 SGR 反解出的 RGB 亮度阈值选择，背景无法反解时的既有回退行为不变。
- 覆盖范围：pill 正文、相邻同背景 pill 之间以文字色绘制的细分隔符、以及复用同一函数的 pill 气泡正文。
- 不改变 pill 背景色解析、`colorSources` 主题/终端来源、`extensionStatuses` 默认色与逐项颜色、图标、分隔符几何、截断、点击热区和 pill API 契约。

## Capabilities

### New Capabilities

- `pill-rendering`: Starline pill 状态栏的文字可读性契约——自动对比色必须在任意终端调色板下成立，且不依赖终端对 ANSI 基础色的自定义映射。

### Modified Capabilities

无。既有 `mouse-api`、`transcript-group-folding` 等能力域与 pill 文字配色无关。

## Impact

- `packages/pi-starline/extensions/starline/pill.ts`：`TEXT_DARK` / `TEXT_LIGHT` 两个常量及其注释（upstream 文件内的最小改动，需在 `subtrees/pi-starline.json` 的 `reapplyOnSync` 记录）。
- `packages/pi-starline/test/pill.test.ts`：`contrastTextSgr` 与分隔符相关断言随之更新；新增 fork-only 测试覆盖“终端调色板把 ANSI black 映射成中灰时仍可读”。
- `packages/pi-starline/extensions/starline/pill-bubble.ts` 复用同一函数，无需改动即可获得同样修复。
- `packages/pi-starline/FORK-CHANGELOG.md` 记录该分歧。
- 无新增依赖、无 pill API 变更、无配置格式变更；用户现有 `~/.pi/agent/starline.json` 无需修改。
