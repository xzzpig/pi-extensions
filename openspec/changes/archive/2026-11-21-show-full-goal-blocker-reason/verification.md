# 验证记录

## 自动检查

在仓库根目录的 `direnv` 环境中，Goal-X 类型检查通过；`pnpm --filter @xzzpig/pi-goal-x test` 运行 158 个用例文件，1959 项通过、0 失败，测试清单自检也通过。全仓 fork 分歧检查通过：`pi-goal-x` 检查 757 个上游文件，现有 9 项已声明，`undeclared=0`、`stale=0`。严格 OpenSpec 校验、文档及改动的 fork-only 文件格式检查、`git diff --check` 均通过。fork 日志检查和 60 项发布工具测试通过，未进行发布。

## 审计反馈复验

- 极矮窗：预览预算单独预留全屏 dock spacer，不再用于计算普通任务窗口；用组件回归对照了 60×12 下、无原因/有原因的唯一任务行，连续重绘仍可见。任务展开增加一行时，优先裁掉可选详情而非任务或收起控件，试排不提交滚动位置。
- 命令别名：逐个验证能放入预览的别名，使用与命令注册一致的最长路径匹配，结果须为 `goal-status` 且保留 `verbose` 实参。回归覆盖首个别名过长、`work verbose` 被合法的暂停路由覆盖、以及没有安全可用别名时不显示该提示。
- 最终代码的静态与包测日志及独立回放均在 `/tmp/pi-e2e-blocker-full-interaction-1795258775`。两个补录的 Pi、录制器和播放器退出码均为 0。

| 补充录制目录 | 原始偏移（秒）   | 实况和独立回放结果                                                                                                  |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `run-C8UKWz` | 702.918          | 真实模型第三轮成功阻塞；初次点击能展开子任务，但收起底边框空间不足。保留中间版本证据。                              |
| `run-DnQ4Ml` | 117.393、118.502 | 最终代码在 60×27 显示有界预览；缩到 60×19 后，实际点击父任务，子任务出现且收起控件仍在。                            |
| `run-DnQ4Ml` | 119.463、120.159 | 在 60×19 实际键入 `INPUT-STILL-EDITABLE-19`、用 `Ctrl+U` 清除，任务和底边框持续可见；再点击收起，成功回到紧凑模式。 |
| `run-DnQ4Ml` | 181.222、183.627 | 最终代码重验两条全文入口，均显示原首行与 `INTERACTION-TAIL-56F`。                                                   |

回放截图在 `run-DnQ4Ml/independent-replay/`，包括 `child-click-with-footer.txt`、`real-edit-with-child.txt`、`collapse-after-interactions.txt` 和两条全文入口截图。

```bash
asciinema play --idle-time-limit 2 /tmp/pi-e2e-blocker-full-interaction-1795258775/recordings/run-C8UKWz/session.cast
asciinema play --idle-time-limit 2 /tmp/pi-e2e-blocker-full-interaction-1795258775/recordings/run-DnQ4Ml/session.cast
```

## 第一轮真实 Pi/TUI

- Pi `1.6.0`，asciinema `3.2.1`。在 `/tmp/pi-e2e-blocker-full-1795257215` 启动，使用本地 `packages/pi-goal-x/extensions/goal.ts`。伴随的 `seed.ts` 只创建隔离的待办目标和配置，不模拟模型、工具调用或持久化结果。使用实际配置的 `axonhub/deepseek-v4-flash`：前两轮确认同一个外部阻塞，第三轮由模型成功调用 `update_goal`。隔离了 Pi 配置及会话路径，没有把凭据写入证据。
- 会话 JSONL 记录一次成功的 `update_goal` 工具结果，`details.goal.status` 为 `blocked`，`details.resultDetail` 包含 25 行原因并以 `BLOCKER-CHECK-8C1-END` 结尾；账本包含一个 `goal_blocked` 及后续 `goal_resumed`。两条全文入口均在实际 TUI 中检查了第一行和同一个尾标。
- 录制、`steps.tsv`、实况截图、独立 tmux 回放截图保留在上述目录的 `recordings/`。三次录制均从启动录到正常退出；Pi、录制器和独立播放器退出码均为 0。

| 录制目录     | 原始偏移（秒）            | 实况和独立回放结果                                                                                                                                     |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run-EVgJoT` | 327.060、341.129、436.389 | 成功阻塞、折叠无尾标、60×27 预览；首次 60×19 验收发现收起底边框被裁，保留失败证据。                                                                    |
| `run-sxb5XX` | 44.705、61.639            | 修正测量全屏输入区预留后，60×27 显示换行预览及 `/goal-status verbose`；60×19 省略预览，两项任务、收起控件和输入区仍可见。                              |
| `run-sxb5XX` | 79.772、136.757、264.218  | 原生 `Ctrl+O` 展开的工具结果读到末行；折叠结果后单独执行 `/goal-status verbose` 并滚动到全文。随后 `/goal-resume` 实际恢复，旧原因不再显示为当前阻塞。 |
| `run-3guspI` | 28.849                    | 重新打开同一会话，初始折叠结果没有尾标；`Ctrl+O` 展开后读到当次原因及原尾标，当前面板没有旧阻塞。                                                      |

独立播放在新的 tmux 窗口中按录制尺寸切换，完整播放至退出；逐帧检查结果保存在每次录制的 `independent-replay/`。重点截图为 `run-sxb5XX` 的 `preview-60x27.txt`、`tight-60x19-fallback.txt`、`expanded-historical-result.txt`、`verbose-full-reason.txt` 及 `run-3guspI` 的 `restored-historical-tool-result.txt`。

```bash
asciinema play --idle-time-limit 2 /tmp/pi-e2e-blocker-full-1795257215/recordings/run-EVgJoT/session.cast
asciinema play --idle-time-limit 2 /tmp/pi-e2e-blocker-full-1795257215/recordings/run-sxb5XX/session.cast
asciinema play --idle-time-limit 2 /tmp/pi-e2e-blocker-full-1795257215/recordings/run-3guspI/session.cast
```
