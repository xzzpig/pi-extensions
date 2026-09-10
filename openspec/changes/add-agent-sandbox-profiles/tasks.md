# Tasks: add-agent-sandbox-profiles

## 1. Sandbox Profile 配置模型

- [x] 1.1 在 `pi-sandbox` 中定义命名 profile、`inheritGlobalConfig`、profile 名称校验和 child profile 环境变量的公开类型/常量。
- [x] 1.2 扩展全局 `sandbox.json` 解析与校验，支持全局 `profiles` 注册表，同时保持未使用 profile 时的既有配置格式和行为。
- [x] 1.3 实现 profile 有效配置解析：处理默认继承、`inheritGlobalConfig: false`、可信项目层、allow list 收紧/替换、deny list 保留和宽松布尔值的 fail-closed 合成。
- [x] 1.4 为 profile 解析、无效配置、未知 profile、全局继承开关、项目信任和 hard-deny 保留补充单元测试。

## 2. Agent Frontmatter 与 Child Launch Contract

- [x] 2.1 在 `pi-subagents` 的 agent 定义、运行时 registry、序列化和 agent-management/eject 路径中增加并校验标量 `sandbox: <profile-name>` frontmatter；拒绝对象、空值和不安全名称。
- [x] 2.2 将 sandbox profile 纳入 preflight、launch contract、前台/后台启动、workflow、async recovery descriptor 和 resume 路径，确保 profile 身份不会在持久化或恢复时丢失。
- [x] 2.3 为请求 sandbox profile 的 native child 按需解析并注入 `pi-sandbox` extension；在显式 extension allowlist 下去重保留，在 package 缺失、manifest 异常、`denyExtensions` 或非 native runner 时于模型首轮前 fail closed。
- [x] 2.4 将受限 profile 名通过 child 环境变量传递，不传递原始 sandbox 配置；补充 agent 发现、Pi args、preflight、前台/异步和 recovery 的回归测试。

## 3. Child Sandbox Runtime

- [x] 3.1 让 `pi-sandbox` 在 child `session_start` 识别 sandbox profile 环境变量，并使用 profile-aware resolver 初始化 bash、read、write 与 edit 的有效策略。
- [x] 3.2 为 profile 启动添加可诊断状态与错误信息，涵盖未知 profile、无效 profile、平台/依赖初始化失败和 child extension 未能加载；不得降级为未 sandbox 执行。
- [x] 3.3 保持无 UI child 的预授权 fail-closed 行为：未允许的域名、读取和写入访问必须阻断，不新增父会话转发或持久化 session allowance。
- [x] 3.4 添加 runtime/integration 测试，覆盖有效 profile 的工具拦截、无 UI 网络与文件阻断、显式 extension allowlist 和未声明 profile 的历史行为。

## 4. 安全边界与兼容性

- [x] 4.1 实现项目 trust gate：未受信任项目不得通过项目 agent 的 `sandbox` 选择或项目 sandbox 配置改变 profile child 的有效策略，并提供可操作诊断。
- [x] 4.2 验证 agent frontmatter 只能选择已注册的全局 profile，不能携带原始网络/文件系统授权，也不能关闭强制 sandbox 或删除继承的硬拒绝。
- [x] 4.3 覆盖 capability ceiling、外部 runner、profile extension 重复加载和正常 ambient sandbox 加载的边界测试。

## 5. 文档与验证

- [x] 5.1 更新 `pi-subagents` agent 文档，说明 `sandbox: <profile-name>`、extension 选择、支持的 runner、fail-closed 启动条件和与 Permission System 的边界。
- [x] 5.2 更新 `pi-sandbox` README、配置示例与命令状态说明，记录 `profiles`、`inheritGlobalConfig`、profile 合并/拒绝保留规则、项目 trust 和 headless child 预授权限制。
- [x] 5.3 运行受影响包的 typecheck、单元/集成测试和格式检查，并执行 `openspec validate add-agent-sandbox-profiles --strict`。
