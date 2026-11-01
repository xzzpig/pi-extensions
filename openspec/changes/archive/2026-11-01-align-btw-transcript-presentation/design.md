# 技术设计

## Context

动机见 `proposal.md`。本机 Pi 1.4.0 与仓库的 BTW 0.11.0、pi-components 0.4.0 实现已核对，安装源码与仓库一致；本阶段没有做 TUI 复现，不把源码推断写成已通过的运行结果。

当前约束与证据：

- `pi-components/src/transcript.ts` 聚合助手文本和思考后构造临时 `AssistantMessageComponent`，没有传递条目的 streaming；宿主原生组件初始 `isStreaming=false`。
- `pi-thinking-collapse/src/state.ts` 对已完成消息自动折叠，解释了 BTW 流式思考提前折叠。BTW 自定义标签 `Thinking` 又绕过插件默认展开提示。
- BTW 行缓存只比较 transcript 版本与宽度；渲染后压平为字符串，未接入原生思考区域的鼠标路由和持久化组件状态。
- 工具注册表支持 `resolveToolDefinition`，但 BTW 创建状态时没有提供。子会话公开 `getToolDefinition()` 可取得自身工具定义；`ExtensionAPI.getAllTools()` 只有信息，不是主会话 renderer 访问器。
- `pi-tool-display` 已有版本为 1 的全局显示 API，但 `decorateTool()` 并不覆盖所有内置工具；不能把调用该函数当作完整主会话样式兼容。其 thinking 标签依赖主会话消息事件，不是原型补丁。
- 用户消息框与思考折叠是宿主原生类原型补丁，复用同一宿主类即可生效；不应在 BTW 子会话重复加载这些插件。

## Goals / Non-Goals

**目标**：实现有界、可测、可降级的内容呈现兼容；优先原生生命周期和思考交互，再接入已知工具样式。视觉比较以相同内容、相同主题、相同插件配置及相近可用宽度为基准，不要求边框占位导致的换行逐字相同。

**非目标**：复制主会话 InteractiveMode、截取主界面 ANSI 输出、读取主会话私有会话指针、注册父会话执行工具；不支持任意插件 footer、starline 布局、group-collapse 分组、消息事件格式化或 Markdown transformer 注册链的自动镜像；不修改 fleet inspector 的显示策略。没有真实工具元数据时不伪造 diff、RTK 压缩或耗时。

## Decisions

### 1. 新增可选有状态展示器，不强改无状态渲染入口

在 pi-components 新增展示器模块，沿用共享 entries；以稳定条目标识和助手消息段标识维护用户/助手组件与布局注册表，工具继续复用已有组件注册表。构造器只接收空消息，随后显式调用 `updateContent(message, streaming)`，防止构造时第一次绘制就被折叠插件判为完成。

消息分段必须保留消息开始/结束及工具调用分隔；一个 turn 不等于一个助手消息。优先利用现有条目 id 和 activeAssistant 分段，若不足则增量增加可选内部标识；实时摄入与 BTW 手工回放适配都提供相同分段语义，不把不同消息合并为一个可交互实例。

内容变化更新既有组件，纯重绘/缩放不重新赋值内容。真实内容更新由原生组件保留每段思考的覆盖选择；不得由宿主每帧重设 hide 标志。消息删除/线程清空时 prune；窗口临时关闭只 detach TUI，保留线程展示器；真正线程重置/会话销毁时 dispose。

替代方案：只补一个 streaming 布尔值虽然简单，但仍丢失点击状态和重绘生命周期，因此不采用。旧 `renderTranscriptLines` 与 fleet 维持原样，新能力通过增量导出显式启用。

### 2. 思考交互采用组件级事件路由和本地键盘切换

新展示器保留每个消息组件在完整 transcript 内的行范围。BTW overlay 增加规范化 `handleMouse` 路由：减去 overlay 边框和顶部 chrome，加上 transcript scroll offset，将可见坐标映射到对应组件，再通过 Pi 的原生组件鼠标分发处理思考区域。不把原始终端坐标直接交给子组件；点击被裁掉的内容或输入区不能命中 transcript。

普通模式保留现有滚轮输入兼容；没有规范化点击路由时不伪造可点击承诺，键盘仍可使用。新增 BTW 本地思考切换动作，默认 Ctrl+T、支持 BTW 配置覆盖；overlay 聚焦时统一展开/收起保留的思考，失焦后不吞主会话按键。页脚显示实际键位，设置变化只作用于 BTW 组件，不写主会话设置。原生逐块点击选择与统一切换一致：统一切换显式重置局部覆盖，然后设置所有现存块；后续新增块继承 BTW 本地选择。

不引入自建终端鼠标协议，也不依赖原生组件私有字段：坐标分发使用宿主公开鼠标接口，统一切换通过展示器自己的块选择状态和公开组件接口完成。若某个旧 Pi 缺少规范化鼠标能力，只降级鼠标路径；键盘与内容显示必须保留。

### 3. 用小型只读显示提供者接入已知工具样式

扩展已有 `pi-tool-display.api.v1`，增加可选、能力探测式的 `getToolPresentation(name)` 与显示修订号。旧 `decorateTool()` 调用不变，旧显示插件没有新能力时直接降级，不通过旁路访问其内部定义。

在 tool-display fork-only 模块存储由其内置工具注册接缝提交的显示白名单字段：`renderCall`、`renderResult`、`renderShell` 及必要标签。返回副本，绝不返回 `execute`、prepare/loadout hooks 或完整注册对象；支持 read/bash/edit/write/grep/find/ls，尊重 enabled 和逐工具 override 配置。配置变更、reload/dispose 更新修订或撤销提供者。renderer 自身状态仅存于 BTW 工具组件的 render context，不复用父会话组件实例。

BTW 的 fork-only 适配器按以下优先级解析：

1. 子会话自定义工具自身的显示定义（并使用子会话公开扩展 renderer 解析能力，如宿主公开可用）。
2. 对已知内置工具，从已加载 tool-display 提供者取得显示字段，叠加在子会话定义的展示副本上。
3. 子会话原生显示定义或 Pi 默认回退。

传入 BTW 实际 cwd、args、content、details、isError 与 streaming。远端调用不可用本地文件探测补造远端 diff；提供者显示适配对 SSH 禁用需要本地工作区读取得出的增强预览，保留纯参数/结果显示。父会话消息和执行函数都不进入该接口。

替代方案：直接共享父会话全部定义需要获取私有主会话对象，且可能带出执行能力；在 BTW 重新加载 tool-display 又会覆盖全局补丁并与现有同名内置工具冲突，均不采用。

### 4. 明确兼容矩阵，停止在有限范围内

| 项目                                            | 本次决定                                       |
| ----------------------------------------------- | ---------------------------------------------- |
| 原生消息、Markdown、代码高亮、工具输出          | 支持；使用宿主组件与主题                       |
| pi-thinking-collapse                            | 支持流式展开、完成折叠、逐块点击和本地统一切换 |
| pi-tool-display 用户消息框                      | 复用已加载原型补丁；无需子会话加载插件         |
| pi-tool-display 七种内置工具样式                | 新显示接口可用且配置允许时支持                 |
| BTW 白名单扩展工具自身 renderer                 | 支持，不强制套父会话通用样式                   |
| 主会话 Thinking: 事件标签改写、任意 transformer | 本次不复制，原生思考色彩/格式仍保留            |
| 插件依赖的执行元数据                            | 只使用 BTW 实际产生的部分；缺失时回退          |
| 分组、页脚、主窗口布局、任意插件私有补丁        | 不保证，与本次内容展示对齐无关                 |

发现新的复杂插件兼容点时，按表中边界记录限制，不在 apply 阶段临时扩张到通用扩展镜像系统；改变这些边界须先修订方案。

### 5. 展示修订统一驱动缓存与错误隔离

展示器维护独立 revision，涵盖条目变化、展开、主题、显示提供者修订、尺寸及子组件 requestRender。BTW 的行缓存同时检查该 revision；不能仅让 TUI requestRender 而保留旧行缓存。原生富工具输出按既有宽度规则原样保留，不二次换行破坏 diff。

单工具 renderer 外侧做异常隔离，出错后使用无插件 renderer 重建该工具展示组件，避免递归调用失败路径；按工具与显示修订限频诊断。未知版本/未安装提供者属于正常降级，不每帧警告。主题切换 invalidate 组件而非重置宿主全局 theme；内容只保留未着色结构化文本。

## Risks / Trade-offs

- [鼠标坐标和裁剪容易偏移] → 窄宽、滚动、宽度切换、不同 overlay 锚点测试；全屏录屏验证，普通模式提供键盘路径。
- [原型补丁行为依赖宿主版本] → 与真实宿主导出类做契约测试；不捆绑额外 Pi 核心副本，保持 peers；验证加载顺序和 reload 幂等性。
- [工具 renderer 闭包可能依赖执行元数据或本地文件] → 仅暴露白名单显示字段；实际结果优先，SSH 禁用本地预览；故障单工具降级，不承诺无元数据下完全一致。
- [持久组件扩大内存或保存过期状态] → 按保留 entries prune，继续使用现有 transcript 容量限制；清空、切线程与 dispose 做资源测试。
- [共享库影响 subagents] → 新展示器 opt-in，存量入口与 fleet 回归必须通过。
- [上游冲突成本] → pi-btw、pi-tool-display 新逻辑均放 fork-only 文件，仅保留导入、委派、注册显示字段的最小接缝；按实际触及的 upstream 文件更新 subtree 维护记录并运行 divergence gate。

## Migration Plan

1. 先增加共享展示器与测试，不切换既有消费者；再增加 tool-display 可选显示接口。
2. BTW 通过 fork-only 适配器接入，两种模式和 SSH 保持原工具策略；记录兼容版本和降级矩阵。
3. 运行三包 typecheck/测试和 fleet 相关回归，按真实 Pi 隔离环境进行普通/全屏 TUI 对照与 asciinema 录屏。未完成真机测试不得宣称交互兼容已验证。
4. 打包检查保证 pi-components 新导出随 BTW 内嵌可用、Pi 核心仍为 peers；实际版本更新与发布留给另行授权的发布流程。
5. 回滚可撤回 BTW 的新展示器接缝，恢复原渲染入口；保留新 API 不影响旧消费者，原线程数据格式仍可读取。无需远程发布或自动修改用户配置。
