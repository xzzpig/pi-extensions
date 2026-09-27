## 1. 状态机与门控基础

- [ ] 1.1 将 `packages/pi-notify/extensions/state.ts` 收敛为单一 span 类等待项：移除 `startAsk`/`startPermission`/`completeAsk`/`resolvePermission`，新增 `startUiPrompt(spanId, label)` / `completeUiPrompt(spanId)`，保持 `herdr:blocked` event 名与 payload 不变；重写 `test/index.test.ts` 中状态机用例（多 span 并存、逐一关闭才解除、shutdown 清空），运行 `pnpm --filter pi-notify test` 验证
- [ ] 1.2 在 `packages/pi-notify/extensions/agent-events.ts` 的 AgentRunTracker 增加只读 `isActive()`（`agent_start` 置位、`settled`/`shutdown` 复位），并为其补充单元用例，运行 `pnpm --filter pi-notify test` 验证

## 2. 通用适配器与分类上下文

- [ ] 2.1 新建 `packages/pi-notify/extensions/ui-prompts.ts`：`UI_PROMPT_START_EVENT`/`UI_PROMPT_END_EVENT` 常量、核心事件 payload 解析（kind/title 防御性读取与净化）、span 序号生成器、活动 ask flow 上下文（flowId → 净化标题）与待确认 permission 上下文（requestId → 转发来源），并为解析与上下文维护写单元测试，运行 `pnpm --filter pi-notify test` 验证
- [ ] 2.2 改造 `extensions/index.ts`：移除 pi-ask `started/completed` 与 permission `ui_prompt`/decision 系事件的通知路由与 herdr 记账（`route()`/`state.startAsk`/`startPermission` 调用），改为仅维护分类上下文（ask completed、permission decision/forwarded_decision 清理）；注册 `pi.on("ui_prompt_start"/"ui_prompt_end")`——仅在 agent 活跃时生成 spanId，按"待确认 permission → 活动 ask flow → 默认"归类为 `permission-required`/`input-required` 并提供 herdr 标签；`ui_prompt_end` 配对 `completeUiPrompt`；handler 全程容错；同步收敛 `permissions.ts` tracker 与移除 `interaction-events.ts` 的 ask/permission 路由去重，运行 `pnpm --filter pi-notify test` 验证
- [ ] 2.3 `packages/pi-notify/package.json` 的 `peerDependencies["@earendil-works/pi-coding-agent"]` 从 `*` 改为 `>=0.84.4`，运行 `pnpm install --frozen-lockfile` 前先 `pnpm install` 更新 lockfile 并确认安装无 peer 冲突

## 3. 集成用例

- [ ] 3.1 在 `test/index.test.ts` 运行时中分发 `ui_prompt_start`/`ui_prompt_end` 模拟事件，覆盖：agent 活跃无上下文 span 产生一个 input-required 且 herdr blocked、agent 空闲静默、嵌套合并只通知一次、end 清理解除 blocked，运行 `pnpm --filter pi-notify test` 验证
- [ ] 3.2 覆盖分类与单通知源：permission `ui_prompt` → span 仅产生一个 permission-required（转发场景 herdr 标签含请求方代理名）；pi-ask started → span 仅产生一个 input-required 且 herdr 标签为净化标题、通知正文不含标题；带标签事件无对应对话框时（headless 流程）不产生通知与 herdr；decision/completed 正确清理分类上下文，运行 `pnpm --filter pi-notify test` 验证

## 4. 文档与验证

- [ ] 4.1 更新 `packages/pi-notify/README.md`：适配器模型改为"通用 UI 等待 + 分类上下文"，注明行为收窄（pi ≥ 0.84.4、headless ask 流程不通知）、pi-goal-x 问卷/提案与 pi-sandbox 权限确认由此覆盖，核对与 spec 场景一致
- [ ] 4.2 运行 `pnpm --filter pi-notify run typecheck && pnpm --filter pi-notify test && pnpm exec prettier --check packages/pi-notify openspec/changes/add-generic-ui-prompt-notifications` 全绿；`openspec validate add-generic-ui-prompt-notifications --strict` 通过；确认 `git status` 未触碰 `packages/pi-goal-x/`、`packages/pi-sandbox/`

## 5. 真机 e2e（pi-plugin-e2e-test skill）

- [x] 5.1 按隔离契约在临时目录用 tmux 启动真实 pi TUI，加载本地 pi-notify（必要时带 probe/companion 扩展）：验证启动行 Extensions 列表含 pi-notify、agent 等待期对话框触发通知与 herdr:blocked（探针/会话记录为证）、agent 空闲对话框静默；收集 pane 捕获、会话记录与精确启动命令，失败如实报告
- [x] 5.2 e2e 结束后清理 tmux session，保留临时目录证据供报告引用
