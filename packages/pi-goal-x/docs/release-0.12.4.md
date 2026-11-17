# Goal-X 0.12.4 发布前准备

日期：2026-11-17。用户选择 patch 版本；本次仅本地提交，不推送、不上传 npm。

## 基线与范围

- 当前 `goal` worktree 已 rebase 到本地 main `915434a067`（项目本地配置层，Goal-X 0.12.3）。原未提交改动先 stash，再恢复；唯一文本冲突为 CHANGELOG，保留了两个版本的记录。
- package.json、根 versions.json 和 CHANGELOG 同步为 0.12.4；main 的本地配置文档、测试和 files 条目均保留。
- 已通过 OpenSpec CLI 归档 `show-dynamic-audit-checklist` 到 `openspec/changes/archive/2026-11-17-show-dynamic-audit-checklist/`，同步主 goal-lifecycle 规格。活动 change 为 0，全部 20 个规格校验通过（仍有描述长度警告）。
- 归档内 validation/scenario-trace 是 rebase 前的历史验收记录，包括真实模型/TUI 录制和独立完成审计。本文件补充合并后的验证结果，不改写已归档记录。

## 合并后验证

| 检查                                                    | 结果                                        | 本机日志                           |
| ------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| `pnpm install --frozen-lockfile`                        | 退出 0，锁文件未改变                        | 执行输出                           |
| `pnpm --filter @xzzpig/pi-goal-x run typecheck`         | 退出 0                                      | `/tmp/goal-0124-types.log`         |
| Goal-X test:all 的 unit 组                              | 1701/1701，0 跳过/取消                      | `/tmp/goal-0124-tests.log`         |
| 同一次运行 integration 组                               | 35/35，原来的 9 个失败已由 main 修复        | 同上                               |
| 同一次运行真实 SDK 组                                   | 10/10                                       | 同上                               |
| 独立串行 `pnpm --filter @xzzpig/pi-goal-x run test:e2e` | 39/39，退出 0，0 跳过/取消                  | `/tmp/goal-0124-e2e-serial.log`    |
| fork runner                                             | 207/207，17 套件；测试清单自检通过          | `/tmp/goal-0124-fork.log`          |
| `pnpm run test:release`                                 | 34/34，退出 0                               | `/tmp/goal-0124-release-tests.log` |
| `pnpm run verify`                                       | 分歧审计、identity、全仓格式均退出 0        | `/tmp/goal-0124-verify.log`        |
| `pnpm run publish:check`                                | 退出 0，只有 Goal-X 0.12.4 待发布；不是上传 | `/tmp/goal-0124-plan.log`          |
| `openspec validate --all`                               | 20/20，退出 0                               | 执行输出                           |

`test:all` 的首次整条运行在 360 秒工具时限被终止，其前三组已输出上述成功结果，但不能称整条命令通过。随后单独重跑 e2e 已完整通过。曾并行运行发布构建与 e2e，依赖构建临时 manifest 导致模块解析失败；后续串行重跑已排除该调度干扰，没有修改测试断言。

## 发布阻塞：完整打包门禁仍未通过

**尚未达到可发布状态。** `pnpm run publish:pack --only pi-goal-x` 会检查依赖 pi-components 和 pi-subagents；本次停在未修改的 pi-subagents 测试，未到达候选包最终打包/安装态 Pi 启动阶段。不得将 publish:check 或此前源码/真实模型验收当作这个门禁通过，也不得绕过依赖测试上传。

尝试与结果：

1. 常规门禁：依赖 4575 项，4555 通过、4 失败、16 项测试自身跳过。包含负载下的超时，以及 NixOS 缺少硬编码远端 PATH 中 `cat` 的 SSH 模拟测试。日志 `/tmp/goal-0124-pack.log`。
2. 单独串行复查三个相关文件：仅 SSH 模拟测试仍失败；没有改断言。日志 `/tmp/goal-0124-dep-recheck.log`。
3. 使用临时 bwrap mount namespace，仅将现有 Nix `cat`/`env` 挂至私有 `/usr/bin`，不修改宿主目录；SSH 文件 29/29 通过。日志 `/tmp/goal-0124-fhs-probe.log`。完整门禁在该环境下仍有超时失败，日志 `/tmp/goal-0124-pack-fhs.log`。
4. 在同一临时 FHS 环境以 `taskset -c 0-3` 限制并发，执行原样完整 publish:pack：依赖 4575 项，4558 通过、1 失败、16 项测试自身跳过。失败为 `test/unit/index-child-registration.test.ts:861` 的 “registers pi-web liveness for the current session and releases it on shutdown”，报 `retained terminal work was reported live after delivery`。日志 `/tmp/goal-0124-pack-limited.log`。没有跳过、修改或放宽任何门禁。

复查完整门禁的环境命令如下，仅针对这台 NixOS 的工具布局：

```bash
CAT=$(command -v cat)
ENV=$(command -v env)
taskset -c 0-3 bwrap --unshare-user --unshare-pid \
  --ro-bind / / --bind "$PWD" "$PWD" --bind /tmp /tmp \
  --bind "$HOME/.cache" "$HOME/.cache" \
  --bind "$HOME/.local/share" "$HOME/.local/share" \
  --bind "$HOME/.local/state" "$HOME/.local/state" \
  --bind "$HOME/.npm" "$HOME/.npm" \
  --dev-bind /dev /dev --proc /proc --tmpfs /usr/bin \
  --ro-bind "$CAT" /usr/bin/cat --ro-bind "$ENV" /usr/bin/env \
  -- direnv exec . pnpm run publish:pack --only pi-goal-x
```

用户已明确选择：**提交当前变更与版本准备，保留并披露发布阻塞**，不扩大到修改 pi-subagents。本次未修改该依赖的源码，也未将失败登记成可豁免债务。后续须排查依赖测试、重跑完整打包门禁并验证实际 tarball 的隔离 Pi 加载，再另行取得推送/发布授权。`/tmp` 日志和录制可能被清理。
