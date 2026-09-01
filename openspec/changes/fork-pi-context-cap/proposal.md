## Why

Pi 的自动压缩只在整轮 agent 循环结束和下一条 prompt 提交前检查，工具循环内部（LLM 调用之间）没有任何检查点；单轮内长工具循环可以让上下文无界增长直到 Provider 报溢出（pi issues #2871/#5512/#6879）。上游 `@lukeramsden/pi-context-cap` 用 `turn_end` 钩子实现了轮中强制压缩，但它的预算是单一全局数字：不能按模型启用，也没有会话级开关与本仓库 `@xzzpig/pi-*` 的 fork 规范。

## What Changes

- 以 `git subtree` 导入上游 `lukeramsden/pi-context-cap`（squash），生成 `packages/pi-context-cap`，npm 名改为 `@xzzpig/pi-context-cap`，并写 `subtrees/pi-context-cap.json` 元数据记录。
- 新增模型白名单：扩展仅对白名单内的模型激活；匹配规则与 pi `scopedModels`/`enabledModels` 约定一致（minimatch 匹配 `provider/modelId` 或裸 `modelId`）；白名单为空表示对所有模型生效。
- 新增配置文件：全局 `~/.pi/agent/context-cap.json` 与项目级 `.pi/context-cap.json`（项目覆盖全局），可配置 `models` 白名单、`budget`、`reserve`；项目级配置仅在项目受信任时读取。
- 预算按模型配置的上下文长度对齐：未显式配置 `budget` 时，有效预算 = 当前模型的 `contextWindow`（窗口未知时回退默认 200,000），触发点 = `min(budget - reserve, contextWindow - 4096)`（模型窗口过小则禁用该模型守护并告知）；模型切换即时生效。`model.contextWindow` 只读不写。
- 会话级开关扩展：`/context-cap on|off` 在上游基础上增加与白名单的交互语义（三态 override：default 跟随白名单 / on 强制启用 / off 强制禁用），仅当前会话有效。
- 保留上游核心行为：`turn_end` 轮中压缩 + followUp 自动恢复、`agent_settled` 兜底、`session_start` 超限恢复、`--context-cap`/`--context-cap-reserve` flags、防重入与失败熔断防护。

## Capabilities

### New Capabilities

- `context-cap-guard`: 轮中上下文预算守护——基于 `turn_end`/`agent_settled`/`session_start` 钩子在超出 `budget - reserve` 时触发强制压缩并自动恢复任务。
- `context-cap-config`: 配置文件与模型白名单——全局/项目两级 JSON 配置（`models` 白名单、`budget`、`reserve`），项目配置需项目受信任，项目覆盖全局。
- `context-cap-session-toggle`: 会话级开关——`/context-cap on|off` 三态 override（default/on/off），仅当前会话有效，可覆盖白名单判定。

### Modified Capabilities

（无——本仓库尚无相关既有 capability。）

## Impact

- **新增包**：`packages/pi-context-cap`（npm `@xzzpig/pi-context-cap`），`pi.extensions` 指向 `./extensions`，pi 核心导入走 `peerDependencies`。
- **subtree 元数据**：`subtrees/pi-context-cap.json` + `upstream-pi-context-cap` git remote；`direnv reload` 需接受该记录。
- **仓库注册**：`versions.json` 增加条目；README 包列表更新。
- **运行时行为**：安装后对白名单模型的超长工具循环会话，在轮中 abort→压缩→followUp 恢复；对未安装用户无影响。
- **上游同步**：fork 改动集中在配置加载、白名单判定与会话状态；核心压缩逻辑尽量少改，降低未来 `git subtree pull` 冲突面。
