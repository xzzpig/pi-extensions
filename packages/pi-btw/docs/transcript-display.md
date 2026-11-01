# BTW 转录显示兼容性

本页说明当前工作树中的 BTW overlay 转录。它是 `/btw` 模态框的 fork-only
兼容性契约，不承诺主会话中的任意插件、布局或事件改写都会出现在 BTW 内。

## 版本与验证范围

- 本次发布准备版本为 `@xzzpig/pi-btw` 0.11.1、私有内嵌库
  `@xzzpig/pi-components` 0.5.0；七工具显示提供者随 `@xzzpig/pi-tool-display`
  0.3.1 提供。版本已准备，**尚未实际发布**。
- 不要假设同版本的 npm 包已经包含 `transcript-presenter` 集成或可选的
  tool-display 提供者。在单独发布之前，请把本页视为工作树行为。
- TypeScript 类型检查与单元测试使用 workspace catalog（目前 Pi 1.1.0）；公开 API
  形状另对照已安装的 Pi 1.4.0 源码。4.2 已在隔离的真实 Pi 1.4.0 + 真实模型上完成
  普通与全屏 TUI 验收并保存 asciinema 回放；4.3 又在 `/tmp` 的本地 tarball 上验证
  了真实打包入口与 Pi/jiti 加载。命令、退出码、录屏路径与逐场景差异结论见
  [`openspec/changes/archive/2026-11-01-align-btw-transcript-presentation/verification.md`](../../../openspec/changes/archive/2026-11-01-align-btw-transcript-presentation/verification.md)
  的批次 4.1–4.3。
- 已验收的视觉范围是：真实 Pi 1.4.0、真实模型、普通/全屏两种 `--tui-mode` 和
  显示插件启用/禁用负对照；回放核对以 pane 文本帧为主，颜色只做抽样。不声称
  像素级对齐，也不覆盖任意 Pi 版本。
- SSH 运行时回归使用受控的 fake workspace/session；真实外部 SSH 主机传输仍未
  验证，也不在本轮范围内。4.2 不新增外部 SSH 主机验收要求。
- 内嵌工具 renderer 的故障隔离（工厂、`render`/draw、`invalidate`、`handleMouse`
  抛错）已在 4.2 补齐，并由单元测试与真实录制 S6c 共同验证：单个工具回退到实际
  args/结果文本，其他工具与输入继续可用，诊断按工具+阶段+修订限频。

## 兼容矩阵

| 范围                                                     | 当前工作树行为                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生用户/助手消息、Markdown、代码块、工具输出            | 通过宿主原生 Pi 组件和当前宿主主题支持。                                                                                                                                                                                                                                            |
| `pi-thinking-collapse`                                   | 宿主加载该插件时支持：流式思考保持可见，完成后的思考按其规则折叠，原生逐块点击可用，BTW 本地切换可覆盖保留的块。未加载插件时沿用 Pi 原生默认行为。                                                                                                                                  |
| `pi-tool-display` 原生用户消息框                         | 复用宿主已有的组件原型补丁；BTW 不把插件加载进子会话。                                                                                                                                                                                                                              |
| `pi-tool-display` 的七种内置工具样式                     | 可选提供者能力存在、已启用且该工具配置允许时支持。支持 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。                                                                                                                                                                      |
| BTW 白名单扩展工具自身 renderer（含同名内置名）          | 支持。子会话公开 `registerToolRenderer` 解析结果与扩展工具定义自带的 renderer 逐字段优先；只有普通内置默认定义（自身无 renderer）才由提供者补样式。                                                                                                                                 |
| 主会话 `Thinking:` 事件标签和任意 Markdown transformer   | 不复制。                                                                                                                                                                                                                                                                            |
| 分组、footer/starline、主窗口布局和任意插件私有补丁      | 不保证，也不镜像。                                                                                                                                                                                                                                                                  |
| 父执行元数据、父 `execute` 函数、父 previous-content map | 永不借用。                                                                                                                                                                                                                                                                          |
| SSH 中需要读取本地文件的 edit/write 增强预览             | 禁用；纯参数/结果渲染仍然可用。                                                                                                                                                                                                                                                     |
| 真实普通/全屏 TUI 与 asciinema 对比                      | 已验收：隔离真实 Pi 1.4.0 + 真实模型，普通/全屏、显示插件启用/禁用、重开/缩放/失败场景；证据见 `verification.md` 批次 4.2。同名内置工具的子会话 renderer 优先级另有一条真实 session 录屏（批次“审计修正”），证据同在该报告。真实外部 SSH 传输、任意 Pi 版本与像素级对齐不在范围内。 |
| 本地 tarball 的真实消费者与 peer 边界                    | 已验收：pi-components 新子路径、BTW 内嵌副本、tool-display 消费者子路径均在 `/tmp` 临时消费者中解析/加载，Pi 核心仍为 peers；证据见 `verification.md` 批次 4.3。                                                                                                                    |

## 键位与焦点

| 动作                          | 默认键                           | 配置                                                                                       |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| 切换 BTW 思考可见性           | `Ctrl+T`                         | `PI_BTW_THINKING_KEYS`，逗号分隔的 pi-tui key id；任一可用项都可触发，重复或无效项被忽略。 |
| 在 BTW 与主编辑器之间切换焦点 | `Alt+/`、`Super+/`、`Ctrl+Alt+W` | `PI_BTW_FOCUS_KEYS`，相同的逗号分隔语法；它会替换默认列表。                                |
| 切换窗口/全宽布局             | `Alt+W`                          | 当前工作树固定。                                                                           |
| 流式时中止/空闲时关闭         | `Esc`                            | 当前工作树固定。                                                                           |

页脚显示实际解析出的思考键和焦点键。空白、重复或无效项会被忽略；如果没有任何
可用项，则保留默认值，确保键盘路径不会消失。

思考切换是 BTW 本地的。它只改变保留的 BTW 组件，绝不写入主会话的思考偏好。
BTW overlay 聚焦时，本地处理器会先于主编辑器看到该键；overlay 未聚焦时，仍按
Pi 的正常键处理。如果终端或 Pi 核心占用了默认键，请用
`PI_BTW_THINKING_KEYS` 换成其他键，页脚会显示替换后的键。

## 鼠标与滚动

- 全屏（alt-screen）模式支持对可见转录内容进行规范化点击。BTW 会减去边框和
  顶部 chrome，加上转录 scroll offset，把行映射到所属原生组件，再通过 Pi 的
  公开组件鼠标路径分发。
- 点击输入区、页脚、状态/chrome、边框，或位于转录视口之外的裁剪行，不会命中
  转录内容。
- 普通终端模式没有规范化点击分发。键盘思考控制和既有滚轮路径仍可用；非滚轮的
  SGR 鼠标报告会被消费，不会泄漏到 composer。
- 滚动和焦点仍由 overlay 管理。点击思考标签或工具结果使用原生组件自身的展开
  状态；宽度或主题变化不会重置保留的用户选择。

## 可选 tool-display 提供者

BTW 运行时不导入也不依赖 `pi-tool-display`。它会探测宿主全局
`Symbol.for("pi-tool-display.api.v1")` 对象，并要求现有 API 的 `version` 为
`1` 且 `decorateTool` 是函数。展示相关成员是可选的，需要能力探测：

```ts
const api = readBtwToolDisplayApi();
const snapshot =
  typeof api?.getToolPresentation === "function"
    ? api.getToolPresentation("read")
    : undefined;
```

提供者是只读的。BTW 只消费 `name`、`label`、`renderCall`、`renderResult` 和
`renderShell`；它不会收到 `execute`、`prepareArguments`、`prepareLoadout`、
`parameters` 或完整的父工具定义。缺少提供者、旧版 v1 API 没有
`getToolPresentation`、工具不受支持/被禁用，或 lookup 抛错时，都会回退到 Pi
原生渲染。单个 renderer 抛错只影响该工具，不会禁用其余转录；诊断会按 API
identity、展示修订、工具和渲染阶段限频。

BTW 在每次绘制/缓存判断前比较提供者 API 对象 identity 和
`presentationRevision`。修订变化会重新解析受影响的内置工具定义并重建其展示
组件，而不是只重绘仍持有旧 renderer 闭包的组件。替换 API 对象的提供者 reload
会通过 identity 变化被检测到。工具组件自发的重绘请求也会提升展示修订并使
overlay 行缓存失效。

七种内置工具名可以接收提供者的 call/result/shell 样式。解析按字段（`renderCall`、
`renderResult`、`renderShell` 分别判定）遵循固定优先级：

1. **子会话自己的显示**：先取子会话公开的扩展 renderer 解析链
   （子会话 `extensionRunner.resolveToolRenderers(name, base)`，`base` 返回
   子会话**自己的注册定义**，因此 resolver 用 `next()` 包装子会话 renderer 时
   复现的是主会话语义，而不是父会话或提供者），再取已注册定义自带的 renderer
   字段。命中某相位的 renderer 属于子会话自定义显示，提供者不得覆盖同一相位；
   普通内置定义没有 renderer，resolver 原样返回 `next()` 时该相位仍留给提供者。
2. **提供者**：上一步没有提供该相位时，才使用 `pi-tool-display` 快照的字段。
3. **原生回退**：两者都没有时沿用子会话定义或 Pi 的默认回退。

普通内置工具定义（例如 Pi 的 `read`、`bash`）自身不携带 renderer，因此仍由提供者
补样式；同名子会话自定义 renderer（公开解析链，或扩展注册定义自带的 renderer）
优先于提供者。解析链抛错时按工具与阶段限频诊断，并回退到提供者/原生，不会中断
整个转录。七种之外的自定义子会话工具保留自己的 renderer，不会因提供者修订而
重建。对七种内置工具，提供者展示字段会叠加在子会话定义的展示副本上；子会话定义
本身永不被修改。BTW 传入自己的 `args`、`result`、`details`、`cwd` 和 streaming
状态；它绝不调用工具的 `execute`，也绝不使用父组件状态。

### 能力限制

每次提供者调用都会附带以下 scope：

```ts
capabilities: {
  executionMetadata: false,
  localWorkspace: <SSH 为 false；远程线程之后保持保守>,
}
```

- `executionMetadata: false` 阻止提供者的 write 结果 renderer 读取父会话的
  previous-content map，即使子调用恰好共享 tool-call id。它也会跳过推断出的
  空文件 diff。因此 write 只显示真实结果文本；没有结果文本时显示中性的
  `↳ write completed`，绝不会伪造 `created` 或 `overwritten` diff。
- SSH workspace 始终传入 `localWorkspace: false`，因此待处理的 edit/write
  预览不会读取本地文件，也不会伪装成远程 diff。一旦保留线程中观察到远程
  workspace，即使之后在远程工具 slot 仍存在时创建本地子会话，BTW 也会保持
  保守；只有真正的线程 reset/restore 丢弃远程历史后才恢复本地权限。
- 展示侧 tool-call id 按 BTW adapter 命名空间化。这样提供者的模块级
  spinner/state map 不会与恰好使用相同 id 的父调用冲突；转录自身的组件 key
  保留原始 id。renderer 本地 state 属于每个 BTW 组件，不与父会话共享。

## 明确的非目标

以下内容不属于本兼容层：

- 镜像整个主会话 `InteractiveMode`，或抓取其 ANSI 输出；
- 把父扩展、主题、skills、prompt templates、widgets 或快捷键加载进 BTW 子会话；
- 复制 `Thinking:` 事件标签改写或任意 Markdown transformer 链；
- 复现 group-collapse、starline/footer 布局或私有插件补丁；
- 借用父工具执行、父执行元数据或父 previous-content diff；
- 在已验收范围之外宣称：真实外部 SSH 传输、任意 Pi 版本或像素级视觉对齐（范围与
  证据见 `verification.md` 批次 4.2/4.3）。

## 维护

display adapter、ingestion 路径、tool registry、overlay 鼠标映射及其测试都是
fork-only 文件。`extensions/btw.ts` 只保留最小 seam：共享 ingestion 调用、
display resolver/render 调用、overlay `Component`/鼠标入口，以及保留的
workspace mode 回调。不要格式化该上游文件。只在真实上游 seam 变化时更新
`subtrees/pi-btw.json`，并重新运行：

```bash
.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh pi-btw
```

fork-only 文档和测试不需要 `reapplyOnSync` 条目；README 兼容性链接和上游
`btw.ts` seam 需要。
