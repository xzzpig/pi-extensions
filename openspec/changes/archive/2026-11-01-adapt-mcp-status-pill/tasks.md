# 实施任务

## 1. 默认 MCP 命令桥与生命周期

- [x] 1.1 新增 fork 专属 `extensions/starline/fork-mcp-pill.ts`，在交互会话启动后检查扩展来源的 `mcp-adapter` 并注册默认 `mcp` action；通过 `test/fork-mcp-pill.test.ts` 验证命令存在、缺失、同名模板/技能、查询抛错与非 TUI 模式。
- [x] 1.2 实现点击与 `/starline mcp` 共用的安全路由：发送前重新检查命令，仅同步调用 `sendUserMessage("/mcp-adapter", { expandPromptTemplates: true })`；单测断言参数完全一致、不可用时零发送、不调用 `/mcp`，不导入 adapter 或读写其配置。
- [x] 1.3 接入 Starline 入口最小安装接缝，实现启动前旧注册清理、结束失效、冷却重置及所有权保护；单测验证已有 action 不覆盖、后续替换不被旧 disposer 删除、旧回调在会话结束后无效、新会话不复用旧上下文。
- [x] 1.4 在 fork 专属文档说明 compact 配置为用户已完成的前提、点击打开原面板及 `/starline mcp` 入口；核对文档不要求额外桥接插件、不声称会自动修改 adapter 配置。

## 2. 输入去重、浮层协调与显示回归

- [x] 2.1 为默认动作增加基于单调时钟的 300 毫秒共用冷却，复用原 footer 的 press/click 去重；用可控时钟及真实 footer 事件测试验证一次手势只发一次、快速鼠标/键盘重复被合并、300 毫秒后可重试且没有永久锁。
- [x] 2.2 打开原面板前**先**关闭 Starline 气泡、**之后**再通过现有共享 API 可选检查实时 `hasOverlay()`；单测验证 close→probe→send 顺序、关闭后仍可见浮层时零发送、外部浮层存在时零发送、能力缺失或抛错时按设计降级而不报错。
- [x] 2.3 在 fork 专属测试中覆盖通用状态渲染回归：`MCP 0/1` 的默认全文显示、特殊提示保留、隐藏/清空、显式布局与通配不重复、其他 pill 动作和配色几何不变；运行相关测试确认全部通过。
- [x] 2.4 补充 fork 文档中的面板关闭归属、300 毫秒有界去重及可选浮层探测限制；核对没有把返回 `void` 的发送接口描述为可等待面板完成的 Promise，也不承诺任意慢初始化的全生命期单飞。

## 3. fork 维护与整体验证

- [x] 3.1 运行 fork inventory 检查实际修改范围，为上游入口接缝更新 `subtrees/pi-starline.json` 的必要维护记录，纯 fork 自有文件不虚构债务；执行 `pnpm run audit:fork-divergence` 并保留非零 checked、undeclared=0 的通过摘要。
- [x] 3.2 在仓库 direnv/Nix 环境运行 `pnpm --filter @xzzpig/pi-starline run typecheck`、`pnpm --filter @xzzpig/pi-starline test` 与 `pnpm exec prettier --check .`；记录退出码，区分并说明任何既有无关失败，不格式化上游源码。
- [x] 3.3 按 `pi-plugin-e2e-test` 与 `pi-tmux-tmp-server` 技能在隔离真实 Pi TUI 中加载本地 Starline、共享鼠标层和 adapter，以 compact 设置验证显示、点击、气泡切换、**可观测的重复触发不重复打开**、**外部浮层存在时不叠加**、关闭后重开、`/starline mcp`、保存/reload 后重开；交付 asciinema 录制和对应步骤证据，不修改用户真实 MCP 配置。
- [x] 3.4 在真实运行中验证模型流式输出期间打开面板无新增模型请求、无 steering/follow-up 入队且不终止现有工作；另验证无 adapter 时正常加载，并记录实际 Pi/adapter 版本、命令分发与可选浮层能力的支持情况。
- [x] 3.5 执行 `openspec validate adapt-mcp-status-pill --strict`，对照本 change 的每条新增场景整理测试或实测证据，确认仅预期代码、维护元数据与 fork 文档发生变更，且未触碰用户无关修改。

## 后续流程

- 实施完成并经用户确认后，再使用归档流程合入主规范；本次提案不归档、不实施。
- 提交、版本更新、发布和替换用户安装均需另行授权，不属于上述任务。
