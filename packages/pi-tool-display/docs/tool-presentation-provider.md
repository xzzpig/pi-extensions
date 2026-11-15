# 工具展示提供者（fork-only 契约）

`pi-tool-display` 为其覆盖的内置工具提供只读的展示查询。在主转录之外绘制工具调用
的消费者（BTW overlay）可以复用主会话的 renderer，而不会借用任何执行能力。行为
契约位于 openspec（`transcript-builder-api`，变更
`align-btw-transcript-presentation`）；本文档是面向消费者的摘要。

## API 版本与能力探测

提供者是既有 `pi-tool-display.api.v1` 全局 API 的可选扩展。`version` 保持为
`1`，`decorateTool` / `registerAdapter` / `unregisterAdapter` 均未改变。使用前先
探测；能力缺失时回退到 Pi 原生渲染：

```ts
// 消费者按全局符号取 API，不 import 本包（缺失时就是普通降级）。
const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const api = (globalThis as Record<PropertyKey, unknown>)[TOOL_DISPLAY_API_KEY] as
  | { getToolPresentation?(name: string): unknown; presentationRevision?: number }
  | undefined;

const presentation =
  typeof api?.getToolPresentation === "function"
    ? api.getToolPresentation("read")
    : undefined;

// presentation === undefined 表示：用消费者自己的定义或 Pi 原生工具渲染。
```

`pi-tool-display` 未加载时该全局符号不存在（`api === undefined`）；安装的是旧版本
插件时，它可能只带 `decorateTool`/`registerAdapter`，两个展示成员仍为 `undefined`。
两种情况都降级为原生渲染。pi-btw 的 `btw-transcript-display.ts` 就是按这个符号读取
的消费者。

## 类型签名

`src/tool-presentation.ts` 是这些类型的来源（fork-only 模块）：

```ts
interface ToolPresentationDisplayCapabilities {
  localWorkspace?: boolean;    // 默认 true：允许读 cwd 下的本地文件
  executionMetadata?: boolean; // 默认 true：允许读父会话执行元数据
}

interface ToolPresentationRenderContext {
  args?: Record<string, unknown>;
  toolCallId?: string;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  isError?: boolean;
  capabilities?: ToolPresentationDisplayCapabilities;
  [key: string]: unknown;
}

type ToolPresentationRenderCall = (
  args: Record<string, unknown>,
  theme: Theme,
  context: ToolPresentationRenderContext,
) => Component;

interface ToolPresentationResult {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}

type ToolPresentationRenderResult = (
  result: ToolPresentationResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolPresentationRenderContext,
) => Component;

interface ToolPresentationSnapshot {
  readonly name: string;
  readonly label?: string;
  readonly renderCall?: ToolPresentationRenderCall;
  readonly renderResult?: ToolPresentationRenderResult;
  readonly renderShell?: "default" | "self";
}

interface ToolPresentationApi {
  getToolPresentation(name: string): ToolPresentationSnapshot | undefined;
  readonly presentationRevision: number;
}
```

`ToolPresentationApi` 以两个可选成员挂到既有 `pi-tool-display.api.v1` 对象上，因此
`version` 仍为 `1`；`ToolPresentationProvider`（含 `record`/`dispose`）不导出给消费
者，只在本扩展内部使用。

## 生命周期

1. **安装**：扩展启动时创建 API 对象并 `attachToolPresentationApi(api, getConfig)`，
   provider 实例绑定到该 `ExtensionAPI`（`bindToolPresentationOwner`）。
2. **登记**：每注册一个内置工具，`recordToolPresentation(pi, tool)` 截取白名单字段；
   被禁用的内置工具、非内置名称不登记。
3. **修订**：登记表变化（注册/处置）或生效展示配置变化时 `presentationRevision`
   递增；配置签名是规范化生效配置的 JSON 序列化。
4. **处置**：扩展 dispose/cleanup 调 `disposeToolPresentationApi`，只清空本实例的
   快照表，其他安装实例不受影响。
5. **渲染**：每次 render 读取当时的生效配置，无需重新注册工具。
6. **能力解析**：`resolveToolPresentationCapabilities(context)` 在 `renderCall`
   （本地待处理预览）与 `renderResult`（父执行元数据）两个入口各解析一次。

## 与上游文件的接缝

provider 本体是 fork-only 模块；上游 `src/tool-overrides.ts` 只保留七个调用点：

| # | 接缝 | 作用 |
| --- | --- | --- |
| 1 | `installToolDisplayApi` 内 `attachToolPresentationApi(api, getConfig)` | 把可选成员挂到 v1 API |
| 2 | 安装后 `bindToolPresentationOwner(pi, api)` | 绑定到本次安装 |
| 3 | 注册包装内 `recordToolPresentation(pi, tool)` | 截取白名单快照 |
| 4 | cleanup `disposeToolPresentationApi(api)` | 处置本实例快照 |
| 5 | `renderCall` 路径 `resolveToolPresentationCapabilities` | `localWorkspace` 门禁 |
| 6 | `renderResult` 路径 `resolveToolPresentationCapabilities` | `executionMetadata` 门禁 |
| 7 | provider 内的 `getConfig` 闭包 | 生效配置来源 |

新增字段时只改 fork-only 模块与这两处能力解析，不要把这些逻辑写进上游 renderer。

## 支持的工具

白名单是 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`，但**快照只在扩展
真正接管了该工具渲染时存在**。实测（pi 1.5.2）：`read`/`edit`/`write`/`grep`/
`find`/`ls` 返回快照；`bash` 返回 `undefined`。同一时刻 `pi.getAllTools()` 里
`bash` 的 `sourceInfo.source` 是 `builtin`、`renderResult` 不存在，即 provider 没有收到
bash 的登记（具体原因未在本轮定位；这是既有行为，与本次文档整理无关）。

因此消费者必须把 `undefined` 当常态处理（回退到原生渲染），不要假设七种工具都可用。
其他情况也返回 `undefined`：插件配置禁用（`enabled: false` 或
`registerToolOverrides[name]: false`），或该工具已由另一个扩展接管。

## 快照是只读的

`getToolPresentation(name)` 返回该白名单的全新副本：

- `name`、`label`
- `renderCall`、`renderResult`
- `renderShell`

它绝不包含 `execute`、`prepareArguments`、`prepareLoadout`、`parameters`、prompt
元数据或完整工具定义。renderer 引用是主会话注册的 renderer 本身（不是副本），
消费者必须把它们当作只读，且不得调用该工具的执行路径。修改返回对象不会改变已注册
的定义。

## 当前配置与修订号

renderer 在渲染时读取当前生效的插件配置；配置变化在下一次渲染即生效，无需重新注册
工具。

`presentationRevision` 在快照表变化（注册、dispose）以及生效展示配置变化时递增。
消费者在每次绘制/缓存判断前必须同时比较 API 对象 identity **和** 修订号；修订号
变化意味着缓存行必须重新渲染。该计数器在一个 provider 的生命周期内单调递增，因此
扩展 reload 还需要 identity 比较。配置签名是规范化生效配置的 JSON 序列化结果。

## 消费者授予的展示能力

在渲染 context 上传入 `capabilities` 以控制本地副作用。两个标志默认都是 `true`，
从而保持主会话宿主行为不变。

| 能力                | 默认值 | 控制内容                                                                                         |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `localWorkspace`    | `true` | renderer 可以读取 `cwd` 下的本地文件系统，用于待处理的 `edit`/`write` 预览。                     |
| `executionMetadata` | `true` | renderer 可以使用父会话记录的执行元数据（按 tool call id 索引的 `write` previous-content map）。 |

```ts
const snapshot = api?.getToolPresentation?.("edit");
const component = snapshot?.renderCall?.(args, theme, {
  args,
  toolCallId,
  cwd,
  argsComplete: true,
  isPartial: true,
  capabilities: { localWorkspace: false, executionMetadata: false },
});
```

## SSH / 远程工作区

远程工作区必须传入 `capabilities.localWorkspace: false`。此时待处理的 `edit`/`write`
预览只根据传入的 args 渲染调用摘要；renderer 绝不读取本地文件，也绝不从本地 cwd
伪造远程 diff。纯参数/结果渲染（调用行、结果文本、根据传入 `details` 构建的 diff）
仍然可用。

## 内嵌消费者与执行元数据

渲染并非自己执行的工具调用（例如 BTW 的子会话调用）的消费者必须传入
`capabilities.executionMetadata: false`。这是显式拒绝机制，不是提示：`write` 结果
renderer 会完全跳过父会话的 previous-content map，因此即使 `toolCallId` 恰好相同，
也不会泄漏父会话的文件内容。

由于没有可信元数据就无法得知 previous-content diff，被拒绝的路径同时跳过推断出的
“空 previous 文件” diff：它渲染真实工具结果文本，或在结果没有文本时渲染中性的
`↳ write completed` 行。它绝不会为可能已被覆盖的文件显示 `created`/`overwritten`
标题或全新增 diff。结果来自消费者自己的 result/details，绝不来自冒充执行结果的
args 内容，也绝不来自父 map。

消费者还应使用自己会话的 tool call id 作为 `toolCallId`，这样 renderer 本地
spinner 状态就不会与同 id 的父调用共享。

## 降级矩阵

| 情况                                           | 行为                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| provider 缺失或旧版插件没有该能力              | 全局符号不存在，或 API 对象没有 `getToolPresentation`；按原生渲染。                                |
| 不支持的工具名、被禁用的内置工具、外部扩展接管 | `getToolPresentation(name)` 返回 `undefined`；按原生渲染。                                          |
| `localWorkspace: false`                        | 没有本地待处理预览；只有调用摘要。                                                                  |
| `executionMetadata: false`                     | 没有父 previous-content map，也没有推断的 create diff；使用真实结果文本或中性 `↳ write completed`。 |
| 参数不完整或结果尚未流式完成                   | 没有待处理预览（renderer 的正常规则）。                                                             |
| 单个 renderer 抛错                             | 消费者隔离该错误并只对那个工具回退；其他工具继续渲染。                                              |

任何能力拒绝都不会伪造元数据、读取父会话状态或调用工具的 `execute`。

## 消费者责任

- 传入消费者自己的 `args`、`result`、`details`、`cwd` 和流式标志；绝不复用父会话
  对象。
- 缓存渲染行前读取 API identity + `presentationRevision`。
- 把快照和 renderer 视为只读。
- 使用消费者作用域的 `toolCallId`。

## 兼容性

旧版 `decorateTool` API 保持原有行为，仍是 `api.v1` 唯一必需成员；展示相关成员是
可选的，需要能力探测。主会话自身的渲染不受影响：它调用 renderer 时不传
`capabilities`，因此两个标志保持 `true` 默认值。

这些可选成员自 `@xzzpig/pi-tool-display` 0.3.1 起提供（见 `CHANGELOG.md`），
旧版 0.3.0 不包含它们。无论安装版本如何，消费前都先做能力探测。
