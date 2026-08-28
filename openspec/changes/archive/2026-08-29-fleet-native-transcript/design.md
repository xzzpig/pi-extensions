# Design: fleet-native-transcript

## Context

三条渲染链路的现状（动机见 proposal.md）：

- **pi-subagents fleet inspector**：`src/tui/fleet.ts` 的 `wrappedDetail()` 在 transcript 可解析时调用 `renderFleetTranscript()`（`src/tui/fleet-transcript.ts`），手写 rail 线渲染；数据来自 `readFleetTranscript()` 解析子代理 JSONL。已有按文件 fingerprint(size+mtime)+width+expandedTools 的 `transcriptCache`，刷新周期 750ms。
- **pi-components**：`renderTranscriptLines(entries, options)` 是纯数据驱动渲染——不要求事件来自实时流，手工构造的 entries 即可渲染。原生工具组件经 `createAllToolDefinitions(cwd)[toolName]` 自动解析内置工具（已核实 dist 源码），传 cwd 即可获得 bash/read/edit 富渲染。
- **pi-btw**：`extensions/btw.ts` 已是"手工构造 entries + `TranscriptToolComponents` 注册表 + 自定义 overlay 内调 `renderTranscriptLines`"的完整范本，但手写了约 200 行与 pi-components 内部几乎逐行重复的状态机代码（append/ensureTurn/finishTurn/removeTurn/findLatest/upsert 系列）。

关键约束：

- pi-subagents 与 pi-btw 均为 upstream git subtree，本地改动会加深 divergence（现有 subtrees 记录中已有 notes 记录本地分歧的先例）。
- pi-components peerDeps 要求 `@earendil-works/* >=0.83 <1`，而 pi-subagents 对 Pi 的 peer 是 `*`/`>=0.80`——宿主版本低于 0.83 时新链路不可用。
- 子代理 JSONL 中 `argsPayload` 为完整 args 的 JSON 字符串，上限 32KB，超限带 `… payload truncated` 标记且 JSON 不完整。

## Goals / Non-Goals

**Goals:**

- fleet inspector 结构化视图切换为原生组件渲染，消息与主界面视觉一致，工具获得 diff/预览等富输出。
- pi-components 新增公开的 entries 构造/状态操作 API（历史回放场景），供两个消费方共享。
- pi-btw 删除重复状态机代码，改用共享 API，对外行为零变化。
- 全程保留降级路径：组件库缺失或旧宿主下回到现有文本渲染器。

**Non-Goals:**

- 不改常驻 FleetView 状态条、文本版 `status view=fleet`、Herdr 窗格、Prompt Audit 等其他展示通道。
- 不改子代理 JSONL 写入格式（child-transcript version 1 保持不变）。
- 不引入实时流式渲染（fleet 场景始终是对持久化文件的尾部快照）。
- 不向上游推送任何变更（subtree 同步策略维持现状）。

## Decisions

### D1: 数据适配层放在 pi-subagents 侧，pi-components 只提供通用构造 API

JSONL→entries 的解析器是 pi-subagents 私有文件格式的知识，放 `src/tui/fleet-native-transcript.ts`（新文件）；pi-components 仅将已有的私有状态操作提升为公开 API。

- _备选_：把 JSONL 解析也做进 pi-components → 否决：文件格式属于 pi-subagents 领域，进公共库会形成反向耦合。

### D2: 公开 API 形态——导出模块级函数而非新建 Builder 类

将 pi-components 现有私有函数（ensureTurn / finishTurn / removeTurn / findLatestEntry / upsertText / upsertToolResult / appendNotice 及条目追加）以模块级函数形式导出，签名与现内部实现保持一致。pi-btw 的同名手写函数直接删除并改为调用这些导出。

- _备选_：包装成 `TranscriptBuilder` 门面类 → 否决：多一层抽象，pi-btw 迁移面更大；模块级函数与 `SessionTranscript` 类并存即可覆盖两类场景。
- _兼容性_：纯新增导出，既有导出不动；pi-components 语义化版本 minor 升级（0.2.x → 0.3.0）。

### D3: 工具组件注册表按缓存世代重建，全局展开切换走重建

fleet 的 `transcriptCache` 键扩展为包含 expandedTools（现已如此）；缓存未命中时重新构造 entries + `TranscriptToolComponents`（构造参数携带 `expanded`、`cwd`）。`x` 切换 = 使缓存失效 → 下帧重建。不做 per-component 增量 setExpanded。

- _备选_：持有注册表并对全体组件调 setExpanded → 否决：需要额外的注册表生命周期管理，收益仅是省一次重解析，而解析本身已被 fingerprint 缓存挡住。
- _备选_：不传 toolComponents 让每帧 ad-hoc 重建 → 否决：750ms 刷新周期下浪费且丢失组件内部折叠状态一致性。

### D4: 截断 argsPayload 的降级策略——空参数 + 完整结果

`JSON.parse(argsPayload)` 失败（32KB 截断）时，tool-call 条目以 `{}` 参数写入，结果照常写入。原生组件对未知工具/空参数有 generic fallback 渲染，保证条目可见。

- _备选_：截断时退回 rail 线渲染该单条 → 否决：同一屏混两种渲染范式反而更乱。

### D5: 宿主能力探测与降级

pi-subagents 侧对 `@xzzpig/pi-components/transcript` 的动态 import 包 try/catch，并校验所需导出存在；失败或缺失时走现有 `readFleetTranscript + renderFleetTranscript` 路径。同时满足 peer 版本错配（Pi <0.83）与组件包未安装两种情形。结构化 header（conversation state 行等）在两条路径下均保留。

### D6: 安全读取逻辑原地复用

trusted-root 包含校验、symlink 拒绝、realpath 二次校验全部留在 pi-subagents 现有读取函数中，新链路复用同一读取入口，仅替换"解析后的渲染"。entries 构造时统一过 `safeTerminalText`（与 pi-btw 做法一致）。

### D7: pi-btw 迁移范围——只删重复实现，不动 overlay 结构

btw.ts 删除手写状态机函数并改为 import 共享 API；overlay 组件、滚动逻辑、输入处理不动。迁移后 btw 测试套件必须全绿作为验收门槛。该包同为 subtree，改动集中单文件、行数净减，降低未来 sync 冲突面。

### D8: 依赖声明

pi-subagents `package.json` 增加 `"dependencies": { "@xzzpig/pi-components": "…" }`（运行时库按仓库惯例进 dependencies 而非 peerDependencies）；workspace 内通过 pnpm workspace 协议联调。

### D9: subtree 分歧记录

实施完成后更新 `subtrees/pi-subagents.json` 与（如适用）`subtrees/pi-btw.json` 的 `notes` 字段，说明本次本地分歧内容，遵循仓库 AGENTS.md 的治理要求。

### D10: 渲染界面切换快捷键

新增键位动作 `toggleRenderer`（纳入 `FleetKeybindingAction` 重映射体系），默认 `v`（空闲且语义贴切；已核对不与 q/j/k/r/s/x/c/p/g/H/D/K/J 等现有键冲突）。组件实例持有会话级布尔状态，默认原生渲染；与 D5 的职责边界：**D5 探测决定"能否用"，本键决定"要不要用"**——探测失败时按键给出提示并保持文本渲染，不静默失败。实现与 `x` 键完全同构：状态翻转 → transcript 缓存失效（渲染模式纳入缓存指纹）→ 下帧走对应链路重渲。

- _备选_：持久化到配置文件 → 否决：需求为运行时可逆切换，会话级即可；配置级强制旧渲染已由 D5 的显式覆盖入口覆盖，两者互补而非重复。
- _备选_：per-item 切换 → 否决：渲染范式是全局观感选择，逐条目切换认知成本高且缓存管理复杂化。

## Risks / Trade-offs

- [窄面板下原生 diff/表格渲染溢出或换行异常] → 原生组件自带宽度自适应与 verbatim 保护；任务中加入最小宽度（60 列）下的视觉验收项；极端情况下整条链路可经 D5 降级开关关闭。
- [`x` 展开切换导致全量重建，大 transcript 卡顿] → fingerprint 缓存使重建仅发生在切换瞬间；尾部读取已有 maxRecords=240/maxBytes 上限；必要时后续再加增量优化（记为 Non-Blocking）。
- [thinking 内容在部分历史记录中缺失或超大] → 构造层沿用现有 clipMessage 式截断上限后再写入 entry。
- [pi-btw 迁移引入行为回归] → 迁移前后各跑一次完整测试套件比对；共享 API 签名与 btw 手写版本逐一对齐后再删除。
- [upstream 未来 sync 冲突] → pi-subagents 改动收敛到新文件 + fleet.ts 单点分支；分歧记录写入 subtrees metadata。
- [组件包发布滞后导致 CI 安装失败] → workspace 协议下本地链接优先；发布顺序任务化为：先发 pi-components 再动 pi-subagents 依赖声明。

## Migration Plan

1. pi-components 增加公开导出 + 测试（纯新增，随时可合入）。
2. pi-btw 迁移到共享 API（行为等价验证后合入）。
3. pi-subagents 接入新渲染（默认开启，D5 降级保底）+ 依赖声明 + subtrees notes 更新。
4. 回滚策略：三个包相互独立可单独回退；运行时层面用户可随时用切换快捷键回到旧界面（主回退入口）；pi-subagents 另保留配置/环境变量强制旧渲染器的显式覆盖（实现为 D5 探测的显式覆盖入口），供脚本化环境使用。

## Open Questions

无——渲染效果类不确定项（窄面板视觉）已列入任务验收，不影响架构选择。
