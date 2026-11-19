# 发布前验证记录：Goal-X 0.12.5 / tool-display 0.3.3

## 范围与结果

- 发布计划仅包含 `@xzzpig/pi-goal-x@0.12.5` 和 `@xzzpig/pi-tool-display@0.3.3`；私有 `pi-components` 随消费者打包，不单独发布。
- 三个已完成的 OpenSpec 变更已归档并同步主规格；`openspec validate --all` 通过（有规格长度告警）。
- `pnpm install --frozen-lockfile`、`pnpm run verify`、`pnpm run test:release` 和 `pnpm run publish:check` 通过。
- 串行运行 `pnpm run publish:pack --only pi-goal-x,pi-tool-display` 通过正式门禁、两个包的 tarball 校验及隔离 Pi 启动检查。第一次与全仓检查并发时，`pi-subagents` 的 `herdr-native-placement` 一项测试失败；串行重跑目标包门禁通过。
- 前述两包的行为验收与录屏记录在归档变更 `openspec/changes/archive/2026-11-19-enhance-goal-confirmation-mouse-and-diff/verification.md`；其中 fixture 提案、注入 SGR 与真实模型工具调用的区别均已注明。

## 未通过：全仓 check-all

`node scripts/release.mjs --pack --check-all` **未通过**，不能据此宣称全仓发布前验证完成。首次运行中，`sandbox-runtime` 测试尝试向当前沙箱中只读的原 HOME 建目录。改用 `/tmp` 下新建的临时 HOME 再次运行后，`sandbox-runtime` 汇总为 823 通过、159 跳过、8 失败：

1. `fork control-fd process lifecycle > delivers dynamic data and EOF across repeated spawns`：清理描述符时报 `EBADF`。
2. `linux-violation-monitor + apply-seccomp` 的 `captures write-intent paths from a real workload`：没有收到预期的违规事件。
3. 同一套件的 `resolves relative paths against the workload cwd`：未找到预期的违规事件。
4. `Sandbox Integration Tests > With Pre-compiled BPF > Filesystem Restrictions > should allow reads from anywhere`：子进程退出码为 1；测试假定 HOME 有 `.bashrc`，临时 HOME 未预先创建该文件，可能影响此项。
5. `Git over SSH through sandbox proxy > should resolve DNS and connect when running git over SSH`：SSH 报系统配置文件 `bad owner or permissions`，未达到预期的公钥认证阶段。
6. `allowRead carve-out with denyRead at filesystem root` 的 `Linux: re-allows carve-out under a root-level deny`：子进程退出码为 1。
7. 同一套件的 `Linux: still denies paths outside the carve-out under a root-level deny`：子进程退出码为 1。
8. 同一套件的 `Linux: preserves write binds when denyRead ancestor wipes them`：子进程退出码为 1。

完整本机日志当时保存在 `/tmp/release-checkall-retry.log`，属于临时文件，可能被清理。上述失败不应全部归因于沙箱：还没有逐项证明根因。发布前应在允许 Linux 命名空间、seccomp 和网络测试的适当环境准备真实的测试 HOME，重新运行 `direnv exec . node scripts/release.mjs --pack --check-all`，调查并解决仍存在的失败；不得将本记录或目标包通过结果当成全仓门禁通过。

本次操作只准备和提交文件，不推送、不触发发布、不上传 npm。
