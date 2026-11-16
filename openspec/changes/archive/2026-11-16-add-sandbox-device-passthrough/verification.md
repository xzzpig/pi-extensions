# 验证记录

## 当前交付候选摘要（后续章节保留完整历史）

- 生产代码已完成非 Linux 失败关闭修复；设备、service/child 信任、运行时注册 profile、同会话切换及真实并发设备验证均有下文原始证据。
- 本轮仅收紧两处 upstream seam 并修复审计计数，不改变设备行为；插件当前完整测试 205 项，201 pass / 4 既有 skip / 0 fail，runtime 设备定向 37 pass，审计脚本回归 5 pass。runtime 全套宿主/基线例外保留；本轮没有重跑完整 runtime 全套，不宣称全套全绿。
- 当前最终 tarball：`/tmp/pi-fork-seams-IY6Jvq/tarballs/xzzpig-pi-sandbox-0.9.2.tgz`，SHA-256 `594efb5ef95f07a4ac91c72b2ddfde57c13ceb9048b71280c8d90a9f3772a8ed`。独立安装后的真实 Pi 三阶段 3/3 PASS：`/tmp/pi-device-matrix-uamIUG/`，总退出码 0。之前路径和 SHA 只代表对应历史轮次。
- 用户使用文档及其 3 项示例回归保留；本轮真实 Pi 同会话切换与真实 KVM/TUN 并发复验也通过。技术验证详见下一节，最终完成状态以 goal 独立审计回执为准。

## 二开分歧收敛与审计计数修复（goal mwjbix2l-e5bwgw）

- 证据根目录：`/tmp/pi-fork-seams-IY6Jvq/`。`before/` 保留本轮开始时的两个 upstream 文件和审计脚本，未回滚或覆盖原有用户改动。
- `extension.ts` 中设备初始化失败分类、错误包装和通知迁入 fork-only `fork-profile-startup.ts` 的 `recordSandboxInitializationFailure`，原 12 行分支变为单调用，状态赋值仍留在原位置；新增一个 helper 解构接线。`sandbox-manager.ts` 的设备字段继承、空列表覆盖与 disabled/deny 组装迁入 fork-only `fork-devices.ts` 的 `resolveConfiguredDevices`，13 行组装变为 6 行调用，不改变原有 fsDisabled 计算和 Windows 校验路径。
- `extension-seam.diff`、`manager-seam.diff` 仅含上述接入调整。`upstream-diff-stats.json` 对照 metadata 记录的精确 upstream：extension 新增/删除行由 551/99 降至 541/99；manager 从 68/7 降至 61/7。没有格式化 upstream 文件；新逻辑和新测试均在 fork-only 文件，不复制跨包校验。
- `fork-device-startup-seam.test.ts` 的 12 项覆盖 profile 有/无、设备字段省略/空/非空、Error/string 的失败处理等价性及普通无设备回退；`fork-device-config-seam.test.ts` 的 4 项覆盖继承/替换/清空、denyRead/denyWrite 各层覆盖、普通文件规则关闭时仍保留设备校验及非 Linux 拒绝。
- 插件完整测试 `/tmp/pi-fork-seams-IY6Jvq/plugin-tests.log` 为 201 pass / 4 既有 skip / 0 fail；runtime 两份设备测试加新配置 seam 测试合计 37 pass / 0 fail（基础设备测试仅为基础设施验证，不算额外设备验收）。
- 审计脚本只删除解析之后的计数清零语句。`scripts/fork-divergence-audit.test.mjs` 创建独立临时 Git 工作区，只读复用已有 upstream 对象，不创建 commit、不改真实元数据；5 项覆盖多记录及字段省略计数、两种显式空数组拒绝、未声明 NOISE/DELETED 退出 1 且匹配声明恢复接受、零 upstream 匹配退出 2。命令 `direnv exec . node --test scripts/fork-divergence-audit.test.mjs`，结果见 `audit-tests.log`。
- `inventory.log` 与 `actual-counts.json` 独立核对真实 JSON：pi-sandbox 的 reapplyOnSync/doNotReintroduce 为 23/8，sandbox-runtime 为 6/5，不是错误的 0/0。两个 subtree 只更新原有设备 seam 的 reapplyOnSync 文案，未增加 fork-only 自有文件条目，也没有新增 knownDebt。
- 真实 Pi 同会话复验：`/tmp/pi-device-switch-YcHVwp/`，唯一 session `2026-11-16T13-57-49-833Z_01a1e4a6-5a88-7169-b7e9-79f287f4d753.jsonl`，五次实际工具调用确认 KVM 10:232 API=12 → ENOENT → API=12；`switch.log`、`switch.exit=0`。
- 真实双设备并发：`/tmp/pi-device-concurrent-real-CIy5v4/`，真实生产 Manager/Pi core bash/bubblewrap 和 KVM/TUN 进程，不是模型会话 E2E。门闩期间 A 切空，新 A 拒绝，B 保留 TUNGETFEATURES=29043；旧 A/B 仍各自返回 API=12/29043，A 恢复后再次成功。`concurrency.log`、`concurrency.exit=0`，summary 和各命令原始输出保留。
- 最终 pack/install 及启动命令在 `host-verify.sh`，日志为 `pack.log`、`install.log`、`tarball-e2e.log`；安装目录 `/tmp/pi-fork-seams-installed-CxyHxc/`。仅从该目录实际安装的包入口加载插件，`/tmp/pi-device-matrix-uamIUG/` 的三个独立真实 Pi session 确认 KVM ENOENT → API=12 → ENOENT，保留 launch/exit/pi.jsonl/session。`tarball-e2e.exit=0`、`host.exit=0`，SHA 见当前摘要和 `tarball.sha256`。内嵌 x64/arm64 apply-seccomp 均为 0755，未关闭 seccomp 绕过。
- 本轮全部为 print/json/headless，无交互 TUI，不需要 asciinema 录像。只在已确认连通的宿主 tmux 新建独立临时会话，没有操作已有用户会话、提权或改设备权限。
- 两包类型检查、runtime build、插件源码型打包、全包非改写 lint/格式检查、根 prettier、OpenSpec strict validate、git diff --check 通过；插件没有独立 build 脚本，按其源码入口合同以 tsc + pack + 安装加载验证。命令与复核结果另存 `final-checks.log`。
- 全仓 audit 退出 0（`audit-all.log`）：pi-sandbox checked=26/noise=2/deleted=2/undeclared=0/stale=0；sandbox-runtime checked=140/noise=1/deleted=0/undeclared=0/stale=0。仍只有既有已声明噪音/删除，未新增。LSP 有超时及既有辅助提示，不将其当作干净确认，类型结论以实际 tsc 为准。
- 本轮保留既有 runtime 宿主/HEAD 例外和全部历史失败证据，不将任何新失败归入例外；没有改 lockfile、版本、业务 specs，没有提交/推送/发布/归档，未改用户已有的 goal settings。

## 实施前预检

- 通过 direnv 环境确认 Pi 1.5.2、bubblewrap、Python 可用，`pi auth check --provider axonhub` 返回 `ready`。尚未执行模型工具调用验收。
- 当前 bash 沙箱仅有最小 `/dev`，`/dev/kvm` 不存在；不能把这一视图当作宿主没有设备。
- 操作者已明确允许通过现有宿主 `/tmp` tmux server 在独立临时会话进行设备盘点、非破坏探测及后续隔离 Pi E2E。未操作原有会话、未修改设备权限。
- 宿主真实 `/dev/kvm` 为字符设备 `10:232`，当前用户可打开，`KVM_GET_API_VERSION` 返回 12。安全探测不创建 VM/vCPU，不写设备。
- 仓库探测程序：`packages/pi-sandbox/scripts/fork-device-probe.py`；操作说明：`packages/pi-sandbox/FORK-DEVICE-E2E.md`。
- 证据目录：`/tmp/pi-device-preflight-4JDWGa/`。`host.txt` 是盘点及首次探测；`repo-probe-host.json` 和 `.exit` 记录仓库程序宿主成功（退出码 0、apiVersion=12），`repo-probe-sandbox.json` 和 `.exit` 记录当前最小设备沙箱中 ENOENT（退出码 1）。
- 以上仅证明预检前提；后续验收结果见下文。

## 实现与定向验证

- runtime 新增设备校验、参数与真实 bubblewrap 基础设施测试共 33 项通过；typecheck、build 通过。基础设备测试明确不算额外设备验收。
- `/tmp/pi-device-preflight-4JDWGa/runtime-kvm.log` / `.exit`：真实 Manager + KVM 未授权/授权/撤销三阶段通过，fs.disabled 下授权/未授权也通过，总退出码 0。
- `runtime-tun.log` / `.exit`：真实 `/dev/net/tun` 嵌套节点打开和 TUNGETFEATURES 安全查询成功，并确认 raw denyWrite `/dev/net/*` 冲突拒绝。
- 插件完整测试：`/tmp/pi-device-plugin-tests-final.log`，178 项，174 pass、4 既有 skip、0 fail；13 项新增设备测试覆盖 trust true/false/unknown、profile 继承/替换/清空、配置透传与无 profile 失败关闭。
- runtime 变更文件 ESLint 非改写检查通过；最终跨包检查仍以最后一节为准。

## 真实 Pi 源码设备 E2E

- 运行：宿主独立 tmux 临时会话中执行 `direnv exec . node packages/pi-sandbox/scripts/fork-device-e2e.mjs`。真实 Pi 1.5.2、axonhub/deepseek-v4-flash、print/json；没有 TUI，因此不需要 TUI 录像。
- 首次单场景成功证据：`/tmp/pi-device-e2e-F4z2mc/`，真实 bash 输出 KVM 10:232、apiVersion=12，Pi 退出 0。
- 完整成功矩阵：`/tmp/pi-device-matrix-dVcJ1l/summary.json`，8/8 PASS：global-denied、global-allowed、global-revoked、trusted-project（--approve）、untrusted-project（--no-approve）、profile-inherit、profile-empty、other-isolation。
- 每场景保留 `launch.json`、有效 global-config.json、项目配置、pi.jsonl、pi.stderr、exit.json 和 sessions/。runner 断言模型真实调用一次 bash 且命令完全匹配，解析工具原始输出，不采信模型总结。
- other-isolation 在 KVM 可操作时同时验证普通白名单外写入和宿主本地 TCP 访问被阻止；host-network.txt 证明相同 TCP 目标在宿主可连。
- 初次矩阵 `/tmp/pi-device-matrix-uzCKbJ/` 因模型把整个命令加引号而失败，未计为通过；保留失败证据，澄清 prompt 后重新使用全新目录运行。

## tarball 设备 E2E

- 初次 `/tmp/pi-device-matrix-9pMGGp/` 失败：pnpm 把内嵌 apply-seccomp 从 0755 规范化为 0644，实际 Pi 执行报 Permission denied/126。未通过禁用 seccomp 绕过。
- 已在 pi-sandbox publishConfig.executableFiles 显式声明 x64/arm64 内嵌二进制，重新 pack 的 tar 列表确认两者为 0755。
- 验收产物：`/tmp/pi-device-tarballs/xzzpig-pi-sandbox-0.9.2.tgz`，最终 SHA-256 `9d561025f56ccab49bd894f538cc3e26e2f8fc51e576047994eb18b338eb1cde`。包内含 fork-devices helper 与新 schema。
- 通过 npm --ignore-scripts 安装到独立 `/tmp` 目录（具体安装位置由 `/tmp/pi-device-installed-fixed-latest` 记录），以实际安装的 index.ts 为唯一插件入口。
- 成功证据：`/tmp/pi-device-matrix-IyKNdD/`，global-denied、global-allowed、global-revoked 3/3 PASS，真实 bash 工具验证 KVM API 和身份，Pi 均退出 0；启动/安装日志见 `/tmp/pi-device-preflight-4JDWGa/tarball-fixed-*.log`，矩阵总退出码 0。
- 原始失败产物已被修复产物替换，失败安装目录和失败 session 仍保留；测试配置和源码没有关闭默认 seccomp。

## 分歧审计与回归状态

- `/tmp/pi-device-fork-audit.log`：全仓 audit 通过；pi-sandbox checked=26、undeclared=0；sandbox-runtime checked=140、undeclared=0；两者无 stale。均只有既有已声明噪音/删除项。
- sandbox-runtime 的 root-deny carve-out 测试在当前沙箱先遇到 HOME 写入 EROFS；转宿主后有 3 项失败，在临时复制并恢复 HEAD 三份 upstream 文件的基线中同样复现。对应既有 subtree knownDebt 已声明 NixOS `/sbin` 链接布局、seccomp listener 及外部网络的宿主限制；未改写 upstream 测试或放宽设备策略来掩盖失败。
- 完整 sandbox 子集：当前 639 pass / 153 skip / 10 fail；修复临时基线依赖解析后，HEAD 基线为 604 pass / 153 skip / 12 fail。当前该次 10 个失败名称均在该次基线中复现，比较见 `regression-failures-fixed.json`。
- 完整 `bun test`：当前 813 pass / 159 skip / 14 fail（`host-runtime-full.log`）；HEAD 基线 778 pass / 159 skip / 16 fail（`host-baseline-full-only.log`），另保留 baseline-network-targeted.log。网络用例受公网/本地 proxy 时序影响，失败集合在不同运行间波动，并非每次逐项相同；不宣称全套全绿。
- Bun control-fd 的 EBADF 在未改动的 HEAD helper/test 中也复现，且该测试不导入设备实现。其接受例外新增到 subtree knownDebt；其他 NixOS 挂载/监控/外网问题沿用已有声明。
- 用户通过结构化确认选择「沿用既有宿主例外，交付设备修复」，明确接受保留完整失败报告与 HEAD 对照、不扩展到代理/SSH/挂载布局/Bun 生命周期修复。因此本次相关设备检查通过，但全套 runtime 14 项失败作为已接受例外交付，不计作修复成功的测试。
- 原始决策（非执行者摘要）：会话 `/home/xzzpig/.pi/agent/sessions/--home-xzzpig-workspaces-nodejs-pi-extensions--/2026-11-16T08-34-57-427Z_01a1e37e-c112-70f4-977a-84ff66fcb2c5.jsonl` 第 394 行 entry `a6fa60be` 是 ask_user 的完整问题与选项，第 396 行 entry `c6ea681d` 是实际工具回执。details.answers.baseline_failures.values 为 `["accept_existing_host_exceptions"]`，cancelled=false、mode=submit，回执原文为「验收边界: 沿用既有宿主例外，交付设备修复」。原始两条记录已按来源与行号摘录到 `/tmp/pi-device-preflight-4JDWGa/baseline-user-decision.json`，不包含凭据。

## 目标审计交接

首次审计曾因 `context_capacity_exceeded`（父审计上下文超过 256 KiB）失败，要求的原始用户决策已补齐并在后续审计中获核验。后续审计指出的非 Linux 失败开放、设备生命周期覆盖及文档示例问题分别在下节记录修复。当前仍需最终重审批准，不能将历史审计的证据确认等同于目标已完成。

## 独立审计指出的非 Linux 失败开放修复

- 第二次独立审计已核验原始用户例外决策及真实设备证据，但发现插件 unsupported-platform 早退分支未记录阻断，后续 bash 可能无沙箱执行。此项是新增缺陷，未纳入宿主例外。
- 新增 fork-only `devicePlatformError`；在 extension.ts 的 `supportsSandboxPlatform` 早退之前校验有效非空设备请求，win32/darwin/freebsd 等非 Linux 平台记录带 filesystem.allowDevices 的明确错误，建立持久失败关闭状态；空列表/省略字段保持原有行为。Android 沿用现有 Linux 后端。
- `test/fork-device-platform.test.ts` 覆盖真实插件注册 → 模拟平台下 session_start → 恢复宿主平台后实际 bash.execute、tool_call 和 user_bash。非空请求不能调用 runtime.initialize，不能产生测试标记文件；空请求保留原有未隔离回退行为。
- 修复前：3 个非 Linux 非空请求用例失败，实证 win32/freebsd 进入普通 bash 回退（`/tmp/pi-device-platform-before.log`）。修复后 5/5 PASS（`/tmp/pi-device-platform-after.log`）；模拟平台测试仅是非 Linux 单元/集成回归，不替代真实 Linux 设备 E2E。
- 插件完整测试已增至 183 项，179 pass / 4 既有 skip / 0 fail（`/tmp/pi-device-plugin-tests-platform.log`）；新增测试的显式回调类型已修正，最终 tsc 无错误（`/tmp/pi-device-platform-typecheck.log`），全包 oxlint/oxfmt 通过。
- 修复后源码真实 Pi 完整矩阵重新执行 8/8 PASS：`/tmp/pi-device-matrix-iClXE4/`，总退出码 0（`audit-fixed-source.log` / `.exit`）。
- **该轮 tarball（最新产物见当前摘要）**：`/tmp/pi-device-tarballs-audit-fix/xzzpig-pi-sandbox-0.9.2.tgz`，SHA-256 `536e81ccf6c5f6216ee26500f15cdb30ca939092ac45fc834e8e598043bfa4ba`。重新安装后真实 Pi 三阶段 3/3 PASS：`/tmp/pi-device-matrix-DHdjEJ/`，总退出码 0；实际安装位置见 `/tmp/pi-device-installed-audit-fix-latest`，原始 pack/install/工具及 session 证据见 `audit-fixed-*.log`、`audit-fixed-tarball.sha256` 与场景目录。先前 9d5610… 的产物和安装证据保留为历史，不能代替此最新版。

## 独立审计指出的 service/child 与并发生命周期覆盖补齐

- 第三次审计确认非 Linux 修复及真实设备证据，但拒绝用通用 profile 测试或每场景新建 Pi 代替设备专属状态生命周期验证。本节补齐 tasks 3.1/3.2 的全部入口，不将审计意见算作宿主例外。
- `test/fork-device-lifecycle.test.ts` 新增 7 项，实际注册生产插件并触发 session_start、通过会话级 SandboxService 选择 profile、执行生产 bash 工具路径。service 和 child 各自覆盖 trust=true/false/undefined；child 在注册时捕获 profile 与继承信任环境通道，随后清除启动 env 再执行，断言项目设备只在明确可信时生效。此层使用可控 manager 和执行门闩，是配置/状态集成测试，不冒充真实设备 E2E。
- 第 7 项通过 `registerSandboxProfiles` 注册 KVM/TUN/空设备 profile，再经两个独立 session 的 service 选择。两个命令同时停在异步执行门闩时切换 A 到空 profile，断言后续 A 无设备、B 仍为 TUN，释放后已开始 A/B 各自保留原快照；同一 A 会话可显式恢复 KVM。日志 `/tmp/pi-device-lifecycle-unit.log`，7/7 PASS。
- **同一真实 Pi session 的实际 KVM 切换**：运行 `direnv exec . node packages/pi-sandbox/scripts/fork-device-switch-e2e.mjs`，只额外加载 test-only `fork-device-switch-fixture.ts`。fixture 通过运行时注册 profile，工具仅按名称调用当前会话 SandboxService，不直接写配置或伪造 bash 结果。真实模型按顺序执行 bash → service 切空 → bash → service 恢复 → bash，共 5 个实际工具调用；KVM 10:232 的结果依次为 API=12、ENOENT、API=12。
- 同会话成功证据 `/tmp/pi-device-switch-bmwFmH/`：summary.json、launch.json、pi.jsonl、pi.stderr、exit.json、host.json 以及 sessions/ 下唯一 JSONL（`2026-11-16T12-28-30-874Z_01a1e454-9518-749f-980a-7c5462f0a99f.jsonl`）。runner 断言恰好 5 调用及唯一 session；总退出码 0，日志 `device-switch.log` / `.exit`。
- **两个真实设备沙箱并发**：运行 `direnv exec . pnpm --filter @xzzpig/pi-sandbox exec tsx scripts/fork-device-concurrency-real.ts`。此层使用 headless API 适配器提供 session 身份，但真实生产插件、真实 Manager、Pi core bash 工具与 bubblewrap/设备进程均未 mock；不将其称为模型会话 E2E。
- 并发成功证据 `/tmp/pi-device-concurrent-real-4YCWM5/`：两个实际进程分别打开 KVM 10:232 和 TUN 10:200，再通过独立 entered/release 文件门闩等待。A service 切空后新 A 命令 ENOENT，B 新命令 TUNGETFEATURES=29043；释放旧进程后旧 A 仍返回 KVM API=12、旧 B 仍返回 TUNGETFEATURES=29043。A 显式恢复 KVM 后再次成功。summary.json 与 old-a/old-b/revoked-a/unaffected-b/restored-a.json 保存命令、执行前后 profile 和原始输出，总退出码 0（device-concurrent-real-retry.log / .exit）。
- 首次并发 harness 在 `/tmp/pi-device-concurrent-real-kwNkK3/` 因错误假设「Pi 非零 shell 结果必抛异常」而失败，未计通过；适配为识别原始输出的非零退出码后，用全新目录重跑。没有修改生产实现来隐藏设备失败。
- 插件完整测试现在为 **190 项：186 pass / 4 既有 skip / 0 fail**（`/tmp/pi-device-plugin-tests-lifecycle.log`）。全包 tsc/oxlint/oxfmt 通过；三个新增脚本/fixture 另做语法、显式 tsc 和格式检查。
- 本轮仅新增 fork-only 测试与测试脚本，没有更改已验收生产入口。重新 pack 后 tarball SHA-256 仍为 `536e81ccf6c5f6216ee26500f15cdb30ca939092ac45fc834e8e598043bfa4ba`，与已安装并完成三阶段验收的当前最终产物逐字节一致。

## 独立审计指出的配置文档示例补齐

- 第四次审计确认实现、设备生命周期和真实设备证据成立，指出 tasks 3.4 的插件使用文档缺少完整全局/可信项目/profile 示例。本轮只补文档和测试，不更改已验收生产实现。
- `packages/pi-sandbox/FORK-DEVICE-E2E.md` 新增 4 个完整 JSON 文件示例：全局 KVM、当前 cwd 的可信项目 TUN、全局命名 profiles（继承/替换/空数组撤销/不继承全局）、可信项目同名 profile。明确默认 `~/.pi/agent/sandbox.json` 与 `PI_CODING_AGENT_DIR`、`<cwd>/.pi/sandbox.json`、`pi --approve` / `--no-approve`、选择协议、信任未知时不授权及风险/失败关闭边界。
- 新增 `test/fork-device-docs.test.ts`：直接按文档标记提取上述 JSON，校验 schema/profile；写入临时全局/项目真实配置路径，用生产 loadConfig 核对 true/false/undefined 的设备并集、profile 继承/显式替换/空列表/clean、同名项目字段省略或清空语义。3/3 PASS（`/tmp/pi-device-docs-tests.log`）。
- 当前完整插件测试 193 项：189 pass / 4 既有 skip / 0 fail（`/tmp/pi-device-plugin-tests-docs-final.log`）；tsc、全包 oxlint/oxfmt、文档格式检查均通过。
- 文档会进入 tarball，因此重新打包到独立 `/tmp/pi-device-tarballs-docs-final/`，SHA 与当前摘要一致；再次 npm --ignore-scripts 安装并用实际包入口完成 KVM 未授权/授权/撤销真实 Pi 三阶段，3/3 PASS（`/tmp/pi-device-matrix-CMg16W/`）。pack/install/运行日志为 `/tmp/pi-device-preflight-4JDWGa/docs-final-*.log`，安装位置见 `/tmp/pi-device-installed-docs-final-latest`；总退出码 `docs-final-e2e.exit` 为 0。

## 最终工件与检查（非 Linux 审计修复前历史，最新版见当前摘要）

- 最终格式清理只涉及 fork-only 文件及已有 fork 写入的 canonicalize 调用，不改 upstream 原始字节。最终 tarball 重新安装验证：`/tmp/pi-device-matrix-0Bd6e2/`，3/3 PASS，Pi 各阶段和总退出码均 0；安装入口位置见 `/tmp/pi-device-installed-final-latest`，命令及日志见 `tarball-final-*.log`。
- 恢复仓库依赖链接后重新执行 build/pack，最终归档 SHA-256 与上述成功验收产物完全一致（`tarball-final.sha256`）；没有悄悄更换已验收的二进制。
- 依赖对照准备中，临时基线的 pnpm 包管理器自动准备和类型路径解析曾失败，未计为源码失败或有效基线。已改用直接调用编译器/Bun，最终完整基线日志为 `host-baseline-full-only.log`；仓库生成依赖通过 frozen-lockfile/offline 重建后重新 typecheck、build、lint 和定向测试均通过。未改动 lockfile、版本或用户配置。
- 最终插件测试再次验证：`/tmp/pi-device-plugin-tests-restored.log`，174 pass / 4 既有 skip / 0 fail；13 项设备测试增加无 profile 设备配置下普通重初始化错误的失败关闭断言；runtime 定向仍为 33 pass / 0 fail（`/tmp/pi-device-runtime-focused-restored.log`）。
- 两包源代码 typecheck、runtime build 与全 src ESLint、插件全包 oxlint / oxfmt、全仓 prettier、OpenSpec strict validate、git diff --check 均通过。LSP 曾返回 inconclusive，未将其当作无错误证据；类型结论来自实际 tsc。
- 分歧审计最终报告：`/tmp/pi-device-fork-audit-final.log`，pi-sandbox checked=26 / undeclared=0，sandbox-runtime checked=140 / undeclared=0，无 stale。所有 E2E 均为 print/json，不存在遗漏的交互式 TUI 录像。
- 未执行提交、推送、发布、版本调整或 OpenSpec 归档；用户预先已有 `.pi/pi-goal-x-settings.json` 改动未纳入本修复。
