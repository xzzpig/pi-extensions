# Tasks

## 1. 实施前的真实设备验收准备

- [x] 1.1 在 direnv 环境核实 bubblewrap、真实 Pi、测试凭据和宿主额外设备可用性；优先 `/dev/kvm`，记录节点类型、主次设备号及非破坏探测方案，确认该节点不在最小 `/dev` 中；无可用设备时报告所需环境，禁止把真实设备验收记为完成。
- [x] 1.2 编写 fork-only 安全设备探测程序及 E2E 操作说明；KVM 使用打开节点与 `KVM_GET_API_VERSION == 12`，其他设备必须注明安全操作及预期结果；验证宿主探测成功且不修改设备状态，不创建设备替身。

## 2. sandbox-runtime 设备授权与挂载

- [x] 2.1 新增可选设备 schema 与 fork-only 路径/节点校验 helper，并接入每次执行前校验；以单元测试覆盖类型、规范路径、逐组件链接、字符/块设备、缺失及非设备文件、目录/通配符拒绝和去重，错误包含字段及路径。
- [x] 2.2 打通 manager 与 Linux 参数传递，在 `--dev /dev` 后追加严格逐节点 `--dev-bind`；以参数断言和真实 bubblewrap 集成测试验证顺序、嵌套路径、基础设备兼容、设备消失失败及不回退为未沙箱执行。
- [x] 2.3 接入有效 denyRead/denyWrite 冲突检测，覆盖自身、祖先、模式和 profile 保留的拒绝；测试设备挂载不能恢复显式拒绝，普通 allowRead/allowWrite 不授予设备。
- [x] 2.4 修正仅设备隔离时的无规则快速路径，非 Linux 非空列表明确报不支持；回归验证文件系统/网络均 disabled 时仍保留最小设备视图、显式设备列表有效，非 Linux 空列表兼容。
- [x] 2.5 在 runtime fork-only 文档说明字段、平台限制、deny/disabled 关系、设备风险及 TOCTOU/宿主权限边界；运行该包 typecheck 和相关单元/集成测试，核对文档示例与 schema 一致。

## 3. pi-sandbox 配置来源与 profile

- [x] 3.1 接入设备字段的全局/可信项目合并和 `buildRuntimeConfig` 透传；以配置及 session 测试覆盖无 profile、profile、service、child 入口的 trust true/false/unknown，确认未明确受信项目不能授予设备且有诊断，不改变其他普通配置语义。
- [x] 3.2 接入 profile 字段校验及合并：省略继承、显式替换、空数组清空、同名项目替换、inheritGlobalConfig=false；以 fork-only 测试核对各结果、运行时注册 profile、跨会话隔离及后续新命令撤销。
- [x] 3.3 审核并收紧设备配置/初始化失败路径，禁止静默降级未沙箱执行，禁止普通写提示或自动重试升级设备权限；以失败注入回归证明错误阻断当前执行，frontmatter 仍仅接受名称。
- [x] 3.4 添加插件 fork-only 使用说明和 E2E 指南的配置示例、授权风险及限制；运行 `pnpm --filter @xzzpig/pi-sandbox run check` 和该包测试，核对全局、可信项目与 profile 示例。

## 4. 真实 Pi 与真实额外设备 E2E（硬性完成门槛）

- [x] 4.1 在独立 `/tmp` 测试目录隔离所有发现通道，加载本次 pi-sandbox，以真实 Pi 模型调用 bash 执行真实设备探测；验证未授权失败、全局授权后打开和安全操作成功、撤销后新命令失败，保留宿主对照与 session 工具调用/结果、节点身份及退出码；不得用 mock、基础设备别名、节点可见或测试 skip 代替。
- [x] 4.2 以同一真实设备验证可信项目授权成功、未受信项目授权不生效，以及 profile 继承/空数组撤销；授权时同时验证普通白名单外写入和本地可控的受禁网络访问仍被阻断，排除沙箱整体未启用导致的假阳性。
- [x] 4.3 打包 pi-sandbox tarball（内含本次 runtime），从临时目录加载该产物并重复真实设备的未授权/授权安全操作/撤销三阶段；保存 tarball 校验值与实际入口证据，确认包内 helper 和配置字段未丢失，不发布 npm。
- [x] 4.4 汇总 E2E 的配置、实际启动命令、设备探测、工具结果、session 与退出码；若使用 TUI，按 tmux skill 预检宿主 server，对所有运行录制 asciinema 并回放确认。缺设备、缺权限、仅 mock 或未运行真实 Pi 时保持本组任务未完成，明确报告阻塞，禁止宣称修复验收完成。

## 5. 跨包回归与维护门禁

- [x] 5.1 按实际 upstream seam 更新两包 subtree 的 reapplyOnSync/doNotReintroduce 及必要 knownDebt（fork-only 自有逻辑不补无关条目），运行 `pnpm run audit:fork-divergence`，要求非零 checked、undeclared=0，修复新增噪音并报告审计摘要。
- [x] 5.2 在 direnv 环境运行 runtime typecheck/test/build、pi-sandbox check/test、包内非改写 lint/格式检查及新文件格式检查；复核只包含设备修复及其测试文档、没有 credentials/录像/用户状态文件，逐项关联规范场景与实际测试证据，所有具体失败解决后才报告完成。

验收例外：用户明确确认沿用既有宿主/HEAD 基线例外并交付设备修复；runtime 全套 14 项失败未被宣称通过，原始结果、对照和接受范围见 verification.md。

## Workflow follow-up

- 实现与真实设备验收完成后，再按用户指示归档此变更；归档不是本次 tracked task。
- 本次不授权 git commit、push、npm 发布或版本变更。
