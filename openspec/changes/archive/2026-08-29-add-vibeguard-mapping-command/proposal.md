# Proposal: add-vibeguard-mapping-command

## Why

`@aizigao/pi-vibeguard` 目前只暴露总体情况（启动时"Active (N keywords + M regex)"通知和每轮"VibeGuard[N]"状态计数），用户无法看到每条被保护内容（原文）与其 placeholder、触发 category 的对应关系，出了问题无从排查。这已造成真实事故：全局 `vibeguard.config.json` 的 exclude 列表中被粘入了 placeholder 文本（`123e4567-e89b-12d3-a456-426614174000`），污染配置却难以发现。同时该插件以 npm 包形式全局安装，直接改本地副本会与 npm 版形成双实例（各自持有不同 session secret、映射互不还原），因此需先将上游 vendor 进本 monorepo 以 subtree 管理，再在其上叠加功能。

## What Changes

- **导入上游 subtree**：以 `git subtree` 导入 `aizigao/pi-vibeguard`（当前 HEAD `672121246907a60e646bb3d2e8a1940371f4c904`，即 0.1.2）到 `packages/pi-vibeguard`，按 `pi-upstream-subtree` skill 建立 `subtrees/pi-vibeguard.json` 元数据记录，npm 名更改为 `@xzzpig/pi-vibeguard`。
- **替换全局安装**：从 `~/.pi/agent` 卸载 `@aizigao/pi-vibeguard`，改为安装本仓库 fork，避免双实例 secret 不互通。
- **新增 `/vibeguard:list` 命令**：`ctx.ui.custom` 自定义 TUI 组件，表格逐条展示当前存活映射——CATEGORY、PLACEHOLDER、ORIGINAL（默认打码为"前 3 + … + 后 4"样式，按 `r` 键切换明文）、TTL 剩余时间；支持滚动。
- **新增 `/vibeguard:stats` 命令**：按 category 汇总存活映射计数，条形图展示。
- **零侵入数据源**：遍历现有 `PlaceholderSession` 内存表（`forward`/`created`），category 从 placeholder 字符串（`__VG_<CATEGORY>_<hash12>__`）剥壳解析；不修改 `PlaceholderSession` 及 redact/restore 引擎的任何行为。

## Capabilities

### New Capabilities

- `vibeguard-mapping-view`: vibeguard 映射查看命令的可观察行为——`/vibeguard:list` 与 `/vibeguard:stats` 的数据来源（仅当前会话存活映射）、category 解析规则、原文默认打码与按键显示、TTL 剩余时间展示、空态/未启用态的提示行为，以及命令输出不进入 LLM context 的保证。

### Modified Capabilities

（无——`openspec/specs/` 当前为空，本变更全部为新能力。）

## Impact

- **代码**：
  - `packages/pi-vibeguard/index.ts`（在上游闭包内新增 `pi.registerCommand` 注册与 TUI 渲染逻辑；`PlaceholderSession` 不动）
  - `packages/pi-vibeguard/package.json`（npm 更名 `@xzzpig/pi-vibeguard`；新增 `peerDependencies`：`@earendil-works/pi-tui`）
  - `subtrees/pi-vibeguard.json`（新增元数据记录：source、ref、upstreamCommit、squash、notes 记录本地分歧）
- **环境**：`~/.pi/agent` 中的 `@aizigao/pi-vibeguard` 需卸载并替换为本 fork（否则双扩展同时加载、secret 独立、互相还原失败导致工具拿到占位符执行）。
- **上游关系**：本地功能差异（命令部分）集中附加在 `index.ts` 尾部以缩小未来 `git subtree pull` 的冲突面，分歧记录在元数据 `notes`。
- **安全面**：命令输出仅渲染到本地 TUI，不进入消息流；即使意外进入对话，插件自身的 `context` hook 也会对原文再脱敏（不作为设计依赖，仅作纵深防御）。
