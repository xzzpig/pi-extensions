# Pill 状态栏增量规范

## ADDED Requirements

### Requirement: MCP 状态沿用发布者的显示内容

Starline MUST 将第三方状态 key `mcp` 按既有第三方 status 路径渲染为 pill，继续尊重用户的显示、顺序与配色配置。MCP 适配 MUST NOT 重写发布者文本、解析或自行推算连接数量、另建重复 MCP pill，也 MUST NOT 读取或修改 adapter 配置文件。简短格式由 adapter 的 `compact` 设置提供。

#### Scenario: 简短计数原样显示

- **WHEN** adapter 发布 `mcp = "MCP 0/1"`，且该状态可见并使用默认全文格式
- **THEN** pill 显示 `MCP 0/1`，并保留已连接数与已启用数的不同含义，不因零连接额外添加故障标记

#### Scenario: 特殊提示不被适配裁剪

- **WHEN** adapter 发布连接中、项目信任阻止或后台任务等提示，且用户没有配置额外文本变换
- **THEN** Starline 沿用既有清洗和终端宽度截断规则显示该提示，不将其替换为固定计数

#### Scenario: 隐藏与清空状态

- **WHEN** 用户隐藏 `mcp`、将其移出 pill 布局且不再通配展开，或 adapter 清空该状态
- **THEN** 不存在该 pill 的可见点击热区，适配不得自行恢复或新增一个 MCP pill

### Requirement: MCP pill 打开原有管理面板

在交互式 TUI 中，当扩展命令 `mcp-adapter` 可用且不存在其他已注册的 `mcp` action 时，Starline MUST 为 MCP 状态 pill 提供默认点击动作；该动作 MUST 经 Pi 的扩展命令分发打开 adapter 原有面板，而非复制面板或打开 Starline 自制内容气泡。`/starline mcp` MUST 可触发相同动作。原面板的关闭、保存、认证和必要的 reload 行为 MUST 仍由 adapter 管理。

#### Scenario: 点击打开原面板

- **WHEN** adapter 已发布可见 `mcp` 状态、默认动作已注册，且用户点击该 pill
- **THEN** 分发一次 `/mcp-adapter` 命令，由 adapter 打开与手动执行该命令相同的界面，不调用 `/mcp`

#### Scenario: 键盘入口等价

- **WHEN** 默认 MCP 动作已注册且用户执行 `/starline mcp`
- **THEN** 触发与 pill 点击相同的命令路由和安全检查

#### Scenario: 模型工作期间打开

- **WHEN** 模型正在流式输出且用户触发 MCP pill 动作
- **THEN** `/mcp-adapter` 作为扩展命令执行，不进入 steering 或 follow-up 队列，不产生模型请求，不中断当前模型工作

#### Scenario: 不接管原面板的关闭和保存

- **WHEN** 原 MCP 面板已打开且用户使用其关闭或保存操作
- **THEN** adapter 自行处理关闭、配置保存与必要的 reload，Starline 不把该面板当成自己的气泡进行同 pill 再次点击关闭

### Requirement: MCP 命令路由安全降级

Starline MUST 仅向当前命令列表中来源为扩展的 `mcp-adapter` 命令路由，并在每次触发前重新检查。命令缺失、查询失败、会话已失效或模式非交互式 TUI 时 MUST 不发送命令文本，不触发模型请求，不尝试导入 adapter 实现。仅有同名模板或技能 MUST NOT 被认作该扩展命令。

#### Scenario: adapter 未安装

- **WHEN** Starline 会话启动时没有扩展命令 `mcp-adapter`
- **THEN** 不注册默认 MCP 点击动作，Starline 正常工作，已有同名状态仍可作为只读内容显示

#### Scenario: 已注册后命令消失

- **WHEN** 默认动作已注册，但触发时命令不存在或命令列表读取失败
- **THEN** 不发送 `/mcp-adapter`，允许显示简短不可用提示但不抛出影响渲染循环的异常

#### Scenario: 同名模板不是命令

- **WHEN** 命令列表中只有来源为模板或技能的 `mcp-adapter`
- **THEN** 不注册或执行默认 MCP 面板路由，不把模板展开为模型提示

#### Scenario: 非交互模式不执行面板动作

- **WHEN** 动作收到 RPC、JSON、print 模式或无 UI 的上下文
- **THEN** 不发送面板命令、不调用终端自定义界面，也不影响 MCP 工具本身

### Requirement: MCP 动作避免输入重复与浮层堆叠

同一次鼠标按下及其合成点击 MUST 最多分发一次面板命令。默认动作 MUST 合并首次分发后 300 毫秒内的再次触发，并在可检测到非 Starline 可见浮层时拒绝叠加面板。打开原面板前 MUST 关闭当前 Starline pill 气泡；不得以 adapter 面板关闭事件或命令完成信号不存在为由永久锁死入口。

#### Scenario: 按下和合成点击不重复

- **WHEN** 用户完成一次没有拖动的 MCP pill 鼠标手势
- **THEN** 按下事件与随后合成的点击合计只分发一次命令

#### Scenario: 快速双击被合并

- **WHEN** 用户在首次命令分发后不足 300 毫秒再次点击或执行键盘入口
- **THEN** 后续触发不再次分发命令，冷却结束后入口不会永久锁定

#### Scenario: 从已有 Starline 气泡切换

- **WHEN** 某个 Starline pill 气泡打开且用户触发 MCP 动作
- **THEN** 先关闭该气泡，再分发原 MCP 面板命令

#### Scenario: 可见外部面板不叠加

- **WHEN** 当前宿主支持可见浮层检测，且 MCP 面板或其他非 Starline 浮层已经可见
- **THEN** 忽略本次打开请求，不关闭该外部浮层，也不打开第二个面板

### Requirement: MCP 默认动作遵循会话与注册所有权

默认 MCP 适配 MUST 在会话初始化后建立，并在会话结束、切换或 reload 时清理自己的注册和短时状态，不保留旧会话上下文。适配 MUST NOT 覆盖已有的第三方 `mcp` action；其清理 MUST NOT 删除随后替换它的新注册。其他状态 key 和内置 pill 的动作、几何及公开 API MUST 保持不变。

#### Scenario: 重载后只保留新会话入口

- **WHEN** 用户执行 reload 或切换会话，随后点击 MCP pill
- **THEN** 最多执行新会话的一次默认动作，不执行旧会话的延迟工作或沿用旧冷却状态

#### Scenario: 其他扩展已拥有该动作

- **WHEN** 注册默认适配时已有第三方注册了 `mcp` action
- **THEN** 保留已有动作，不以默认适配覆盖它

#### Scenario: 旧清理不删除新拥有者

- **WHEN** 默认适配注册后被另一个 `mcp` action 替换，随后旧适配被清理
- **THEN** 新注册仍有效，旧清理只释放自己拥有的状态

#### Scenario: 其他状态与内置行为不受影响

- **WHEN** 用户操作非 MCP 第三方 pill 或内置 model、thinking、context 等 pill
- **THEN** 继续使用原有渲染、命中和动作逻辑，不受 MCP 默认适配影响
