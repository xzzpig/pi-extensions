# BTW 转录显示：发布准备记录（2026-11-01）

## 授权与状态

本轮授权为发布前准备、同步并归档已完成的 OpenSpec 变更，以及本地提交。
**没有执行 push、npm publish、版本标签或外部账号配置。**

| 包                        | 准备版本 | 范围                                             |
| ------------------------- | -------- | ------------------------------------------------ |
| `@xzzpig/pi-components`   | 0.5.0    | 私有内嵌共享库，增加可选有状态展示器，不单独发布 |
| `@xzzpig/pi-btw`          | 0.11.1   | 转录显示、交互、子会话 renderer 链与故障隔离     |
| `@xzzpig/pi-tool-display` | 0.3.1    | 可选只读展示提供者与消费端契约                   |
| `@xzzpig/pi-subagents`    | 0.24.2   | 仅同步共享库精确依赖；fleet 默认展示策略不变     |

已同步 package.json、CHANGELOG、versions.json 与根 pnpm 锁中两个内嵌依赖引用。
一次 `pnpm install --lockfile-only --ignore-scripts` 产生了无关的 peer 图重算；最终仅保留两个组件依赖 specifier 的更新，随后实际冻结安装通过，未引入其他依赖升级。
pi-tool-display 的包内 npm 锁遵循其 subtree 明确维护决策：保留 upstream 原字节与 upstream 版本，不参与本仓 pnpm 安装，未手改。

OpenSpec 已通过 CLI 归档并同步主规范：
[`2026-11-01-align-btw-transcript-presentation`](../../openspec/changes/archive/2026-11-01-align-btw-transcript-presentation/verification.md)。
历史录屏、旧版本打包证据和独立审计过程保留在该报告；它们不冒充本轮新版本包。

## 本轮实际通过的门槛

所有命令从仓库根目录运行于 direnv/Nix 环境，以下命令退出码均为 0。

- `pnpm install --frozen-lockfile --ignore-scripts` 以及随后不跳过生命周期脚本的 `pnpm install --frozen-lockfile`：均退出 0，锁文件匹配，无依赖重新解析。
- `pnpm run test:release`：26 项通过。
- `pnpm run publish:check`：只读查询 registry，待发布清单恰为上述三个公开插件；未发布。
- `node scripts/release.mjs --pack --only pi-btw,pi-subagents,pi-tool-display --output /tmp/btw-release-prep/packs`：正式候选门槛、构建与打包通过，未上传。
  - components：build/typecheck、3 文件 / 39 项测试通过。
  - BTW：typecheck、11 文件 / 259 项测试通过。
  - subagents：构建、类型与完整测试通过；4446 项中 4430 通过、16 跳过、0 失败。
  - tool-display：build/typecheck/build:types、773 项测试通过，自然退出。
  - 全仓 fork-divergence：每个 subtree 有非零检查数，undeclared=0、stale=0。
- `openspec validate --all`：17 项通过、0 失败；仍有规范需求过长的 warning，不将其描述为无 warning。
- `prettier --check .` 与所有本次新增 fork-only 文件的 `prettier --ignore-path /dev/null --check`：均通过，未把 subtree ignore 当成格式证据。
- 新版本包实际安装消费者：npm 安装退出 0；Pi 1.4.0 同款 jiti 别名加载实际包入口及展示器成功。
- 消费端 `tsc --traceResolution`：展示器类型解析到 BTW 内嵌的 components 0.5.0 声明，tool-display 消费子路径解析到 0.3.1 声明，退出 0。

原始日志和探针位于 `/tmp/btw-release-prep/`（临时文件，可能被清理），包括
`pack.log`、`test-release.log`、`publish-check.log`、`fork-prettier.log`、
`verify-packs.log`、`consumer-runtime.log`、`consumer-types.log`。

## 最终候选包

实际检查 manifest 版本、内嵌共享库版本、导出与声明、源文件或编译文件字节；三个 tarball 均不含 Pi core 的嵌套副本。
BTW 保留源码入口；subagents 保留编译后的 `bundle/index.js` 与共享库编译入口，不要求它携带源码。
最初的额外检查脚本错误地假设 subagents 内嵌源码，检查报缺失文件；已按真实编译发布契约改为比较编译 JS/声明字节后通过，未修改产品打包链。

| 包                    | entries | SHA-256                                                            |
| --------------------- | ------: | ------------------------------------------------------------------ |
| pi-btw 0.11.1         |      24 | `0678cdd7c6db366d949d0136d658eed33956b634e4cb7259419b3bace1476186` |
| pi-subagents 0.24.2   |     832 | `f8ffd56ad9be929d824f0f0fbe683ee3b08bc54874264afcb5ec8a9cec29d1c8` |
| pi-tool-display 0.3.1 |      42 | `bb992391c3c67df373862afd04a8e58b09c65fb42cb1be945ea0f53bcc9055a6` |

路径、SHA-512 integrity 与 entry 数另见 `/tmp/btw-release-prep/packs/artifacts.json`。
没有提交 tarball、node_modules、构建生成物或认证状态。

## 未通过的额外全仓检查（不能称作全部发布验证通过）

`node scripts/release.mjs --pack --check-all` 第一次退出 1：未改动的 sandbox-runtime 缺少 Bun。
临时提供 Bun 后，原生编译又报缺少 seccomp.h。
随后用 Nix 临时静态工具链重试，原生 helper 构建及 sandbox-runtime 类型检查成功，但完整 OS 测试仍失败：
**805 通过、156 跳过、9 失败，整个全仓打包命令退出 1，未完成所有公开插件的打包。**

重试方式：在 `direnv exec . nix-shell -p bun pkgsStatic.stdenv.cc pkgsStatic.libseccomp` 中运行同一全仓命令，并仅在 `/tmp` 创建 gcc/strip 的静态交叉工具链别名。
未修改系统 profile、内核 namespace/AppArmor 设置或仓库 sandbox 源码。

失败项：

1. linux-violation-monitor + apply-seccomp：真实工作负载写意图事件缺失。
2. linux-violation-monitor + apply-seccomp：相对路径事件缺失。
3. Sandbox Integration：允许任意位置读取的用例退出码不符。
4. Sandbox Integration：跨协议/端口网络限制期望文本缺失。
5. Sandbox Integration：通配域名网络限制期望文本缺失。
6. Git over SSH through sandbox proxy：Nix store SSH 配置的 owner/permissions 报错。
7. SandboxManager.updateConfig：sandboxed curl 的预期成功退出码不符。
8. allowRead 根目录 denyRead：会话外 home 子目录 mkdir 被 OS sandbox 拒绝（EROFS），不是磁盘损坏。
9. NO_PROXY `.local`：sandboxed curl 代理连通断言失败。

第 8 项已有明确的会话写权限证据；其余失败保留原始输出，未全部归因为同一种环境问题，亦未宣称是本次代码回归或已修复。
完整日志：`/tmp/btw-release-prep/check-all.log`、`bun-seccomp.log`、`check-all-static.log`。

**结论：本次三个候选插件的正式发布门槛与包检查通过；额外全仓检查尚未通过。**
本地提交不等于批准上传，不声称已满足全仓 OS 验证。后续需要全仓绿灯的 CI/发布操作，应在具备相应权限与网络条件的环境中重跑全仓检查并处理剩余失败。

## 额外全仓 strict 结果

追加执行 `openspec validate --all --strict` 退出 1：10 项通过，7 项因既有 requirement 文本过长的 warning 在 strict 下失败。
失败能力域为 agent-profiles、bash-wrapper-floors、context-cap、goal-lifecycle、notification-event-routing、pi-openspec-x、pi-sentinel；这些主规范本轮均未修改。
普通 `--all` 的 17 项通过不能替代此 strict 结果。
本轮实际同步的 `openspec validate transcript-builder-api --type spec --strict` 单独退出 0。
原始输出为 `/tmp/btw-release-prep/strict-final.log`，未通过改写无关规范来消除已有 warning。

## 保持的边界

- 真实 Pi 录屏验收沿用归档报告的已审证据，本次仅升级版本/依赖与文档，没有改动展示运行时代码，也未重跑旧场景。
- 不声称任意 Pi 版本、真实外部 SSH 或不同窗口宽度的像素级一致。
- `.pi/pi-goal-x-settings.json` 是原有本地配置改动，不在本次提交中。

## 后续：CI 干净 checkout 配置测试修复

实际发布任务 [41311668699 / 124863160288](https://github.com/xzzpig/pi-extensions/actions/runs/41311668699/job/124863160288)
在 npm 上传之前被 tool-display 测试阻止：773 项中 772 通过、1 失败。
`reload-behavior.test.ts:981` 无条件备份被忽略的包根 `config.json`，干净 checkout 不含该文件，抛出 ENOENT。
该备份文件也不是 load/save 默认操作的用户配置路径。本地恰好存在该 ignored 文件，掩盖了测试隔离缺陷。

修复仅涉及测试及维护记录：原用例使用独占临时配置路径并显式传给 load/save，finally 删除临时目录；原有断言全部保留。
新增两个 fork-only 回归分别验证缺失配置的读取/保存/清理，以及不调用 save 清缓存时，外部磁盘修改通过 fingerprint 被发现。
不提交本地配置、不在 CI 创建占位配置、不改生产代码，不需要再次提升尚未发布的版本。

验证证据：

- 修复前通过 `git archive HEAD` 导出已提交源码，过滤运行原用例：1 项失败，同样 ENOENT（`/tmp/pi-release-clean-repro-FxdjYI/result.log`）。
- 修复后在独立 detached worktree `/tmp/pi-config-reload-fix/clean` 覆盖测试修复，以 `pnpm install --frozen-lockfile` 重新安装依赖（没有沿用原工作区 node_modules），退出 0。
- 最初尝试共享已安装依赖时，pnpm 因 worktree 依赖状态不同而请求重新安装，并在无 TTY 环境中退出；未关闭依赖校验，改为上述独立冻结安装后重跑。
- 新增 helper 首次格式检查有 warning，随后仅格式化新 fork-only 文件并重新检查通过；未格式化 upstream 测试文件。
- 干净 worktree 中 tool-display typecheck 通过，完整测试 **775/775** 通过；测试前后包根 `config.json` 均不存在。
- 同一 worktree 执行正式候选命令 `node scripts/release.mjs --pack --only pi-btw,pi-subagents,pi-tool-display --output /tmp/pi-config-reload-fix/packs`，退出 0：components 39、BTW 259、tool-display 775 通过，subagents 4430 通过 / 16 跳过 / 0 失败；三个候选包实际打包成功，未上传。
- 候选门槛中的 fork-divergence 审计通过；本地原有包根配置哈希验证保持不变。

完整日志：`/tmp/pi-config-reload-fix/clean-install.log`、`clean-tests.log`、`clean-pack.log`；
最终包清单及 integrity 为 `/tmp/pi-config-reload-fix/packs/artifacts.json`。
此处通过的是本地干净环境候选验证，不冒充远端 Actions 已重新运行或发布成功，也不撤销前文额外全仓 OS/strict 限制。
