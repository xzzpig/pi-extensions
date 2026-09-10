# Design: add-agent-sandbox-profiles

## Context

参见 `proposal.md` 的动机。当前 `pi-subagents` 能按 agent 定义控制工具、skills 和 child-only extensions，但没有 sandbox 字段；其未知 frontmatter 不参与 launch contract。`pi-sandbox` 则仅按 `getAgentDir()/sandbox.json` 与 `<cwd>/.pi/sandbox.json` 加载配置，不知道 child 的 agent 身份。子代理是无 UI Pi 子进程，sandbox 的交互式询问在该环境中按 abort 处理，因此不能把 profile 设计为运行时请求额外权限的通道。

本设计新增的是两包之间的窄、版本化运行时契约，不让 `pi-subagents` 静态依赖 `pi-sandbox`，也不复用或改变 Permission System 的 permission-forwarding 协议。

## Goals / Non-Goals

**Goals:**

- 让 native Pi child 的 agent frontmatter 通过一个 profile 名选择 sandbox 策略。
- 让 profile 明确声明是否继承顶层全局 sandbox 配置，并在缺省时保持现有全局配置行为。
- 在显式 child extension allowlist、缺少 package、无 UI 和 capability ceiling 下保持 fail-closed。
- 让 profile 的策略来源保持在用户控制的配置面，避免 project agent 直接自授网络或文件系统访问。

**Non-Goals:**

- 不把 `sandbox` 变成任意 YAML/JSON sandbox 配置注入通道。
- 不为 `pi-sandbox` 增加父会话审批转发，不复用 Permission System 的 ask 协议。
- 不 sandbox `external-cli`、`external-job` 或其他不运行 Pi child runtime 的 runner。
- 不改变未声明 `sandbox` 的主会话或 child 的既有 sandbox 合并语义。

## Decisions

### 1. Frontmatter 只选择 profile 名称

agent 使用单值形式：

```yaml
sandbox: reviewer-strict
```

`pi-subagents` 将该值纳入 `AgentConfig`、运行时 agent 定义、序列化、preflight、async recovery descriptor 和 launch contract。名称使用受限标识符格式，拒绝空值、绝对/相对路径、分隔符和遍历片段。

不支持对象形式或 `sandbox: false`。对象形式会让 agent 定义成为权限授予源；`false` 会让一个角色级文件关闭本应由操作者强制的隔离。替代方案是让 agent 直接写完整 `SandboxConfig`，已拒绝，因为该方案使项目 agent 文件可以扩大 `allowedDomains` 或 `allowWrite`。

### 2. Profile 注册表只存在于全局 sandbox 配置

`<agentDir>/sandbox.json` 新增：

```jsonc
{
  "profiles": {
    "reviewer-strict": {
      "inheritGlobalConfig": true,
      "network": { "allowedDomains": [] },
      "filesystem": { "allowRead": ["."], "allowWrite": [] },
    },
  },
}
```

profile 字段沿用现有 `SandboxConfig` 的可配置部分，额外允许 `inheritGlobalConfig`。`profiles` 只能在用户全局配置定义；项目 `.pi/sandbox.json` 不得新建、覆盖或删除 profile。这样 project agent 只能请求一个操作者已注册的名字，不能携带任意配置。

`inheritGlobalConfig` 缺省为 `true`。该选择保证升级后，选用一个只补充少量限制的 profile 不会丢失原有全局 settings。设为 `false` 时，profile 从内建安全默认值起算，忽略顶层全局配置；这是由全局 profile 作者明确选择的隔离配置，而不是 agent 前端可自行决定的开关。

替代方案是将 profile 放入项目配置。已拒绝：它会使未受信任或被篡改的仓库定义新的网络/文件系统权限配置。

### 3. 有 profile 时采用显式的配置解析与拒绝保留规则

未选择 profile 时保留现有 `defaults -> global -> project -> session allowances` 行为。选择 profile 时，解析顺序为：

1. 内建安全默认值；
2. 当 `inheritGlobalConfig=true` 时，顶层全局配置（忽略 `profiles` 注册表）；
3. 可信项目配置；
4. 选中的全局 profile；
5. 仅内存的 session allowances。

profile 是角色边界，必须能缩小前面层提供的 allow 范围。因此 profile 显式提供的 `allowedDomains`、`allowRead` 和 `allowWrite` 替换其基线 allow list；未提供时继承基线。`deniedDomains`、`denyRead` 和 `denyWrite` 以并集保留，profile 无法移除已有拒绝。会关闭隔离的宽松布尔设置（例如网络完全不受限、较弱隔离）采用 deny-preserving 合成：基线限制不能被 profile 放宽；启用 sandbox 或收紧限制可以由 profile 完成。

可信项目配置沿用既有项目范围，但仅在 Pi 报告项目受信任后参与 profile 解析。未受信任项目不会影响 profile 选择或 profile 的有效 sandbox 配置。此处新增 trust gate，是为了避免新能力把 project agent 与 project sandbox 配置变成 child 权限扩大通道。

替代方案是沿用当前数组并集规则。已拒绝：严格审查 profile 无法通过空 `allowWrite` 或较小 allow list 收窄先前的全局/项目允许范围。

### 4. 使用环境变量传递选择，按需注入 sandbox extension

`pi-subagents` 在 child launch 中写入受限 profile 名到 `PI_SUBAGENT_SANDBOX_PROFILE`；不传递原始配置。`pi-sandbox` 在 child `session_start` 时读取该变量并调用 profile-aware config resolver。

当 agent 选择 profile 时，`pi-subagents` 像现有运行时 extension 一样解析已安装 `pi-sandbox` 的 manifest entry，并把该 entry 放入 child 的有效 extension 集合。这在 `extensions` allowlist 存在时仍然成立，并与 child-only extension 去重。若 package 不存在、manifest 无效、profile 无效、上层 `denyExtensions` 生效或 runner 不是 native Pi child，preflight/启动在模型首轮前报错；不得静默移除 sandbox 后继续。

保持可选动态发现，而非添加 `pi-subagents -> pi-sandbox` 运行时依赖，以维持两个独立可安装 package 的边界。

### 5. Headless profile 是预授权策略，不是审批代理

不改变 `pi-sandbox` 的无 UI 语义：未预先允许的网络、读或写访问返回 abort/block。profile 文档必须明确说明，子代理需要的范围应提前配置，`permissionPromptTimeoutSeconds` 不会在无 UI child 中产生父会话审批。

替代方案是把询问转发给父会话。已拒绝：这会复制 Permission System 的授权协议，扩大数据传输面，并把 OS sandbox 的即时阻断变成不具备现有身份/审计契约的异步审批机制。

## Risks / Trade-offs

- [Profile allow list 替换基线数组可能与既有数组并集直觉不同] → 仅在选择 profile 时采用该规则，在配置文档中给出完整有效配置示例，并覆盖空数组与缺省字段测试。
- [用户定义的 profile 本身可能过宽] → profile 只允许在用户全局配置定义，agent frontmatter 只能选择名称；保留硬拒绝规则，提供启动时有效 profile 摘要。
- [`pi-sandbox` 未安装或被 extension ceiling 禁止] → 在 preflight 中失败，禁止未 sandbox 的降级执行。
- [项目 config 的信任语义与当前 sandbox 不同] → 只将 trust gate 应用于 profile 路径，并在迁移文档中明确说明；无 profile 的历史行为保持不变。
- [无 UI child 因遗漏预授权而失败] → 错误包含访问种类、目标和有效配置来源；文档要求先用严格 profile 验证所需范围。

## Migration Plan

1. 以加法方式发布 `profiles` 和 `sandbox` frontmatter；未声明 profile 的现有 agent 与配置不变。
2. `inheritGlobalConfig` 缺省为 `true`，使现有全局策略成为新 profile 的默认基线。
3. 为 `pi-sandbox` 的示例配置增加一个只读 profile，并在 `pi-subagents` 文档中展示 child-only 使用方式。
4. 在发布前验证：agent 解析、profile 合并、扩展注入、launch preflight、无 UI 阻断、可信/未受信任项目，以及 async recovery 的 descriptor 往返。
5. 回滚时删除 agent 的 `sandbox:` 字段或移除 profile；child 恢复现有非 profile 配置路径，不需要迁移持久化 session allowance。
