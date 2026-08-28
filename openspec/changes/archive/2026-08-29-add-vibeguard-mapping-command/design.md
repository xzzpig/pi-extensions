# Design: add-vibeguard-mapping-command

## Context

上游 `@aizigao/pi-vibeguard`（单文件 `index.ts`，约 700 行，无构建步骤、无运行时依赖）已在探索阶段完成调研：

- 映射数据完整存在于 `PlaceholderSession` 的三张内存表：`forward`（placeholder→原文）、`reverse`（原文→placeholder）、`created`（placeholder→创建时间戳，TTL 驱逐依据）；category 未单独存储，但已内嵌于 placeholder 字符串 `__VG_<CATEGORY>_<hash12>[_<N>]__`。
- `getOrCreatePlaceholder` 先查 `reverse` 复用既有 placeholder，因此同一原文在会话内 placeholder 恒定，"创建时的 category"即为该 placeholder 内嵌的 category——这与用户确认的"展示创建时 category"语义一致。
- `pi` 宿主提供 `pi.registerCommand`（含 `getArgumentCompletions`）与 `ctx.ui.custom` 自定义 TUI 组件；本仓库 `pi-tool-display`（`src/config-modal.ts` 的 `ctx.ui.custom<void>` 用法）与 `pi-btw`（`btw:*` 冒号命令族）是现成先例。
- 本仓库 fork 上游插件的完整工作流由 `pi-upstream-subtree` skill 定义：subtree 导入 → `subtrees/<name>.json` 元数据 → npm 更名 `@xzzpig/<name>` → direnv 校验。`pi-subagents` 是同一模式的既有案例。

## Goals / Non-Goals

**Goals:**

- 在 fork 后的 `packages/pi-vibeguard` 上叠加 `/vibeguard:list` 与 `/vibeguard:stats` 两个命令，逐条展示存活映射（category、placeholder、打码原文、剩余 TTL）与分类汇总。
- 将上游同步的冲突面压到最小（改动集中、附加式）。
- 保证命令输出绝不进入 LLM 上下文。

**Non-Goals:**

- 不做事件日志/审计落盘（用户已明确选择"只列当前存活映射"）。
- 不修改 redact/restore 引擎、`PlaceholderSession` 数据结构、配置加载逻辑。
- 不做映射的手动管理（删除/固定条目）、不做来源消息追溯、不修复状态栏 `VibeGuard[N]` 计数语义。

## Decisions

### D1. 数据源：只读遍历现有内存表，零结构改动

遍历 `session.forward` + `session.created` 构造列表视图；category 从 placeholder 剥壳解析，不新增任何记录点。

- **备选（否决）**：在 `context` 事件积累匹配事件（`redactText` 返回的 `matches` 被丢弃）——能拿到真实触发 category/次数/来源，但改动深入引擎路径，且用户选择了最小方案；落盘方案更因明文写磁盘改变威胁模型被直接排除。
- **注意**：解析必须基于 `session.prefix` 动态构造（用户配置可改 `placeholder_prefix`），不得硬编码 `__VG_`；须容忍 `_<N>` 碰撞后缀；剥壳失败降级为 `UNKNOWN` 并保留条目（spec 已约定）。

### D2. UI 载体：`ctx.ui.custom` 自定义 TUI 组件

`/vibeguard:list` 渲染为全屏可滚动的自定义组件（参考 `pi-tool-display` 的 config-modal 模式）；`/vibeguard:stats` 数据量小，用同一组件的简化形态或 `ctx.ui.notify` 渲染（实现时按行数自动选择，行为以 spec 为准）。

- **备选（否决）**：`ctx.ui.notify`（几百条映射装不下）；临时文件 + 编辑器（明文落盘、无交互）。
- **依赖**：`peerDependencies` 新增 `@earendil-works/pi-tui`，版本范围对齐 `pi-tool-display` 的写法（`^0.74.0 || … || ^0.83.0`）；`devDependencies` 加 `catalog:` 引用。

### D3. 打码策略：默认"前 3 + … + 后 4"，`r` 键切换

长度 >7 时保留前 3 与后 4 字符、中间以 `…` 代替；≤7 时整体显示 `•`（不泄露长度结构）。`r` 为组件内全局切换开关，切换时保持滚动位置与条目顺序。

- **备选（否决）**：直接明文（截屏/旁观风险高）；永远打码（失去"确认到底是哪个值"的核心调试价值）。

### D4. 命令形态：冒号命名空间

注册 `/vibeguard:list`、`/vibeguard:stats`，与 `pi-btw` 的 `btw:*` 族一致，命令面板直接可见。后续若加 `enable/disable/reload` 沿用同一命名空间。

### D5. 代码组织：附加在 `index.ts` 内部，不拆新文件

命令注册与 TUI 组件以内联方式附加在上游单文件 `index.ts` 中（新 import 集中在文件头部；新函数集中追加在 Entry 区之前；注册代码放在 `export default` 内既有事件注册之后）。

- **理由**：上游 `files: ["index.ts"]`、`pi.extensions: ["./index.ts"]` 均为单文件，拆文件必须动 manifest，扩大未来 `git subtree pull` 的冲突面；内联附加把本地分歧收敛为"头部 import 块 + 尾部功能块"两处，`subtrees/pi-vibeguard.json` 的 `notes` 记录该分歧。
- **代价**：单文件体积增长（预计 +200~300 行），可接受。

### D6. 上下文隔离：纯 TUI 渲染，零消息写入

命令处理器只调用 `ctx.ui.custom`/`ctx.ui.notify`，不调用 `pi.sendUserMessage` 等任何写入会话的 API，不返回消息。纵深防御：即使未来意外进入消息流，插件自身 `context` hook 会对原文再脱敏——但不作为设计依赖。

## Risks / Trade-offs

- **[双实例加载]** 若全局 `@aizigao/pi-vibeguard` 未卸载，fork 与其同时注册（命令出现 `:1`/`:2` 后缀即症状），且两者 secret 独立、互相无法还原对方的 placeholder，工具会拿到占位符执行 → 迁移步骤显式卸载并作为验收项检查（`pi` 扩展列表无 `@aizigao/pi-vibeguard`、命令无数字后缀）。
- **[TTL 语义混淆]** 列表只反映"此刻存活"，用户可能误以为历史脱敏从未发生 → 界面标注"仅当前会话存活映射"，剩余 TTL 以分钟粒度展示，过期条目即时消失。
- **[自定义 prefix]** 用户改过 `placeholder_prefix` 后硬编码解析会全部降级 `UNKNOWN` → 解析正则由 `session.prefix` 动态转义构造（沿用上游 `getPlaceholderRegex` 的转义逻辑）。
- **[pi-tui 版本兼容]** `ctx.ui.custom` 与 TUI 组件 API 随宿主版本演化 → peer 范围照抄 `pi-tool-display`（已覆盖 0.74–0.83），宿主过旧时命令报错但不影响脱敏主功能。
- **[明文观看的旁视风险]** 明文模式一屏可达数十条秘密 → 默认打码 + 明文状态下的显著提示条（如标题栏变色标注"明文"），`q`/Esc 退出后状态不复位也仅在下次显式打开时生效。

## Migration Plan

1. 按 `pi-upstream-subtree` skill 导入：建 `upstream-pi-vibeguard` remote → `git subtree add --prefix=packages/pi-vibeguard --squash upstream-pi-vibeguard 672121246907a60e646bb3d2e8a1940371f4c904` → 写 `subtrees/pi-vibeguard.json`（保持未提交直至 post-import 完成并验证）。
2. Post-import 适配：npm 更名 `@xzzpig/pi-vibeguard` → `pnpm install` → typecheck/测试/prettier（注意 monorepo 校验命令）。
3. 叠加命令功能（本变更主体）→ 全量验证。
4. 环境切换：`pi remove npm:@aizigao/pi-vibeguard`（全局）→ 安装本 fork → 重启 pi 验证命令无 `:N` 后缀、脱敏与还原功能正常。
5. 回滚：fork 未发布前直接 `pi install npm:@aizigao/pi-vibeguard` 即恢复原状；monorepo 侧 revert 对应提交。

## Open Questions

（无——全部设计决策已在探索阶段与用户确认。）
