# pi-components

Reusable, internal Pi TUI primitives for extension authors. This is a shared
library package, not a Pi extension: consumer packages bundle it into their
release tarballs instead of publishing it independently. Bundled artifacts
expose compiled runtime JavaScript and declarations from `dist/`; the
TypeScript source remains in this repository for development.

## Transcript components

`@xzzpig/pi-components/transcript` provides a bounded `SessionTranscript`
that consumes `AgentSessionEvent` values and a keyboard- and wheel-scrollable
`TranscriptViewport`. User messages, assistant text, thinking, markdown, and
code fences render through Pi's native `UserMessageComponent`,
`AssistantMessageComponent`, and `getMarkdownTheme()`; tool calls render
through Pi's native `ToolExecutionComponent` (raw `args` and structured
results are preserved verbatim so built-in tools keep their rich
main-transcript output), so embedded transcripts match the main session
instead of approximating its styling.

```ts
import {
  SessionTranscript,
  TranscriptViewport,
} from "@xzzpig/pi-components/transcript";

const transcript = new SessionTranscript({
  maxEntries: 500,
  maxChars: 512 * 1024,
  // Optional native tool context: tui, cwd, resolveToolDefinition,
  // showImages, imageWidthCells, expanded.
});
const unsubscribe = session.subscribe((event) => transcript.apply(event));

const viewport = new TranscriptViewport({
  tui,
  theme,
  readEntries: () => transcript.entries,
  assistantLabel: "Auditor",
  thinkingLabel: "Thinking",
  // Live component registry keeps incremental renderer state per tool call;
  // omit it and tool blocks still render via stateless ad-hoc components.
  toolComponents: transcript.toolComponents,
});

const visible = viewport.render(width, height);
```

`TranscriptViewport` owns follow-latest plus keyboard and SGR mouse-wheel
scrolling. Hosts keep ownership of terminal mouse-reporting setup, dialog
chrome, focus behavior, input controls, session lifecycle, and cancellation
policy. `Esc` handling is intentionally delegated to the host overlay.

### 有状态展示器（可选启用）

`@xzzpig/pi-components/transcript-presenter` 新增 `TranscriptPresenter`，供需要
真实流式状态、原生思考块点击和本地思考切换的宿主使用。上述无状态入口保持不变；
宿主通过导入第二个子路径显式启用。

展示器消费相同的 `TranscriptEntry` 值，并按用户条目保留一个原生
`UserMessageComponent`、按助手消息段保留一个原生 `AssistantMessageComponent`。
助手组件先以空内容构造，再通过 `updateContent(message, streaming)` 接收内容，因此
Pi 的原生流式状态会到达宿主侧补丁（例如 `pi-thinking-collapse`），而不是先渲染
一条已完成消息。只有段落文本或流式标志变化时才重新赋值内容；缩放和纯重绘保留组件
及其逐块点击状态。

```ts
import { SessionTranscript } from "@xzzpig/pi-components/transcript";
import { TranscriptPresenter } from "@xzzpig/pi-components/transcript-presenter";

const transcript = new SessionTranscript();
const presenter = new TranscriptPresenter({
  theme,
  // 复用 transcript 注册表，让工具 renderer 状态和展开点击跨帧保留。
  // 仅在只读回放时省略；此时工具块回退为无状态的临时组件。
  toolComponents: transcript.toolComponents,
  assistantLabel: "Assistant",
  // 省略 thinkingLabel 可保留 Pi 原生的 `Thinking...` 标签，折叠补丁会把
  // 它替换成自己的 “click to expand” 提示。
});
presenter.attachTui(tui);
// 把 renderer 发起的工具重绘接到展示器修订号上。
transcript.toolComponents.attachTui({
  requestRender: () => presenter.requestRender(),
});

// 宿主的 transcript 版本变化时（或简单宿主每帧一次），渲染前先 sync。
// 对未变化条目的重复 sync 只做内容比较，不会改动展示修订号。
presenter.sync(transcript.entries);
const frame = presenter.render(innerWidth);
const visibleLines = frame.lines.slice(scrollOffset, scrollOffset + height);

// 鼠标路由：把可见视口行加上 scroll offset 换算到完整 transcript 空间，
// 再交给展示器分发。
const handled = presenter.handleMouse({
  ...mouseEvent,
  y: mouseEvent.y - overlayChromeTop + scrollOffset,
});

// BTW 本地统一思考切换（在 overlay 绑定 Ctrl+T；不写 Pi 设置，也不碰主会话）。
const thinkingVisible = presenter.toggleThinkingVisibility();
```

`sync(entries)` 只更新发生变化的段，并清理条目已消失的组件。`render(width)` 返回
渲染行以及 `frame.rows`（组件行范围）、`frame.totalLines` 和 `frame.revision`；
宿主缓存应比较 `frame.revision` 与宽度。展示器自身的缓存会在条目变化、宽度变化、
`invalidate()`（主题变化）、思考切换和 `requestRender()`（组件发起的重绘）时失效。

鼠标处理使用 Pi 公开的 `Component.handleMouse` 路径：展示器把转录行映射到所属
原生组件，减去该行的 `top`，再转发事件。这样无需读取组件私有字段，即可保留 Pi
原生的逐块思考点击与工具展开。

思考控制：

- `thinkingVisible` 反映展示器的本地偏好。展示器初始为 `auto`：没有宿主补丁时
  Pi 原生默认展开；存在折叠补丁时，流式内容保持可见，完成的消息折叠。
- `setThinkingVisible(visible)` 把显式本地偏好应用到每个保留的助手组件。隐藏使用
  Pi 公开的 `setHideThinkingBlock(true)`，因此会清除原生的逐块覆盖。显示时先通过
  同一个公开 setter 强制到已知的折叠状态，再通过原生思考 `MouseRegion`（经公开
  的 `Container.children` 取得）分发一次点击。这会设置与用户点击相同的逐块覆盖，
  因此即使宿主折叠补丁持续自动折叠，已完成消息也会展开。流式标志从不伪造，不读取
  组件私有字段，也不修改折叠补丁。
- 新段继承显式的可见偏好：首次内容更新后，展示器应用相同的原生点击路径。
- 之后对某个思考块的真实点击仍然只切换该块，且该覆盖在内容更新、主题失效和缩放后
  保持。
- `toggleThinkingVisibility()` 翻转偏好并返回新的可见性。从初始 `auto` 状态开始，
  第一次切换隐藏，下一次展开所有保留的块。
- 该偏好只属于本展示器。它绝不写入 Pi 设置，也不改变主会话的思考偏好。

在 `AssistantMessageComponent` 没有思考 `MouseRegion` 的宿主（较旧的 Pi）上，
显示会降级为公开的 `setHideThinkingBlock(false)` 调用；内容与键盘切换仍然可用，
但宿主折叠补丁仍可再次折叠已完成消息。

生命周期：

- `attachTui(tui)` / `detachTui()` 接通重绘转发。分离已关闭的 overlay 会保留线程
  状态，包括展开选择。
- `invalidate()` 为主题变化重新渲染原生组件，而不重新初始化宿主全局主题。
- `clear()` 在线程被清空时丢弃保留的消息组件与布局。
- `dispose()` 释放组件、分离 TUI，并让后续调用变为 no-op；在线程/会话本身销毁时
  使用。

当宿主侧补丁自动折叠已完成的思考（例如 `pi-thinking-collapse`）时，展示器保留该
补丁的流式与完成行为及其原生逐块点击覆盖。统一切换通过原生点击路径为保留块显式
覆盖该自动折叠，新块继承该显式偏好。没有此类补丁时，已完成的思考遵循 Pi 原生
默认值（展开），本地切换会展开/收起每个保留块。

### History replay

Hosts that rebuild a transcript from persisted records write entries through
the public builder API (`appendEntry`, `ensureTurn`, `finishTurn`,
`removeTranscriptTurn`, `ensureToolCall`, `upsertToolResult`, `appendNotice`).
Text needs two different shapes:

- `upsertText` merges per turn (latest wins) — for one message observed
  repeatedly, e.g. live `message_update` records.
- `appendText` / `appendAssistantMessage` never merge — for replaying several
  finished assistant messages, so every thinking block and answer stays
  visible instead of collapsing into the last one.

```ts
const turnId = ensureTurn(state);
appendAssistantMessage(state, turnId, {
  thinking: "first pass",
  text: "writing the patch",
});
// later messages in the same turn stay separate entries
appendAssistantMessage(state, turnId, { thinking: "verify", text: "done" });
```

`renderTranscriptLines`/`TranscriptViewport` accept `hideThinkingBlock` (with
`thinkingLabel` as the collapsed label) so a host can present replayed thinking
collapsed and offer its own expansion gesture; omitted keeps Pi's default
(expanded).

The transcript normalizes user/assistant events, streaming thinking and text,
tool calls and results, and automatic retry notices. It bounds retained history
(entries and total chars — raw tool data is uncapped by design) and sanitizes
untrusted terminal control sequences in message text before rendering. Pi core
packages are peer dependencies, so installed extensions use the same Pi runtime
and active theme as their host.
