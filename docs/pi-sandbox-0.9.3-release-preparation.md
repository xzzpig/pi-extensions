# pi-sandbox 0.9.3 发布准备

## 范围与授权

- 用户选择 patch 版本：`@xzzpig/pi-sandbox@0.9.3`，内嵌 `@xzzpig/sandbox-runtime@0.1.3`；support library 不单独发布。
- 包含 issue #1 的显式设备授权修复、两处最小 upstream seam、审计计数修复及回归验证。
- 用户确认同步主规格、归档已完成变更并本地提交；未授权推送、npm 上传、修改账号或 CI 开关。
- 用户另行确认修复启动验证器环境准备，并在保留完整门禁阻塞的前提下提交。没有跳过或放宽正式门禁。

## 版本与归档

- 插件 manifest、CHANGELOG 与根 `versions.json` 均为 0.9.3；内嵌 runtime manifest、CHANGELOG 为 0.1.3。
- runtime 的 npm lock 使用 `npm version 0.1.3 --no-git-tag-version --ignore-scripts` 机械更新，仅两个根 version 字段变化，依赖图未改；pnpm frozen-lockfile 安装通过。
- CLI 归档至 [2026-11-16-add-sandbox-device-passthrough](../openspec/changes/archive/2026-11-16-add-sandbox-device-passthrough/)，17/17 任务完成；主规格新增 sandbox-devices 的 5 项要求，并给 agent-profiles 增加 2 项要求。
- `openspec list --json` 无活动变更，`openspec validate --all` 为 20 passed / 0 failed，保留既有长 requirement 警告。

## 验证结果

本轮证据目录：`/tmp/pi-device-release-093-mqte2k/`。历史实现及同会话/并发证据保留在归档内的 verification.md；本文件不修改该历史快照。

- `pnpm install --frozen-lockfile` 通过。
- 插件完整测试：201 pass / 4 既有 skip / 0 fail（`plugin-tests.log`）。
- 发布脚本回归：修复前 32/32，修复后 34/34（`release-tests-final.log`）；审计脚本 5/5（`audit-tests.log`）。
- 两包类型检查、runtime build、非改写 lint、插件格式检查、根 Prettier、fork identity 和 `git diff --check` 通过。
- 全仓 fork audit 退出 0：pi-sandbox checked=26、sandbox-runtime checked=140，均 undeclared=0、stale=0，无新增 knownDebt。当前真实维护计数分别为 23/8 与 6/5。
- `pnpm run publish:check` 查询真实 registry，只有 `@xzzpig/pi-sandbox@0.9.3` 一个待发布候选；该操作没有上传。

### 启动验证器修复

单独验证 pi-sandbox 的首次安装启动失败：core peer 是可选的，npm 不会自动安装 Pi CLI，验证器却假定其存在。失败原始日志为 `candidate-pack-startup.log`，未算通过。

现由测试 harness 显式安装受支持的 Pi 1.x CLI，与精确候选 tarball 一同安装；插件的可选 peer 契约不变，npm peer 兼容性检查保持启用。新增两项测试覆盖可选 peer 单候选与多候选只安装一个 CLI，保留无 lifecycle/no-save/no-lock 约束，不使用 force 或 legacy-peer-deps。

实际修复后 `runPackageStartupE2E` 成功，`startup-final.log` 与 `startup-final.json` 确认独立临时环境加载 0.9.3 的真实扩展入口、RPC get_state 成功、无扩展加载错误。该验证不调用模型，不是 TUI 测试。

### 最终候选安装态真实 KVM

- tarball：`/tmp/pi-device-release-093-mqte2k/tarballs/xzzpig-pi-sandbox-0.9.3.tgz`。
- SHA-256：`ff0774fd0e1d050a8954230762450f8906bf51a0a8fad76a37999791a876e44c`。
- `artifact.json` 保留 SHA-512 integrity 与 320 项条目；使用仓库的 pack/manifest/path/entry 校验，单独记录为候选验证，不代替下述失败的完整正式门禁。
- `manifest-check.json` 确认内嵌 runtime 为 0.1.3，workspace 依赖已转换为精确版本，两个 apply-seccomp 均为 0755。
- 独立安装目录 `/tmp/pi-device-release-installed-AY0GX6/`，只加载该安装目录的 index.ts。
- 原始 Pi 证据 `/tmp/pi-device-matrix-TZmRyw/`：global-denied、global-allowed、global-revoked 3/3 PASS；实际工具输出依次为 ENOENT、字符设备 10:232 且 KVM_GET_API_VERSION=12、ENOENT。配置、launch.json、exit.json、pi.jsonl 和 sessions 均保留。
- `verification-final.exit` 与 `device-e2e.exit` 均为 0；启动验证和设备验证使用同一份候选归档。
- 全部为 print/json/RPC，没有交互 TUI；未操作既有用户 tmux 会话、未提权、未改设备权限。

## 尚存的正式发布阻塞

`pnpm run publish:pack --only pi-sandbox` 在真实宿主独立会话执行，退出 1（`official-pack.exit`）。native seccomp build、runtime TypeScript build/typecheck 已通过，但完整 runtime 测试为 **801 pass / 159 skip / 22 fail**，原始记录为 `official-pack.log`。

失败涉及 Bun control-fd 生命周期、seccomp 事件观察、根 deny 挂载布局、BPF 网络限制、外部 SSH/DNS/proxy 和 updateConfig 的网络集成。本轮失败数与历史轮次不同，没有将每个失败都宣称为同一次 HEAD 基线复现；历史基线和用户接受记录仍在归档中。用户在本轮再次明确选择“记录阻塞后提交，不放宽门禁”。

**因此，代码、版本与候选工件已准备并验证，但完整自动发布门禁并未全绿，不能宣称可直接发布。** 正式上传前仍需在兼容环境（例如已按仓库文档配置的 GitHub runner）通过完整门禁。没有修改测试期望、加 skip、关闭 seccomp 或绕开上传门禁来伪装成功，也没有请求/执行实际上传。

本地 `.pi/pi-goal-x-settings.json` 的既有修改不纳入提交。生成归档、安装目录、会话、凭据和本地 npm 状态均不提交；`/tmp` 证据会随宿主清理消失，需要长期留存时应另行保存。
