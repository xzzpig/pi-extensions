# Tasks: sandbox-write-denial-awareness

## 1. 还原与准备

- [x] 1.1 还原 `src/sandbox-runtime.ts` 中规划期的 pattern-zoo 编辑：`extractBlockedWritePath` 恢复 upstream 原实现；验证 `git diff` 中该函数与 upstream 一致、原有测试无需改动

## 2. 核心实现（src/sandbox-runtime.ts）

- [x] 2.1 `initializeSandbox` 传 `enableLogMonitor = process.platform === "linux"` 启用违规监控；验证 `pnpm --filter @xzzpig/pi-sandbox run check` 通过
- [x] 2.2 新增 `collectBlockedWritePaths(manager, command, sinceMs)`：查 store → 时间窗过滤 → 解析 `deny <syscall> <path>`（路径支持空格）→ 去重保序；验证单测覆盖解析/关联/时间窗/去重
- [x] 2.3 `createSandboxedBashOps` 增加可选第 4 参 `onCompleted`：命令退出后以该 exec 的精确命令串与 `startedAt` 采样交付 `collectBlockedWritePaths` 结果；不传回调时行为与现状完全一致；验证现有 exec 测试全部通过
- [x] 2.4 新增 `hasSandboxWriteDenialText(output)`（一行子串检查）与 `sandboxWriteDenialNotice(options)` 文案助手（列出被拒路径 / denyWrite 指引 / 提示被拒 / 无路径兜底四类分支）；验证文案分支单测通过

## 3. bashTool 接线（src/extension.ts）

- [x] 3.1 `runBash` 传入 `onCompleted` 闭包持住最近一次 outcome；执行后按三层递进后处理（violations 主通道 → upstream `extractBlockedWritePath` → 文本兜底），violations 主通道对首个非 denyWrite 路径复用 `resolveWritePermission` 允许→`refreshSandbox`→重跑；验证 `pnpm --filter @xzzpig/pi-sandbox run check` 与现有测试通过
- [x] 3.2 补齐终态说明：用户拒绝/超时、全部命中 denyWrite、无 UI 会话均按 spec 附加对应说明；验证文案分支单测覆盖

## 4. 单元测试

- [x] 4.1 `collectBlockedWritePaths`：假 store 验证 line 解析（含空格路径）、命令精确关联、`sinceMs` 时间窗过滤、去重保序；验证 `pnpm --filter @xzzpig/pi-sandbox test` 中新用例通过
- [x] 4.2 `createSandboxedBashOps` + mock store：onCompleted 携带该命令 violations / 无 violations 时回调收到空列表；未传回调时无副作用
- [x] 4.3 `sandboxWriteDenialNotice` 各分支与 `hasSandboxWriteDenialText` 正/负例（`Permission denied`、`No such file or directory` 不误报）

## 5. 真机 e2e（pi-plugin-e2e-test 技能）

- [x] 5.1 Level 1 冒烟：`direnv exec .` 下 /tmp 临时目录 print 模式加载 `packages/pi-sandbox/index.ts`，模型往返成功且 EXIT=0
- [x] 5.2 Level 2 tmux 允许分支：驱动 agent 写 `/var/tmp/pi-sb-e2e-<rand>.txt`（allowWrite 之外）→ pane/JSONL 断言出现沙箱说明与允许弹窗 → 按 `s` 允许 → 自动重试成功、文件落盘 → 清理
- [x] 5.3 Level 2 tmux 拒绝分支：新目标路径 → Esc 中止 → 结果含"保持阻止"说明而非裸报错；确认会话 JSONL 中 tool 结果不含未解释的 EROFS

## 6. 收尾

- [x] 6.1 CHANGELOG 0.6.2 条目 + `package.json`/`versions.json` 版本 bump
- [x] 6.2 全量验证：`pnpm --filter @xzzpig/pi-sandbox run all` + 仓库根 `pnpm exec prettier --check .` 全绿
