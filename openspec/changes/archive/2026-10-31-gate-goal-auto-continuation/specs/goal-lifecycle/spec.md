# 目标生命周期增量规格

## ADDED Requirements

### Requirement: 自动续跑在最终发送前接受同步门禁

goal-x SHALL 在现有 timer 触发且目标与宿主 readiness 检查通过后、领取自主运行额度及追加状态快照/checkpoint 之前，发出 `pi-goal:before-auto-continue:v1` 事件。事件 SHALL 包含协议版本、父会话身份、目标身份和同步 `defer` 回调。监听者 SHALL 仅能阻止本次发送；无监听者或无人阻止时 SHALL 保持原有续跑行为。本变更 SHALL 作为既有兼容性基线的新增预期差异，其他目标生命周期与审计保证保持不变。

#### Scenario: 异步派发后未显式等待

- **WHEN** 父模型派发具有原生唤醒契约的异步子代理，未调用等待工具就结束执行，goal-x 随后准备自动发送 checkpoint
- **THEN** 门禁事件在领取额度和追加消息前发出，subagents 可以阻止该次发送，期间不产生 goal 自动唤醒的模型请求

#### Scenario: 未加载监听者

- **WHEN** 一次原本合法的自动续跑没有门禁监听者或所有监听者都不阻止
- **THEN** goal-x 沿用既有授权、状态快照/checkpoint 配对和发送流程，不增加等待时间或模型调用

#### Scenario: 宿主尚未就绪

- **WHEN** 原有 readiness 检查发现宿主忙碌或存在 pending messages
- **THEN** 本次不发门禁事件，继续沿用原有 50ms readiness 重试；本变更不改变这个周期

### Requirement: 门禁阻止具有单向且调用内有效的语义

任一同步监听者调用 `defer` 后，系统 MUST 阻止本次自动续跑，其他监听者 MUST NOT 将其覆盖为放行。事件派发返回后，迟到的异步回调 MUST NOT 改变决定或触发其他动作。监听者 MUST NOT 借此修改目标焦点、批准目标完成或绕过既有预算及授权 gate。事件处理 MUST NOT 依赖监听函数返回值。

#### Scenario: 多监听者顺序无关

- **WHEN** 一个监听者阻止，另一个监听者不阻止，且二者注册顺序互换
- **THEN** 两种顺序均阻止发送，不存在最后写入放行覆盖前一阻止的行为

#### Scenario: 迟到回调不生效

- **WHEN** 某监听者保存回调并在事件派发返回后调用
- **THEN** 该调用不改变已决定的发送结果，也不影响后续请求或产生异常唤醒

#### Scenario: 门禁处理期间目标失效

- **WHEN** 门禁监听期间目标失去焦点、暂停、完成，或出现新的宿主工作
- **THEN** 即使无人阻止也不得发送过期 checkpoint，最终授权与宿主状态校验仍生效

### Requirement: 被阻止的发送不派生重试或目标终态

门禁阻止 SHALL 仅结束当前发送尝试，不新增重试 timer、轮询、解除事件或模型调用，不消耗自主运行额度、等待检查额度或 checkpoint 序号，不追加配对快照及 checkpoint，不把目标改成 paused、blocked 或 complete。后续既有用户输入、子代理结果、监督请求和合法调度入口 SHALL 保持可用，每次新的自动发送尝试 SHALL 重新询问门禁。

#### Scenario: 阻止后经过多个原重试周期

- **WHEN** 门禁已阻止且没有新的合法调度入口，测试时钟跨过多个 50ms 周期
- **THEN** 不再次发送门禁事件、不产生新 timer 或 checkpoint，自主运行和等待检查次数均不增加

#### Scenario: 结果唤醒不受影响

- **WHEN** 阻止后子代理通过既有机制送达结果并唤醒父模型
- **THEN** 结果照常进入父会话；不需额外解除门禁，父模型处理结果后按原有 settled 流程重新判断自动续跑

#### Scenario: 用户继续交互

- **WHEN** 门禁阻止后用户发送新要求或操作目标
- **THEN** 用户输入及原有生命周期操作正常生效，门禁不形成用户输入屏障或自动选择其他目标

### Requirement: subagents 只根据当前父会话的原生唤醒工作阻止

subagents SHALL 同步读取其已有运行与通知交接状态，只为当前父会话拥有、且原生完成或监督路径承诺唤醒父模型的后台工作调用 `defer`。范围 SHALL 包含符合此条件的 async 运行、detached foreground 和结果尚未交接的终态工作。其他会话、仅展示任务或显式不触发父回合的任务 MUST NOT 单独造成阻止。监听器 MUST NOT 解析任意工具返回文本、通用 status/id 字段、扫描磁盘或调用模型。

#### Scenario: 当前父会话有原生异步工作

- **WHEN** 当前父会话存在具有原生结果唤醒的 queued 或 running 子代理
- **THEN** subagents 同步阻止 goal 自动发送，不要求模型额外声明 wait

#### Scenario: 最后一个子代理结束但结果未交接

- **WHEN** 最后一个子代理已进入成功、失败、停止等终态，但其应唤醒父模型的结果仍在原生通知交接中
- **THEN** subagents 仍阻止本次 goal 续跑，不让 checkpoint 抢在结果前发出；交接后沿用原有通知与去重语义

#### Scenario: 工作流根与 detached foreground

- **WHEN** 顶层 workflow 仍负责其子任务的结果交接，或 foreground 子代理已 detach 且仍通过原生监督/完成机制联系父会话
- **THEN** 对具有原生父会话唤醒契约的工作阻止自动续跑，不重复计算嵌套 child，不拦截监督请求

#### Scenario: 外部会话或无唤醒任务

- **WHEN** 只有其他父会话的工作，或只有明确不唤醒当前父模型的任务
- **THEN** subagents 不因此阻止当前 goal 自动续跑

#### Scenario: 监听器本地状态读取失败

- **WHEN** 本次适配器无法读取其必要内存状态
- **THEN** 适配器捕获错误并同步阻止本次发送，记录有界本地诊断，不自动暂停目标、不创建重试或伪造完成通知；用户输入仍可恢复交互

### Requirement: 门禁监听资源遵循扩展会话生命周期

subagents SHALL 在对应父会话准备好运行与交接状态后安装监听器，并在 shutdown、reload 和会话替换时释放或失效旧监听器。旧会话监听和迟到请求 MUST NOT 阻止新会话。该协议 SHALL 只作为进程内控制消息，不新增持久化记录版本、工具、设置、命令或模型上下文提示。

#### Scenario: 扩展加载顺序不同

- **WHEN** 两个扩展按不同顺序加载，随后完成会话初始化
- **THEN** 首次合法自动续跑可取得当前 subagents 的门禁判断；subagents 缺失时继续保持无人阻止的原行为

#### Scenario: 会话切换或重载

- **WHEN** 旧会话有后台工作而父会话切换或扩展 reload
- **THEN** 旧订阅被清理，重建后的监听器只使用当前会话与已恢复的权威状态，不残留永久阻止标志

#### Scenario: 未阻止时不改变模型输入

- **WHEN** 门禁无人阻止
- **THEN** 新生成的主模型消息内容、工具声明和状态快照/checkpoint 配对沿用原行为，门禁事件与理由不写入模型上下文

## MODIFIED Requirements

### Requirement: 实现范围与 pi-subagents 修改边界

本变更的验收范围 SHALL 限定为 `pi-goal-x` 的完成审计改造，以及从 `pi-subagents` 现有 eject handler 抽取并复用共享 agent-management service 所必需的最小公共导出、适配和测试。用户明确批准的例外仅有：foreground executor 对既有 `message_end`/`toolResult` 与 `tool_result_end` progress event shape 的归一化/去重及直接测试，以及 `preflight.ts` 中 `packageVersion()` 对损坏 package metadata 的 fail-closed 错误包装。后者 MUST NOT 改变其 public async contract、launch 语义或工具计划。另外，完成审计 supervisor 旁路允许新增版本化 responder API、精确 attempt 与实际 child 的启动前绑定、监督请求接管/回复/清理及其直接测试；接入 SHALL 限定为 API 导出、structured delegation 生命周期、前台 executor 的内部启动绑定回调和原生 supervisor 通道入口，普通子代理的默认监督、运行和终态语义 MUST 保持不变。另外，自动续跑事件门禁允许在 `pi-subagents` 扩展会话生命周期中接入同步监听器，并只读复用当前父会话的后台运行与原生通知交接状态；实现 SHALL 限于 fork-only 适配模块、必要的最小生命周期/状态读取接缝及直接测试，不得改变子代理启动、终态、结果唤醒或监督请求语义。除上述范围外，`packages/pi-subagents` 的既有 delegation、preflight、运行时、MCP、skill、Fleet、mission、slash command 和其他实现 SHALL 保持不变。任何超出该边界的 `pi-subagents` 修改 MUST 在交付前还原；非修改范围内产生的额外 lint、warning 或格式问题不属于本变更验收项，也不得以此扩大修改范围。

#### Scenario: 验收变更边界

- **WHEN** 审查本变更的最终工作树和差异
- **THEN** `pi-subagents` 中除 shared eject service 及其直接 public export、必要适配和测试，以及明确批准的 foreground event normalization/去重、`packageVersion()` fail-closed 错误包装和当前 audit supervisor 旁路的上述最小接入，以及自动续跑门禁监听的最小接入外，不得存在本变更引入的实现差异；范围外 lint/warning 不阻塞本变更
