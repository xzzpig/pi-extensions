# Design: sandbox-write-denial-awareness

## Context

pi-sandbox 的 bash 沙箱由 `@xzzpig/sandbox-runtime` 提供：Linux 上 bwrap 以 `--ro-bind / /` 起步、再对 allowWrite 路径做可写 bind，因此 allowWrite 之外的写被内核以 EROFS 拒绝；macOS 上 sandbox-exec 以 EPERM 拒绝。工具层报错格式因命令而异（bash/zsh/dash 重定向、coreutils、Node errno 等）。

runtime 上游已内置一套与报错文本无关的诊断机制，但 pi-sandbox 从未启用：

- `initialize(runtimeConfig, askCallback?, enableLogMonitor=false)`：第三参为真时在 Linux 启动 `startLinuxSandboxViolationMonitor` —— 宿主进程内建 unix socket 监听器；每条沙箱命令的 `apply-seccomp`（Linux wrap 路径必然运行，vendor 已带 x64/arm64 二进制；`allowAllUnixSockets` 默认关闭）连接该 socket，逐行上报**每次写意图 syscall**（syscall 名、内核解析出的绝对路径、`SRT_ENCODED_CMD`）。内核不支持 USER_NOTIF 时事件携带 `observe_init_error` 被丢弃，监听失败时 `observeSocketPath` 变为 `undefined`、wrap 时自动跳过 —— 全程优雅降级。
- 监控侧只保留 bwrap 真正会拒绝的路径（allowWrite 之外或 denyWrite 之内），并应用既有 `ignoreViolations` 配置；事件写入 `manager.getSandboxViolationStore()`，`getViolationsForCommand(command)` 以 `SRT_ENCODED_CMD`（= `wrapWithSandbox` 入参的 base64）精确关联，事件含 `line`（`deny <syscall> <path>`）与宿主侧 `timestamp`。`cleanupAfterCommand` 只清理 bwrap 挂载点，不清 store。
- 上游文档明确该通道是**诊断性提示**（路径经 `process_vm_readv` 从沙箱进程内存读出，attacker-controlled 且有竞态），MUST NOT 参与策略判定。

pi-sandbox 现状：`extractBlockedWritePath`（upstream）用单条正则匹配 macOS EPERM 的 bash 报错形态，驱动 `bashTool.execute` 里已有的 `resolveWritePermission` 弹窗 → `applyChoice` → `refreshSandbox` → 重跑链路；Linux 上该正则永不命中。

## Goals / Non-Goals

**Goals:**

- agent 在 bash 写被沙箱拒绝时，无论工具如何打印报错，都能得到明确的沙箱归因说明与被拒路径列表。
- Linux 获得与 macOS 一致的"提示 → 允许 → 自动重试"体验。
- 监控不可用时行为不劣于现状（保留 upstream 文本路径 + 一行子串兜底）。
- 诊断通道不放松任何沙箱策略（spec 的策略不变式）。

**Non-Goals:**

- 不解决 bash 中被 denyRead 隐藏的读操作（表现为 ENOENT，监控只覆盖写意图 syscall，无法与真实不存在的文件区分）。
- 不修改 `sandbox-runtime`（upstream 子树）——只使用其公开接口。
- 不新增配置项；监控在 Linux 上始终开启（诊断性、可降级，开销为每命令一次 unix socket 连接）。
- 不改动 `user_bash`（`!cmd`）输出通道（人类直读，spec 要求保持原样）。
- 不改动 read/write/edit 工具路径（`tool_call` 拦截已有明确文案）。

## Decisions

### D1：以 seccomp 违规监控为主通道，而非扩展错误文本正则

错误文本是下游投影，格式不可枚举；违规监控是上游为该问题设计的内核级观测点。`initializeSandbox` 传 `enableLogMonitor = process.platform === "linux"`。仅 Linux 启用：本问题的报告平台是 Linux，macOS 的 `log stream` 常驻子进程是另一套失败模式（权限、logd），不在此变更中引入；macOS 保留既有 EPERM 文本路径。

**真机验证发现（WSL2 内核限制）**：在 `6.18.33.1-microsoft-standard-WSL2` 内核上，最小 C 探针证实 `SECCOMP_SET_MODE_FILTER(…, SECCOMP_FILTER_FLAG_NEW_LISTENER, …)` 一律返回 `EBUSY`——即使是进程安装的第一个过滤器，即该内核不支持 seccomp 用户通知。因此监控在 WSL2 上静默降级（上游 fail-open），在标准 Linux 内核上可用。降级通道因此承担 WSL2 上的完整体验（见 D3 第 2/3 层）。

### D2：违规收集放在 `exec` 内部，经回调交付

`getViolationsForCommand` 的关联键是传给 `wrapWithSandbox` 的**原始字符串**，只有 `exec` 持有它（bashTool 侧只有用户命令，macOS 上还叠加 ssh 前缀函数，无法可靠复现）。因此 `createSandboxedBashOps` 增加可选第 4 参 `onCompleted?: (outcome: { command: string; blockedWrites: BlockedWrite[] }) => void`：在命令退出后、回调中交付 `collectBlockedWritePaths(manager, wrappedInput, startedAt)` 的结果。回调为可选参数，`BashOperations` 接口与 `user_bash` 路径（不传回调）完全不变。

`collectBlockedWritePaths`：按命令查 store → 按 `timestamp >= startedAt` 过滤（同一命令串可多次执行、store 为环形缓冲）→ 解析 `line`（`deny <syscall> <path>`，路径用 `(.+)$` 以支持含空格路径）→ 去重保序。时间起点在每次 `exec` 进入时采样。

竞态说明：违规事件由 apply-seccomp 在 syscall 拦截点**同步写出**（先于命令失败退出），宿主经 readline 读取；`exec` 返回前已有 100ms 退出后 stdio 排空宽限，事件先于查询落库。不加人为延迟。

### D3：bashTool 结果后处理按三层递进

每次 `runBash()` 前重置闭包内的 last-outcome；执行后：

1. **violations 命中（新主通道，Linux）**：向 result.content 追加一个 text block —— 说明"上文的 `Read-only file system` / `Operation not permitted` 是 OS 级沙箱拦截，文件系统并非真的只读"，列出全部被拒路径（`deny <syscall> <path>`）。取首个不在 denyWrite 的路径走既有 `resolveWritePermission` 流程：允许 → `refreshSandbox` → `runBash()` 重跑（重跑后重新递进，逐路径收敛）；中止/超时 → 附加"保持阻止，不要盲目重试"文案；无 UI → 只追加说明。全部路径命中 denyWrite → 不弹提示，附加"需修改配置"文案。
   - **重试环路保护**：每次工具调用维护已重试路径集合；允许后重试仍在同一路径失败（Linux 上 bwrap 无法为尚不存在的文件挂载写权限）时，不再重试，改为返回"已允许但仍失败 → 请允许已存在的父目录"的说明。
2. **violations 为空但输出可识别被拒路径（降级通道）**：`extractBlockedWritePath`（upstream，macOS EPERM 形态）之外，新增 fork 层的 `extractDeniedWritePathFromOutput`：仅在降级时解析最常见的 shell 拒绝形态（bash/sh 重定向的 path-before-error、zsh 的 path-after、GNU coreutils 引号形式、Node errno 形式），识别到路径后走与监控通道相同的 `resolveWritePermission` 弹窗 → 允许 → 自动重试。WSL2 内核（用户实际环境）走的就是这一层；形态之外的工具报错仍能命中第 3 层的一般性说明，只是不弹窗。用户拒绝/超时时附加"保持阻止"说明。
3. **仅输出含 `read-only file ?system|operation not permitted` 子串（一行兜底）**：追加无路径的一般性说明。覆盖监控缺失环境（如旧内核）下的知情需求。

说明文案为英文（与现有工具输出语言一致），由 `sandboxWriteDenialNotice(options)` 集中生成，extension 只负责组装 result。

### D4：降级模式的窄口径输出解析

规划初期曾把扩展正则当作主方案被否决；本设计中输出解析仅作为**监控不可用时的降级补充**（WSL2 内核即此场景），且形态集合收敛到 shell 拒绝的四种标准格式。`extractBlockedWritePath` 保持 upstream 原实现不动（macOS 层继续使用），fork 层新增 `extractDeniedWritePathFromOutput` 只服务降级层，并附注释说明其定位——监控可用的内核上该解析永远不会执行。

## Risks / Trade-offs

- **违规路径 attacker-controlled**（上游文档注明）：路径仅用于展示与提示，允许提示由人类确认、且允许规则必须匹配所报路径；沙箱内进程本就受命名空间约束，风险与读取其错误输出一致。文案措辞不因该路径而自动放行（D3 的策略不变式，见 spec）。
- **macOS 不获得新主通道**：保留既有文本路径，行为不回归；后续如需可用同一回调结构接入 Seatbelt 监控。
- **监控每命令开销**：apply-seccomp 本就运行，仅多一次 socket 连接与逐行 JSON 写；监听器常驻（每会话一个 mkdtemp socket，`reset()` 时停止清理）。
- **同命令串重复执行的旧事件污染**：以 `startedAt` 时间窗过滤解决；宿主时钟为单调场景下的近似，误差可忽略。
- **提示逐路径收敛可能多次重跑命令**：与 macOS 现状一致（每次允许一个路径后重跑）；命令本已在首个被拒写处失败，重跑幂等风险由命令自身承担，用户可随时中止。
