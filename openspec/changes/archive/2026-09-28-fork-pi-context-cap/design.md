## Context

上游 `@lukeramsden/pi-context-cap`（MIT）是单文件扩展（`extensions/context-cap.ts`，约 250 行），核心链路：`turn_end`（带 toolResults 时）→ `ctx.getContextUsage()` 超过 `budget - reserve` → `ctx.compact()`（会 abort 当前运行）→ `onComplete` 里 `pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" })` 恢复任务。预算来源只有默认值与 CLI flag/命令；`model.contextWindow` 刻意不动（pi-ai 会把 `max_tokens` 钳制到 `contextWindow - 输入估算 - 安全余量`，调小窗口会导致输出预算被压扁、回复截断）——本 fork 保持"只读不写"，但会**读取**窗口来推导未显式配置时的默认预算并把触发点钳制在窗口内。

本仓库约束（见 `pi-plugin-maintainer` / `pi-upstream-subtree` skill）：上游衍生包用 `git subtree` 导入，目录 `packages/pi-*`、npm 名 `@xzzpig/pi-*`、元数据 `subtrees/<name>.json`；pi 核心导入放 `peerDependencies`。

pi 扩展读配置的正规姿势（docs/extensions.md）：项目级 `join(ctx.cwd, CONFIG_DIR_NAME, "<name>.json")`，配合 `ctx.isProjectTrusted()` 守卫；`CONFIG_DIR_NAME` 从 `@earendil-works/pi-coding-agent` 导入，不硬编码 `.pi`。模型匹配约定参照 `ctx.scopedModels`：minimatch 匹配 `provider/modelId` 或裸 `modelId`。

## Goals / Non-Goals

**Goals:**

- 通过 subtree 导入建立可同步的 fork，fork 改动集中、面小，未来 `git subtree pull` 冲突可控。
- 白名单 + 两级配置文件（全局/项目）+ 会话三态开关，语义清晰且与 pi 既有约定一致。
- 不改动上游核心压缩/恢复/防护逻辑的行为。

**Non-Goals:**

- 不实现"白名单条目级独立预算"（每个模型一套显式阈值配置）；白名单只决定是否生效，显式预算全会话一个。但未显式配置时，预算直接等于当前模型的配置 `contextWindow`（触发点 = `window - reserve`，即 pi 原生阈值提前到轮中执行），窗口未知时回退默认 200,000；触发点始终钳制在 `window - 4096` 内。
- 不改动 agent 核心循环（`shouldStopAfterTurn` 接线等核心侧修复等待上游 pi 演进）。
- 不发布、不 push（发布走 `pi-publish` skill，另行触发）。
- 不为 print/JSON 模式做特殊 UI 适配（沿用上游 `ctx.hasUI` 守卫）。

## Decisions

1. **导入方式：`git subtree add --squash` 而非手工复制**
   仓库规范要求上游衍生包保留 squash parent 与 `git-subtree-dir`/`git-subtree-split` trailers，否则未来无法安全 pull。手工复制被 skill 明确禁止。fork 改动（配置、白名单、开关）作为 subtree 之后的本地提交。

2. **配置文件：两级 JSON，项目覆盖全局，键级合并**
   - 全局：`<agentDir>/context-cap.json`；项目：`join(ctx.cwd, CONFIG_DIR_NAME, "context-cap.json")`。
   - 形状：`{ "models": string[], "budget"?: number, "reserve"?: number }`。
   - 键级合并（项目缺的键回落全局）而非整文件覆盖：用户通常只想在项目里微调预算。
   - 项目文件仅在其目录受信任时读取（`ctx.isProjectTrusted()`），防止恶意仓库通过 clone 注入配置。
   - 解析失败（JSON 坏、类型错）发 notify 警告并跳过该级配置，绝不抛错中断会话。
   - 备选：放进 pi `settings.json` 自定义键——但 pi 没有"扩展命名空间"约定，散键易冲突且无 schema 校验；独立 JSON 文件是 extensions.md 示范的姿势。

3. **白名单匹配：minimatch，`provider/modelId` 或裸 `modelId`**
   与 pi `scopedModels`/`enabledModels` 的匹配语义一致（minimatch 已是 pi 依赖，从 `@earendil-works/pi-coding-agent` 的依赖树可用；若类型不可达则作为该包的 `dependencies` 声明）。空/缺失 `models` = 全部生效。`ctx.model` 每次事件现场读取，模型切换即时生效，无需重载。

4. **会话开关：三态 override（default/on/off）**
   上游 `enabled` 布尔只覆盖"开/关"，与白名单叠加时语义含糊（off 之后 on 是否无视白名单？）。改为：`default`（跟随白名单）/ `on`（强制启用，无视白名单）/ `off`（强制禁用）。`session_start` 重置为 default，不落盘。`/context-cap on` = 强制开，`off` = 强制关，无参数 status 输出当前生效状态与原因。

5. **fork 改动的代码组织：新模块文件，最小侵入上游主文件**
   新增 `extensions/config.ts`（配置加载/合并/校验）与 `extensions/whitelist.ts`（匹配），`context-cap.ts` 主文件只加：配置读取调用、白名单判定点（`compactIfOverBudget` 入口 + status 命令）、override 状态。恢复 prompt、防重入、熔断逻辑不动。
   备选：全部塞进主文件——diff 最小但后续 upstream pull 冲突面反而更大；独立文件几乎不会与上游改动相交。

6. **配置校验失败 → 禁用而非降级**
   `reserve >= budget` 视为配置矛盾（守护必然乱触发或永不触发），停用并明确告知，避免"看似在守护实则失效"的静默错误。

7. **预算默认值按模型窗口推导，触发点钳制在窗口内**
   显式预算（flag/配置文件 `budget`/`/context-cap <tokens>`）仍然优先；未显式配置时，有效预算 = 当前模型配置的 `model.contextWindow`（窗口未知时回退 200,000 默认值）——守护等价于把 pi 原生压缩阈值（`contextWindow - reserveTokens`）提前到轮中执行。触发点 = `min(budget - reserve, model.contextWindow - 4096)`，因此任何显式预算都不会让守护在模型真实窗口之外触发（模型窗口 ≤ 4096 时无法容纳安全余量，直接禁用该模型守护并告知）。`model.contextWindow` 只读不写，每次事件按当前模型现算，模型切换即时生效。安全余量 4096 与 pi-ai `CONTEXT_SAFETY_TOKENS` 一致，保证触发点不会压扁输出预算。

## Risks / Trade-offs

- [上游更新与本地 fork 改动冲突] → fork 改动隔离在独立文件与主文件少量插入点；`git subtree pull` 冲突时按 skill 的 conflict 流程处理（保留 `@xzzpig` 名与包契约）。
- [`ctx.compact()` abort 当前轮，正在进行的工具调用被打断] → 上游既有行为：压缩后 followUp 恢复任务；本变更不改。跨过阈值的那一次请求仍会发出（约一次请求的超调），是扩展层方案的上限，核心侧修复依赖 pi 的 `shouldStopAfterTurn` 演进。
- [全局配置目录路径获取] → pi 无公开 `getAgentDir` 给扩展时，退化为只支持项目级 + CLI flag（spec 的全局级场景标记为需在实现时验证；若不可达则更新 spec 为单级配置）。实现任务里包含对此的验证步骤。
- [白名单误配置导致守护不生效] → status 命令始终显示"当前生效状态 + 原因（白名单/override/熔断）"，用户可自查；invalid 模式串（glob 语法错误）按不匹配处理并警告。

## Migration Plan

1. `git subtree add --prefix="packages/pi-context-cap" --squash` 导入 + 写 `subtrees/pi-context-cap.json` + 添加 `upstream-pi-context-cap` remote + `direnv reload` 验证。
2. 改名 `@xzzpig/pi-context-cap`（manifest/README/代码引用一次完成）。
3. 叠加 fork 功能（config/whitelist/session-toggle），`pnpm --filter @xzzpig/pi-context-cap run typecheck`、`pnpm exec prettier --check .`、`pi -e ./packages/pi-context-cap/extensions/index.ts` 冒烟。
4. `versions.json` 加条目，README 包列表更新。
5. 回滚：`git revert` subtree 导入与后续提交即可，无外部状态。

## Open Questions

（无——设计决策已覆盖提案的全部行为要求。）
