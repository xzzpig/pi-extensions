# Proposal: add-agent-sandbox-profiles

## Why

`pi-subagents` 的自定义 agent 目前只能选择是否加载 `pi-sandbox`，不能为不同角色的子代理选择不同的沙盒策略。所有 child 都共享按全局目录和项目 `cwd` 解析的配置，导致只读审查、普通实现和需要网络访问的 agent 无法通过 agent 定义表达各自的最小权限范围。当前 sandbox 还没有把无 UI child 的交互式授权与预配置 profile 区分开，子代理遇到未预授权的访问时缺少清晰、可验证的配置契约。

## What Changes

- 为 `pi-subagents` 自定义 agent 增加 `sandbox:` frontmatter，用于选择命名 sandbox profile，并将选择传递到 child Pi 进程。
- 为 `pi-sandbox` 增加命名 profile 配置，覆盖网络、文件系统和启用状态等现有沙盒设置。
- 为每个 profile 增加 `inheritGlobalConfig` 选项，明确 profile 是否以全局 `sandbox.json` 配置为基线；默认值保持继承，以兼容现有配置。
- 定义全局配置、项目配置、profile 和 agent frontmatter 的优先级、合并规则及只能收紧权限的安全边界，防止不受信任的 agent 定义扩大文件或网络访问范围。
- 确保选择 profile 的 child 必须加载 `pi-sandbox`；显式 extension allowlist、缺少 profile、无 UI 授权请求和不支持平台都采用可诊断的 fail-closed 行为。
- 增加配置校验、child 启动传递、profile 合并、无 UI 阻断和回归测试，并更新 agent 与 sandbox 文档。

## Capabilities

### New Capabilities

- `agent-sandbox-profiles`: 通过 agent frontmatter 选择并在子代理中应用命名 sandbox profile，包括全局配置继承、权限合并、扩展加载和无 UI child 行为。

### Modified Capabilities

<!-- 当前 openspec/specs 中没有描述 pi-sandbox 或 agent sandbox 的既有 capability，因此不修改现有 capability。 -->

## Impact

- 影响 `packages/pi-subagents` 的 agent frontmatter 类型、发现/校验逻辑、Pi child 启动参数和环境传递。
- 影响 `packages/pi-sandbox` 的配置模型、配置加载和运行时 sandbox 初始化流程。
- 影响 `sandbox.json` 的 schema/示例和 `pi-subagents`、`pi-sandbox` 的 README/配置文档。
- 增加两个包之间关于 profile 名称、配置来源和安全合并语义的运行时契约；不新增对 Permission System 的依赖。
