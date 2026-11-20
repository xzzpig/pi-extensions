# Fork Changelog

Release history for `@xzzpig/pi-tool-display`; version headings refer only to this fork.
Upstream history: [CHANGELOG.md](./CHANGELOG.md).
Current upstream baseline (not a claim about older releases): [0.5.0 / 91cef7580078](https://github.com/MasuRii/pi-tool-display/tree/91cef7580078371f8dc49a8607222807ad6a424d).

Historical entries below were migrated from the repository's existing changelogs; missing dates and historical baselines have not been invented.

## [0.3.4] - 2026-11-20

### Performance

- 发布包预打包扩展入口，减少 Pi 启动时逐个解析、加载 TypeScript 模块的开销；Pi 核心与共享 diff 依赖保持外置。

## [0.3.3] - 2026-11-19

### Fork changes

- 编辑与写入差异共用私有 `pi-components/diff` 排版核心，并在独立安装包中携带其编译产物；保留原有视图配置与展示。

## [0.3.2] - 2026-11-15

### 文档

- 工具展示提供者契约（`docs/tool-presentation-provider.md`）成为单一来源：补齐类型签名、生命周期、七个上游接缝、能力门禁与降级矩阵；README 只保留摘要与链接。
- 修正 API 取用示例为真实的 `Symbol.for("pi-tool-display.api.v1")` 全局符号（旧示例引用的 consumer 模块不存在）。
- 如实记录 pi 1.5.2 的实测行为：`getToolPresentation("bash")` 返回 `undefined`（native bash 为 `source=builtin` 且无 `renderResult`），其余六个内置工具返回快照；消费者必须按 `undefined` 降级。

## [0.3.1] - 2026-11-01

### 修复与改进

- 在现有 API v1 增加可选只读 getToolPresentation 与 presentationRevision，支持七种内置工具的展示快照，不共享执行能力。
- 按安装实例绑定提供者，支持配置修订、reload/dispose 与只读消费端类型；增加本地预览和父执行元数据拒借能力，缺失元数据时使用实际结果文本回退。

## [0.3.0] - 2026-09-28

### Added

- `bashCommandDisplay` config option (`"full" | "collapsed" | "auto"`, default
  `"full"`) controlling the bash tool-call command line: `collapsed` folds
  multi-line commands onto one line and clamps it to the width available to the
  tool row with `…`, while `auto` shows the full command while it is running
  (`executionStarted && isPartial`) and collapses it once it finishes, including
  on failure. Expanding the row with `ctrl+o` always restores the original
  multi-line command, and the `$` prefix, spinner, elapsed time, `[shell: …]`,
  and `(timeout …)` hints are preserved. Collapsing is presentation only: the
  executed command is never modified.
- Fork-only `src/bash-command-display.ts`: `BashCommandLineText` (a `Text`
  subclass that clamps at `render(width)`, so the line fits the message box and
  not just the terminal), `foldBashCommandToSingleLine`,
  `clampBashCommandLineToWidth`, `resolveBashCommandDisplayWidth` (render width
  → `process.stdout.columns` → 120-column fallback), `shouldCollapseBashCommand`,
  and `resolveBashCommandDisplayArgs`.
- `tests/bash-command-display.test.ts` covering the config contract, the three
  modes, truncation, the expanded override, component reuse, the config summary,
  the settings inspector, and preset detection.

### Changed

- `bashCommandDisplay` is configurable from the interactive settings inspector
  (search term `multiline`) and documented in the README config table, the
  "Bash Command Line Display" section, and the example config.
- Defaults and preset profiles keep `bashCommandDisplay: "full"`, so existing
  configurations render exactly as before.

## [0.2.0] - 2026-09-28

### Added

- `kind: "bash"` decoration kind in the tool display adapter API: decorates a
  registered bash tool with the compact bash renderer (spinner + elapsed time
  while running, configurable `bashOutputMode` result display) without touching
  execution. The bash result rendering logic is shared with the built-in bash
  tool override.
- `bashOutputMode: "auto"`: while a bash command runs, the result area streams
  a live tail preview of the last `bashCollapsedLines` lines; when the command
  finishes, it auto-collapses to a line count ("↳ N lines returned") with
  Ctrl+O to expand. Implemented as a fork-only `resolveBashAutoOutputMode`
  normalizer (`src/bash-auto-mode.ts`) so the upstream mode dispatch stays
  untouched.

## [0.1.2] - 2026-09-19

### Changed

- **Conflict-surface refactor, no behavior change.** The fork's tail live-preview hint functions were folded into the upstream `formatTruncationHint`/`buildPreviewText` via optional, default-valued parameters (`label`, `take: "head" | "tail"`), removing the duplicated fork copies and an unreachable empty-lines branch.
