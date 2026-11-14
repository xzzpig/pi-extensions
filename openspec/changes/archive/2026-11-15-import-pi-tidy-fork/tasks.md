# Tasks

## 1. 导入与元数据

- [x] 1.1 用 `pi-upstream-subtree` 流程把 `Andy8647/pi-tidy` 以 squash 方式导入 `packages/pi-tidy`；验证：`git log` 出现 squash 提交且带 `git-subtree-dir`/`git-subtree-split` trailer，`packages/pi-tidy/package.json` 可解析。
- [x] 1.2 新建 `subtrees/pi-tidy.json`，写入 name/prefix/source/remote/ref/version/upstreamCommit/reapplyOnSync/knownDebt；验证：`direnv reload` 通过 schema 校验，`PI_UPSTREAM_PI_TIDY*` 环境变量已导出。
- [x] 1.3 把包身份改为 `@xzzpig/pi-tidy`（`name`、`repository.url` 指向本仓库，保留上游 homepage/bugs 来源说明）；验证：`node -e "console.log(require('./packages/pi-tidy/package.json').name)"` 输出 `@xzzpig/pi-tidy`，`pnpm install` 成功。
- [x] 1.4 在 `pnpm-workspace.yaml` 为 `@xzzpig/pi-tidy` 增加 Pi 1.5 `overrides`；验证：`pnpm install --frozen-lockfile` 退出 0，且 `pnpm --filter @xzzpig/pi-tidy run typecheck` 不因 `registerToolRenderer` 缺失而报错。

## 2. 二开骨架

- [x] 2.1 新建 `fork/defaults.ts`：导出 `ForkTidyConfig`（在上游 `TidyConfig` 上增加 `frameTools: boolean`）与 `applyForkDefaults()`，关闭工具框、整轮折叠、工具分组、并排 diff、bash 高亮、背景任务行、选区清洗、逐工具边框色；开启消息框（以支持 `userMessageStyle: "frame"`，并接受一般消息框也同时绘制），保留错误行去重、hex 色块、最终回复框、代码块分节；验证：fork-only 单测断言上述每一项的取值，并断言上游 `loadConfig()` 的 `DEFAULTS` 未被修改。
- [x] 2.2 新建 `fork/install.ts`：`frameTools` 为 `true` 时调用上游 `patchToolBoxFrames`，为 `false` 时跳过该补丁但单独调用上游 `installHoverTracking()`；验证：fork-only 单测用替身断言两种分支各自调用了哪些上游函数。
- [x] 2.3 在 `src/index.ts` 打两行接缝（导入 fork 模块、把 `loadConfig()` 与 `patchToolBoxFrames(...)` 换成 fork 调用）；验证：`git diff --stat` 显示 `src/` 下仅 `index.ts` 变更，且改动不超过导入与调用两处。
- [x] 2.4 编写 fork-only 测试覆盖 `frameTools` 开/关与 fork 默认值；验证：`pnpm --filter @xzzpig/pi-tidy test` 全绿。
- [x] 2.5 写 `FORK-CHANGELOG.md` 与 `README.md` 的 fork 段落，说明二开范围、`frameTools` 语义、被关闭的上游能力与替代配置，并写明前置条件：需把 `pi-tool-display` 的 `enableNativeUserMessageBox` 设为 `false`，否则两个插件会同时绘制用户消息；验证：文档列出的配置键与 `fork/defaults.ts` 实际取值逐条一致，且包含该前置配置。

## 3. 上游测试与分歧门禁

- [x] 3.1 运行上游完整测试套件并记录基线；验证：记录通过/失败清单，确认 `loadConfig` 相关测试全部通过。
- [x] 3.2 对因 fork 默认值而失败的上游行为测试做最小调整（只改测试，不改上游实现）；验证：`pnpm --filter @xzzpig/pi-tidy test` 全绿，且 `src/` 除 `index.ts` 外仍与上游字节一致。
- [x] 3.3 在 `subtrees/pi-tidy.json` 记录 `reapplyOnSync` 与实际存在的 `knownDebt`（无债务时省略空数组）；验证：`pnpm run audit:fork-divergence` 中 pi-tidy 报告 `undeclared=0 stale=0`。

## 4. 自动化 e2e 套件

- [x] 4.1 建 `packages/pi-tidy/test/e2e/harness.ts`：提供隔离的 HOME 与 `settings.json`、假 `pi`/`ctx`、按序加载多个扩展并返回各自的注册项与 patch 状态快照；验证：harness 自测能加载单个扩展并读到其注册的 command/tool。
- [x] 4.2 在 `packages/pi-tidy/package.json` 增加 dev-only `tsx` 与 `test:e2e` script（`tsx --test test/e2e/*.e2e.ts`，以支持跨包 TypeScript entry 的 `.js` specifier，且通过显式 unit-test globs 将这些 e2e 文件排除在默认 `node --test` 之外）；并在根 `AGENTS.md` 的验证段落补一行命令；验证：`pnpm --filter @xzzpig/pi-tidy run test:e2e` 退出 0。
- [x] 4.3 工具框不 patch 的 e2e：按 `pi-tool-display → pi-group-collapse → pi-thinking-collapse → pi-starline → pi-tidy` 顺序加载，断言 `ToolExecutionComponent.prototype.render` 未被 pi-tidy 打标，而 `installHoverTracking` 已安装；验证：断言通过，失败信息能指出冲突插件。
- [x] 4.4 补丁链可组合的 e2e：按既定顺序加载扩展，构造含思考块与最终文本的回复，断言 Pi 原生折叠提示位于 pi-tidy 最终回复框外，点击可展开/重新折叠；卸载 pi-tidy 后重渲染，断言 `pi-group-collapse` 的折叠仍生效且不抛错；验证：三条断言通过。
- [x] 4.5 删除前基线快照：断言当前 `UserMessageComponent.prototype.render` 的 patch 链同时包含 `pi-starline` 与 `pi-tidy` 两段，并把链结构写成快照；验证：快照文件生成，供 7.1 删除后对比。
- [x] 4.6 配置迁移与降级的 e2e：旧 Starline 键的迁移提示集成断言推迟到 7.1（移除 Starline 后，避免在 Starline 仍读取这些键时误判）；删除前先断言宿主私有接口 `InteractiveMode.init` 缺失时不抛错且只提示一次；验证：删除前降级断言通过，7.1 再验证旧键提示文案与去重次数。
- [x] 4.7 纯渲染能力的 e2e：断言 cleanCopy 输出不含框线/rail/横线；hex 色块对 `#7f849c` 与 `rgb(...)` 生效、围栏代码块内不生效；代码块分节把两条围栏换成横线并带语言标签；验证：字符串断言全绿。
- [x] 4.8 错误行去重的 e2e：向错误行钩子注入三条相同错误行，断言输出为一行带 `×3`；再注入一条 warning，断言原样显示不加框；验证：断言通过。

## 5. 真机证据包（删除前闸门）

> 本轮**不加载 `pi-starline`**：它没有开关可以关掉自绘用户消息，混在一起录出来的观感无法判断 `pi-tidy` 本身。删除后的全量证据包在 7.2。

- [x] 5.1 建 `artifacts/pi-tidy/e2e/<date>/`，写 `test-config.json`（含 `"enableNativeUserMessageBox": false`、`tidy.frameTools: false`、`tidy.userMessageStyle: "frame"`）与 `git-fingerprint.txt`；验证：fingerprint 与 `git rev-parse HEAD` 一致。
- [x] 5.2 按 `pi-plugin-e2e-test` 用 tmux + asciinema 录制五个场景：用户消息外观、干净复制、代码块复制控件的悬停与点击、错误行去重、最终回复框与思考折叠共存；最后一个场景需加载 `pi-thinking-collapse`、禁用的 `pi-tool-display` wrapper、`pi-group-collapse` 与 `pi-tidy`（不加载 `pi-starline`），并验证折叠提示在最终框外、原生点击可展开/折叠；每个场景一个 `.cast` 文件，`asciinema play` 可回放。
- [x] 5.3 写 `analyze-cast.mjs`，从 cast 提取断言：用户消息框线层数为 1、错误行只有一行且带 `×N`、hex 色点出现、复制结果中不出现 rail/框线；验证：脚本对每个 cast 输出 PASS/FAIL，且在一个人工构造的坏样本上能输出 FAIL。
- [x] 5.4 写 `manifest.json` 与 `report.md`：场景 ↔ cast 文件 ↔ 断言结果一一对应，并记录被测 commit、Pi 版本与终端尺寸；验证：manifest 中的 cast 文件名与目录实际文件一致。
- [x] 5.5 在同一 commit 上重跑 5.2–5.4 确认可重复；验证：两次 `analyze-cast.mjs` 结论一致。

## 6. pi-starline 移除（仅在 4、5 全部通过后执行）

- [x] 6.1 删除 `extensions/starline/user-message.ts`、`mouse/transcript-copy.ts`、`mouse/fork-transcript-copy.ts`；验证：`grep -rn "installUserMessageStyle\|cleanForkTranscriptRows\|cleanTranscriptRows" packages/pi-starline/extensions` 无结果。
- [x] 6.2 移除 `index.ts`、`prototype-patch-registry.ts`、`mouse/index.ts` 中的四处接缝；验证：`pnpm --filter @xzzpig/pi-starline run typecheck` 退出 0。
- [x] 6.3 移除 `userMessagePaddingY`、`colors.userMessageBorder`、`colors.userMessageText`、`colorSources.userMessages`、`mouse.transcriptCleanCopy` 的类型/默认值/规范化，以及 `settings-command.ts` 的 `userMessages` 分支；验证：typecheck 通过，且 `grep -rn "userMessagePaddingY\|colorSources.userMessages" packages/pi-starline/extensions` 仅剩迁移提示中的字符串字面量。
- [x] 6.4 采纳上游 `warnMovedUserMessageKeys` 并接入 `loadConfig`；验证：新增测试断言配置含旧键时每次进程只提示一次，且提示文案包含已迁移的键名。
- [x] 6.5 删除 `test/fork-user-message-retention.test.ts`、`test/user-message-colors.test.ts`，调整 `config.test.ts` 与 `extension-compliance.test.ts` 中相关断言；验证：`pnpm --filter @xzzpig/pi-starline test` 全绿。
- [x] 6.6 更新 `packages/pi-starline/README.md` 与 `FORK-CHANGELOG.md`，删除用户消息与干净复制的自有能力描述，改指向 `tidy.*` 配置，并写明需自行关闭 `pi-tool-display` 的 `enableNativeUserMessageBox`；验证：文档中不再出现 pi-starline 自绘用户消息的说法，且包含该前置配置。

## 7. 删除后回归与全量门禁

- [x] 7.1 重跑 `pnpm --filter @xzzpig/pi-tidy run test:e2e`：把 4.5 的 patch 链快照改为期望值——`UserMessageComponent.prototype.render` 只剩 `pi-tidy` 一段，`pi-starline` 不再出现在链上；验证：快照对比通过，其余 4.3–4.8 断言仍全绿。
- [x] 7.2 录制删除后的全量证据包（五个插件全部加载）到 `artifacts/pi-tidy/e2e/<date>-final/`；验证：`analyze-cast.mjs` 全部 PASS，且用户消息框线层数为 1（无嵌套）。
- [x] 7.3 更新 `subtrees/pi-starline.json`：删除 `reapplyOnSync` 第 17 条（32→31），复核 `knownDebt` 无失效条目；验证：`direnv reload` 通过，`pnpm run audit:fork-divergence` 报告 `undeclared=0 stale=0`。
- [x] 7.4 更新 `versions.json`、根 `README.md` 包列表与 `AGENTS.md` 的包数量/验证命令；验证：JSON 可解析，`pnpm exec prettier --check .` 退出 0。
- [x] 7.5 跑全量门禁：`pnpm --filter @xzzpig/pi-tidy run typecheck`、`test`、`test:e2e`，各相关包 `test`，`pnpm run audit:fork-divergence`，`pnpm exec prettier --check .`；验证：全部退出 0，并在任务记录中写明每条命令的退出码。

## 8. 扩展：全量组合错误重试渲染修复

- [x] 8.1 复现并定位五插件全量组合下两次受控 429 显示两个 `error ×2` 上边框的根因；验证：受控 provider 真机录屏复现，自动化脚本单次渲染即复现双上边框。
- [x] 8.2 经用户批准在 pi-tidy 加最小上游分歧：`src/tools/tool-group-view.ts` 的边界包装器加组件级重入守卫（`BOUNDARY_ACTIVE`），只有最外层包装器执行 restyle、内层直接透传；验证：`plugin-composition.e2e.ts` 新增五插件组合下“两个相同重试错误只画一个 `error ×2` 框”断言，去掉守卫时该断言失败、恢复后通过；`subtree` 的 reapplyOnSync 与 FORK-CHANGELOG 记录该分歧。
- [x] 8.3 五插件全量重录错误去重真机证据并更新 `artifacts/pi-tidy/e2e/2026-11-14-final/`；验证：只显示一个 `error ×2` 框，`analyze-cast.mjs` 全 PASS，manifest/report/test-config 与 cast 一致。
- [x] 8.4 复跑门禁并记录退出码（pi-tidy、pi-starline、pi-group-collapse、审计、prettier）；验证：全部退出 0。

## Workflow follow-up

- 归档本 change（`openspec archive import-pi-tidy-fork`）。
- 由用户决定是否 push 与发布；本次流程不授权推送或发布。
