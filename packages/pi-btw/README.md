# pi-btw

A small [pi](https://github.com/earendil-works/pi-mono) extension that adds a `/btw` side conversation channel.

`/btw` opens a real pi sub-session with coding-tool access, and it runs immediately even while the main agent is still busy.

![BTW overlay example](docs/btw-overlay.png)

## What it does

- opens a parallel side conversation without interrupting the main run
- runs that side conversation as a real pi sub-session with `read` / `bash` / `edit` / `write` tool access
- keeps a continuous BTW thread by default
- supports `/btw:tangent` for a contextless side thread that does not inherit the current main-session conversation
- opens a focused BTW modal shell with its own composer and transcript
- keeps the BTW overlay open while you switch focus back to the main editor with `Alt+/`, `Super+/`, or `Ctrl+Alt+W` (all remappable)
- keeps BTW thread entries out of the main agent's future context
- supports BTW-only model and thinking overrides without changing the main thread settings
- lets you inject the full thread, or a summary of it, back into the main agent
- optionally saves an individual BTW exchange as a visible session note with `--save`

## Install

pi-btw supports Pi 0.85.1 through 1.x.

Development dependencies target Pi 0.99.2. CI runs the tests and typecheck
against the locked dependencies, Pi 0.85.1, and the latest published Pi release
on each PR and weekly. Pi 0.99.2 requires Node.js 22.19.0 or newer.

### From npm (after publish)

```bash
pi install npm:@xzzpig/pi-btw
```

Then reload pi:

```text
/reload
```

### From a local checkout

```bash
pi install /absolute/path/to/pi-btw
```

## Usage

```text
/btw what file defines this route?
/btw how would you refactor this parser?
/btw --save summarize the last error in one sentence
/btw:new let's start a fresh thread about auth
/btw:tangent brainstorm from first principles without using the current chat context
/btw:model openai gpt-5-mini openai-responses
/btw:thinking low
/btw:inject implement the plan we just discussed
/btw:summarize turn that side thread into a short handoff
/btw:clear
```

## Commands

### `/btw [--save] <question>`

- runs right away
- works while pi is busy
- creates or reuses a real BTW sub-session instead of a one-off completion call
- continues the current BTW thread
- opens or refreshes the focused BTW modal shell
- streams into the BTW modal transcript/status surface
- on RPC/SDK hosts, displays completed inline-question responses as visible session notes instead
- composer-only `/btw` requires the TUI; pass the question inline on RPC/SDK hosts
- persists the BTW exchange as hidden thread state
- with `--save`, also saves that single exchange as a visible session note

## Overlay controls

- `Ctrl+T` 切换当前 BTW 线程的思考可见性，不修改主会话；如果终端或 Pi 核心占用了默认键，可用 `PI_BTW_THINKING_KEYS` 改键（页脚显示解析后的实际键）
- `Alt+w` toggles the overlay between the framed window layout (inset from the terminal edges) and a full-width layout
- full-width mode makes terminal Shift+drag selection capture only the dialog's own text, which is handy for copying without pulling in surrounding main-screen content
- window mode keeps the full box frame; full-width mode drops the side borders and corner glyphs (keeping only horizontal rules) so those border columns never land inside a drag selection
- `Alt+/`, `Super+/`, or `Ctrl+Alt+W` toggles focus between BTW and the main editor without closing the overlay
- `Super+/` requires a terminal that reports the Super modifier, typically through the Kitty keyboard protocol
- `Ctrl+Alt+W` remains a fallback for terminals that do not deliver either primary shortcut
- set the `PI_BTW_FOCUS_KEYS` environment variable to remap these when they conflict with your window manager or terminal
- the value is a comma-separated list of pi-tui key identifiers such as `PI_BTW_FOCUS_KEYS="ctrl+/,ctrl+alt+b"`; it replaces the defaults entirely
- identifiers combine `ctrl`, `shift`, `alt`, and `super` with a single base key (letter, digit, symbol, or named key like `enter`/`f5`); blank or invalid entries are ignored, and the defaults are kept if none are usable
- while BTW is streaming, the first `Esc` aborts the request and keeps its partial transcript visible; press `Esc` again to dismiss
- while BTW is idle, `Esc` dismisses the overlay immediately
- BTW now opens top-centered so the main session remains visible underneath it
- 全屏模式支持对可见思考/工具行进行规范化点击；普通模式保留键盘控制和滚轮，但不承诺转录行可点击
- 兼容矩阵、提供者能力探测、SSH/元数据限制和不支持效果见 [`docs/transcript-display.md`](docs/transcript-display.md)

### `/btw:new [question]`

- clears the current BTW thread
- starts a fresh thread that still inherits the current main-session context
- optionally asks the first question in the new thread immediately
- if no question is provided, opens a fresh BTW modal ready for the next prompt

### `/btw:tangent [--save] <question>`

- starts or continues a contextless tangent thread
- does not inherit the current main-session conversation
- if you switch from `/btw` to `/btw:tangent` (or back), the previous side thread is cleared so the modes do not mix
- opens or refreshes the same focused BTW modal shell
- with `--save`, also saves that single exchange as a visible session note

### `/btw:clear`

- dismisses the BTW modal/widget
- clears the current BTW thread

### `/btw:inject [instructions]`

- sends the full BTW thread back to the main agent as a user message
- if pi is busy, queues it as a follow-up
- clears the BTW thread after sending

### `/btw:summarize [instructions]`

- summarizes the BTW thread with the current effective BTW model
- always runs summarize with thinking off, even if BTW chat is using a thinking override
- injects the summary into the main agent
- if pi is busy, queues it as a follow-up
- clears the BTW thread after sending

### `/btw:model [<provider> <model> <api> | clear]`

- with no args, shows the current effective BTW model and whether it is inherited or overridden
- with values, sets a BTW-only model override
- `clear` removes the override and returns BTW to inheriting the main thread model
- if the configured BTW model has no credentials, BTW warns and falls back to the main thread model

### `/btw:thinking [<level> | clear]`

- with no args, shows the current effective BTW thinking level and whether it is inherited or overridden
- with a value, sets a BTW-only thinking override for normal BTW chat
- `clear` removes the override and returns BTW to inheriting the main thread thinking level
- changing `/btw:model` or `/btw:thinking` disposes the current BTW sub-session and applies the new settings on the next BTW prompt while preserving the hidden thread

## Behavior

### Real sub-session model

BTW is implemented as an actual pi sub-session with its own in-memory session state, transcript events, and tool surface.

- contextual `/btw` threads seed that sub-session from the current main-session
  branch while filtering out BTW-visible notes from the parent context; one
  internal boundary instruction then marks that inherited work as context only,
  so the BTW agent does not autonomously resume it
- `/btw:tangent` starts the same BTW UI in a contextless mode with no inherited main-session conversation
- BTW can inherit the main thread model/thinking settings or use BTW-only overrides via `/btw:model` and `/btw:thinking`
- `/btw:summarize` uses the current effective BTW model but keeps thinking off
- the overlay transcript/status line is driven from sub-session events, so tool activity, streaming deltas, failures, and recovery are all visible without scraping rendered output
- child prompts preserve the main session's instructions and append an authoritative list of their own tools; inherited tool/skill instructions and historical tool calls do not grant additional capabilities
- handoff commands (`/btw:inject` and `/btw:summarize`) read from the BTW sub-session thread rather than maintaining a separate manual transcript model

### Opt-in extension tools

BTW loads no extensions by default. To enable tools such as `web_search` and
`fetch_content` in `/btw`, `/side`, and `/btw:tangent`, create
`~/.pi/agent/btw.json` (or `btw.json` in your `PI_CODING_AGENT_DIR`):

```json
{
  "extensions": ["npm:pi-web-access"]
}
```

A trusted project's `.pi/btw.json` can override this list. Lists replace rather
than merge; `{"extensions": []}` disables global BTW extensions for that
project. An omitted `extensions` key inherits the global list. Untrusted
projects do not contribute configuration. Config is read when a child session
is created; use `/btw:clear` to apply changes to an existing thread.

Sources can be Pi `npm:` or `git:` packages, or local extension files/package
directories. Local paths are relative to the config file's directory. Remote
packages are resolved into a separate BTW cache under the agent directory's
`btw/` folder and can be installed on first use. Pin a source version when you
need reproducible behavior.

Only listed sources are loaded. BTW runs their lifecycle handlers headlessly
(`ctx.hasUI === false`) and exposes their tools alongside `read`, `bash`,
`edit`, and `write`, including tools registered at startup. The capability
note follows the child's active tools. Load/startup errors stop child creation
and are reported with the failing source; clear, mode/model changes, and parent
shutdown run extension cleanup before disposal.

Choose extensions that support headless sessions. Tools requiring interactive
dialogs (such as `ask_user`) need additional UI integration. BTW does not import
extension skills, prompt templates, themes, widgets, or shortcuts into its UI.
Extensions are trusted code, not sandboxed: separate package installs avoid
sharing the parent's cached extension factory, but extensions may still use
shared files or external services. A local source already registered by the
parent is rejected; use an `npm:` or `git:` source for a separate install.

`/btw:ask` ignores the `extensions` setting and never loads extension tools.
It reads only the workspace selection and retains its read-only tool set. `/btw:summarize` remains tool-free. Extension
configuration is machine/project configuration, not persisted in hidden
conversation-history entries.

### SSH workspaces

BTW uses local tools by default, even when the parent uses an SSH workspace.
The overlay identifies its workspace, and the capability note tells the child
where its tools operate. To use the active parent SSH workspace, set this in
`~/.pi/agent/btw.json` or a trusted project's `.pi/btw.json`:

```json
{
  "workspace": "ssh"
}
```

This requires `@99percentpeople/pi-ssh-remote` 0.6.2 or newer in the parent.
Do not add that package to BTW's `extensions` list. BTW uses its public transport
and remote adapter APIs directly, creates a separate connection to the parent's
selected target/port/directory, and never runs its extension factory or lifecycle
handlers. Authentication uses SSH keys, your SSH agent, and the parent's SSH
config file; BTW does not copy passwords or open password dialogs.

`/btw`, `/side`, and `/btw:tangent` expose remote `read`, `bash`, `edit`, and
`write`. `/btw:ask` exposes only remote `read`, `grep`, `find`, and `ls` and
still loads no arbitrary extensions. Connection and tool failures are reported;
there is no fallback to local operations. Local instructions and session files
remain local, and remote shells use the remote environment.

Use `/btw:clear` after changing the parent host/directory, running `/ssh-exit`,
or changing workspace configuration. An existing remote thread blocks further
operations after parent workspace changes or disconnects, and saved threads
cannot resume against a different workspace. A new SSH thread requires an active
parent SSH workspace. Set `"workspace": "local"` to select local tools explicitly.
The project setting overrides the global setting independently of `extensions`;
untrusted project settings are ignored.

### In-modal slash behavior

Type `/` at the start of the composer to see BTW-owned commands. Keep typing to
filter, use Up/Down to select, and Tab or Enter to complete a partial command.
Completion inserts the command and a trailing space without submitting. Enter on
an exact command or with arguments submits normally. Escape closes the list
first; a subsequent Escape keeps the existing abort/dismiss behavior. The menu
shares space with the transcript rather than growing the modal.

Inside the BTW modal composer, slash handling is split at the BTW/session boundary:

- `/btw`, `/side`, `/btw:new`, `/btw:tangent`, `/btw:ask`, `/btw:clear`, `/btw:model`, `/btw:thinking`, `/btw:inject`, and `/btw:summarize` stay owned by BTW because they control BTW lifecycle, configuration, or handoff behavior
- any other slash-prefixed input is routed through the BTW sub-session's normal `prompt()` path
- this means ordinary pi slash commands like `/help` are handled by the sub-session instead of being rejected by a modal-only fallback
- if the sub-session cannot handle a slash command, BTW surfaces the real sub-session failure through the transcript/status state instead of inventing an "unsupported slash input" warning

This keeps BTW-owned lifecycle commands explicit while giving the side conversation the same slash-command surface as the underlying sub-session.

## Thread state

### Hidden BTW thread state

BTW exchanges are persisted in the session as hidden custom entries so they:

- survive reloads and restarts
- rehydrate the BTW modal shell for the current branch
- preserve whether the current side thread is a normal `/btw` thread or a contextless `/btw:tangent`
- preserve the current BTW-only model and thinking overrides for that session history
- stay out of the main agent's LLM context

### Visible saved notes

If you use `--save`, that one BTW exchange is also written as a visible custom message in the session transcript.

## Why

Sometimes you want to:

- ask a clarifying question while the main agent keeps working
- think through next steps without derailing the current turn
- explore an idea, then inject it back once it's ready

## 转录显示兼容性

overlay 使用 Pi 原生消息和工具组件，并接入可选的有状态展示器。思考可以点击或
本地切换；streaming 状态会保留；保留的展开选择在缩放和关闭/重开后仍有效。加载
可选的 `pi-tool-display` 提供者时，其七种受支持内置工具的样式会通过只读能力
探测应用；BTW 不借用父执行或 previous-content 元数据，SSH workspace 禁用本地
预览读取。

本次发布准备版本为 pi-btw 0.11.1（内嵌 pi-components 0.5.0），尚未实际发布；
不要假设旧版 npm 包已经包含这些变更。完整矩阵、键位配置、提供者 API v1 探测、回退行为、SSH 限制和不支持
的插件效果见 [`docs/transcript-display.md`](docs/transcript-display.md)。

真实普通/全屏 TUI 已在隔离的 Pi 1.4.0 + 真实模型上验收（含 asciinema 回放、
显示插件启用/禁用、重开/缩放/工具失败）；本地 tarball 的真实消费者入口与内嵌
pi-components 加载也已在 `/tmp` 验证，Pi 核心仍为 peers。命令、退出码与差异结论见
[`verification.md`](../../openspec/changes/archive/2026-11-01-align-btw-transcript-presentation/verification.md)
批次 4.2/4.3。真实外部 SSH 传输、任意 Pi 版本和像素级对齐不在验收范围内。

## Development

The extension entrypoint is:

- `extensions/btw.ts`

To use it without installing:

```bash
pi -e /path/to/pi-btw
```

## License

MIT
