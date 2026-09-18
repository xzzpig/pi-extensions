# Proposal: sandbox-write-denial-awareness

## Why

在 Linux（含 WSL2）上，`pi-sandbox` 用 bwrap 的只读根挂载实现写限制，bash 中被拦截的写操作表现为内核原生 `EROFS: Read-only file system` 报错。扩展现有的检测只匹配 macOS 的 `Operation not permitted` 错误文本，因此 Linux 上既不触发已有的"提示用户→允许→重试"链路，也没有任何解释；agent 只看到原始报错，会误判为磁盘/文件系统真的只读，进而做出错误诊断（检查挂载、重装系统、放弃任务等）。对错误文本做正则匹配是下游的脆弱方案，无法覆盖各工具千差万别的报错格式。

## What Changes

- 启用 `sandbox-runtime` 自带的 Linux seccomp USER_NOTIF 违规监控（`initialize(..., enableLogMonitor=true)`）：每条沙箱命令的写意图 syscall（含内核解析出的绝对路径）被上报并按命令精确关联存入 `SandboxViolationStore`，与工具如何打印报错完全无关。
- `createSandboxedBashOps` 增加可选 `onCompleted` 回调：命令退出后带回该命令被拒写的结构化列表（时间窗过滤、解析 `deny <syscall> <path>`）。
- `bashTool` 在命令结果上按三层递进附加沙箱说明：① 违规记录命中 → 追加"报错来自 OS 沙箱而非文件系统"说明块并列出被拒路径，对首个非 denyWrite 路径复用现有交互式允许→自动重试流程；② 违规记录为空但命中既有 `extractBlockedWritePath`（macOS 路径，原样保留），用户拒绝/超时时也追加说明；③ 仅当输出含 EROFS/EPERM 报错文本时追加无路径的一般性说明（监控不可用环境的知情兜底）。
- 命中 `denyWrite` 的被拒路径不弹提示，输出"需修改配置"的明确指引；无 UI（headless child）会话只追加说明、不弹提示。
- 还原型 `extractBlockedWritePath` 的 pattern-zoo 尝试，保持 upstream 实现不动。
- 补充单元测试与真机 e2e 测试（Level 1 冒烟 + Level 2 tmux 交互验证允许/拒绝分支）。

## Capabilities

### New Capabilities

- `sandbox-write-denial-diagnostics`: 沙箱化的 bash 写被 OS 拒绝时，agent 与用户获得的诊断与授权体验——基于 seccomp 违规监控的结构化被拒路径报告、面向 agent 的沙箱归因说明、交互式允许与自动重试、denyWrite 显式拒绝指引，以及监控不可用时的文本兜底。

### Modified Capabilities

<!-- openspec/specs 中没有描述 pi-sandbox bash 拦截诊断的既有 capability，本变更为新增能力，不修改现有 requirement。 -->

## Impact

- `packages/pi-sandbox/src/sandbox-runtime.ts`：启用违规监控、新增 `collectBlockedWritePaths` 与 `onCompleted` 回调、说明文案助手。
- `packages/pi-sandbox/src/extension.ts`：`bashTool.execute` 的结果后处理链路。
- `packages/pi-sandbox/test/`：新增单元测试；`.pi/skills/pi-plugin-e2e-test` 流程下的真机 e2e。
- 依赖：仅使用既有 peer 依赖 `@xzzpig/sandbox-runtime` 的公开接口（`initialize` 第三参、`getSandboxViolationStore`、`SandboxViolationEvent`），无新增依赖。
- 已知限制（写入 design 与最终文档）：违规路径为诊断性质（上游文档注明由 `process_vm_readv` 从沙箱进程内存读取，attacker-controlled），交互式允许提示仍由人类确认；bash 中被 denyRead 隐藏的读表现为 ENOENT，监控不覆盖读操作，维持现状。
