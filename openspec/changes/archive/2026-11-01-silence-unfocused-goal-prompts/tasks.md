# Tasks

## 1. 实施前基线

- [x] 1.1 读取当前注册 hook、上下文保留、设置菜单与相关测试，运行 fork inventory/audit 并记录当前相关测试基线；验证产物为本 change 的 `validation.md`，包含执行命令、退出码和 upstream/fork-only 分类，不沿用历史失败豁免，不改动用户 `.pi/pi-goal-x-settings.json`。

## 2. 停止两条未聚焦提醒路径

- [x] 2.1 在请求上下文和一次性 steering 生成入口停止未聚焦提醒，最小化清理专用状态/导入，保留 stale-checkpoint 分支、focus 写入和 UI 更新；新增 fork-only 注册 hook 测试覆盖 0/1/多个 open goal、首次载入、显式 unfocus、focus/unfocus 循环、重复请求和工具循环，验证没有新增提醒消息或额外模型回合，目标与 focus 不被擅自修改。
- [x] 2.2 添加会话恢复、reload、切换和旧历史 fixture 测试；验证全新 fixture 的实际请求无未聚焦提醒，历史 fixture 原有消息/摘要逐字节不变且不新增副本。仅更正既有 upstream 测试中被本 delta 明确替代的提示断言，验证其他有效断言仍保留。
- [x] 2.3 在 fork-only 使用说明中解释“未聚焦 = 不自动参与已有 goal”、两条路径静默和旧历史仍可重放的边界；核对说明与测试一致，不扩充 README 或批量改写历史规格。

## 3. 设置兼容与执行护栏

- [x] 3.1 将 `hideUnfocusedPrompt` 标为兼容旧键，从可编辑菜单及常规设置展示移除，保留既有解析、分层和持久化兼容；新增 fork-only 测试覆盖缺省/true/false、global/project 覆盖、保存其他项保留有效旧键以及菜单不再展示，验证所有值均不触发提醒且无需改写用户配置。
- [x] 3.2 新增或复用运行时回归测试覆盖 `hideUnfocusedBanner` 两值下的 UI、显式列表/focus 命令、无焦点时需要目标的工具拒绝、过期 checkpoint 拦截、聚焦目标正常上下文/压缩恢复、预算和完成 gate；验证安全边界并非依赖旧提示，同时不改变现有显式 focus 恢复策略。
- [x] 3.3 更新 fork-only 说明和 changelog 中旧设置废弃与升级边界；验证文档不再建议通过该键开启提醒，`hideUnfocusedBanner` 仍被描述为独立 UI 控制，无新增设置或运行时迁移提示。

## 4. 集成验收与差异维护

- [x] 4.1 执行实际 Pi SDK 请求组装/发送前捕获的集成测试，覆盖未聚焦连续请求、恢复、聚焦再取消聚焦及已存在历史提醒；验证两条新生成路径均静默、工具调用与结果配对合法、其他插件/用户内容不被过滤，记录测试命令与实际断言结果而不是只检查源码字符串。
- [x] 4.2 从仓库根在 direnv/Nix 环境执行 `pnpm --filter @xzzpig/pi-goal-x run typecheck`、相关 fork-only/既有测试和 `pnpm --filter @xzzpig/pi-goal-x run test:all`，检查受影响的上下文语义/快照 gate；在 `validation.md` 按本 delta 每个场景记录证据，任何新增失败必须修复或明确报告阻塞，不静默更新基线。
- [x] 4.3 按实际 upstream 接缝与行为决定维护 `subtrees/pi-goal-x.json` 的分歧记录，运行 `pnpm run audit:fork-divergence`、本 change 的 Prettier 检查、`git diff --check` 和 `openspec validate silence-unfocused-goal-prompts --strict`；验证没有未声明分歧、upstream 格式噪音或无关文件改动，用户配置与真实 goal 保持未触碰。

## Workflow follow-up

- 实现与验收完成后由用户决定是否进入归档、提交或发布；本任务表不授权这些操作，也不切换或管理当前未聚焦的持久 goal。
