## 1. pi-subagents 公开发现 API

- [x] 1.1 在 `src/api/agents.ts` 增加 agent 发现导出（转发 runtime 合并版 `discoverAgentsForRuntime` 或其最小投影，含 source/diagnostics），保持既有导出不变
- [x] 1.2 为新增导出补充公开类型与测试（runtime 注册 agent 出现在发现结果中），typecheck + 单测通过

## 2. pi-sandbox SandboxService

- [x] 2.1 新增 `src/service.ts`：`getSandboxService(sessionId?)`（Symbol.for 注册表，session_start 注册 / session_shutdown 注销），接口 `setProfile(name|undefined): Promise<{ok, message?}>`、`getProfile()`、`listProfiles()`；setProfile 校验 `validateSandboxProfileName` + 全局注册表存在性，失败返回 ok:false 且不改状态
- [x] 2.2 setProfile 成功路径：更新内部选名并接入 `resolveSandboxConfig` 的 profileName 路径；沙箱未启用时不强制开启并返回警告消息（“profile 已应用但沙箱未启用，隔离未生效”）；未注册会话的调用安全返回
- [x] 2.3 测试：合法/非法/不存在 profile、未启用沙箱警告、按 session 注册注销、`listProfiles` 仅全局注册表；typecheck + 单测通过

## 3. pi-agent-role 插件骨架

- [x] 3.1 `packages/pi-agent-role`：package.json（peerDependencies 可选：@earendil-works/pi-coding-agent、@xzzpig/pi-subagents、@xzzpig/pi-sandbox，publishConfig public）+ pi.extensions 清单 + index.ts + 空扩展注册，versions.json 增加 `pi-agent-role: 0.1.0`
- [x] 3.2 内存态模块：`agentName?`/`sandboxProfile?`/`permissionProfile?` 三字段，显式 > agent 声明 > 无 的生效解析，切 agent 重置显式覆盖，session_start 检测并清除残留 active_agent 条目
- [x] 3.3 agent 发现集成：经 pi-subagents 公开 API 拉取列表（含 runtime 注册 agent 与 source/diagnostics），缺 pi-subagents 时 /role 明确报错

## 4. 命令与图形选择器

- [x] 4.1 `/role` 面板：`ctx.ui.custom` 选择器（jk/↑↓ 导航、Enter 确认、Esc 取消、none 选项、agent 行 profile 徽章、空态提示），无参显示当前角色状态
- [x] 4.2 `/sandbox-profile` 与 `/permission-profile` 单选选择器（数据源：getSandboxService().listProfiles() / 全局 config.json profiles 键），含 none 选项
- [x] 4.3 命令完成后的全部广播：appendEntry('active_agent', {name|null})、env[PI_SUBAGENT_PERMISSION_PROFILE] 写入/清除、getSandboxService().setProfile()；任一广播失败的命令结果提示（不静默）
- [x] 4.4 信任门：项目作用域 agent（source/override.scope === 'project'）且 `ctx.isProjectTrusted?.() !== true` 时拒绝切换并提示；显式 profile 切换无门

## 5. 底部状态栏

- [x] 5.1 `setStatus('role', text)`：agent 场景 `role: worker`；仅显式 profile 场景 `role: sandbox <p>` / `role: perm <p>`；none → undefined 清除；headless（mode !== 'tui'）跳过；try/catch 容错
- [x] 5.2 状态更新时机：切换命令确认后立即更新 + session_start 初始化（none 不展示）

## 6. 测试与验证

- [x] 6.1 单测：内存态优先级与重置、广播三通道（mock pi）、信任门两分支、footer 更新与清除、选择器数据源映射
- [x] 6.2 两依赖包回归：pi-subagents（新增导出测试）、pi-sandbox（SandboxService 测试）；全仓 prettier、两包 typecheck 与测试全绿
- [x] 6.3 文档：pi-agent-role README（命令、语义、依赖）、pi-sandbox 文档补充 SandboxService、pi-subagents 文档补充发现 API

## 7. 发布准备

- [x] 7.1 版本：pi-subagents 0.12.0 → 0.13.0、pi-sandbox 0.5.0 → 0.6.0、pi-agent-role 0.1.0；versions.json、三包 CHANGELOG、pnpm-lock.yaml 同步
- [x] 7.2 真机 E2E（隔离 agent 目录 + 真实 pi 运行时），可复跑脚本 `/tmp/pi-e2e-role-v3-run.sh`，证据在 `/tmp/pi-e2e-role-v3/artifacts/`：
  - 角色身份：footer `role: role-auditor`、会话 JSONL `active_agent` 条目、工具调用归因 `agentName: role-auditor`；`/role none` 后 footer 只余显式 profile、JSONL 写 `{name:null}`
  - 权限策略真正生效：`/permission-profile role-locked` 后 `touch blocked-probe.txt` 被拒，审查日志 `permission_request.blocked` + `resolution: policy_denied` + `decidedBy.kind: rule, origin: profile, pattern: "touch *"`，全程无对话框裁决；文件未创建
  - 沙箱 profile 真正驱动 OS 级策略（同一命令 A/B）：可写 profile 下 `sh -c 'echo x > os-probe-writable.txt'` 成功（文件存在、footer `1 write paths`）；切到禁写 profile 后同一命令以 `Read-only file system` 失败（退出码 1、文件不存在、footer `0 write paths (role-locked-sandbox)`），证明切换确实重新初始化并改变强制力
  - 读路径 profile 硬阻断：`read` 读取 profile `denyRead` 中的文件被 `Sandbox profile 'role-locked-sandbox': ... (in denyRead)` 直接阻断，无提示
  - 子代理隔离（R7，同一会话内 A/B/C 三段）：父会话 `touch parent-before.txt` 被自身角色 profile 策略拒绝（审查日志 `policy_denied` + `origin: profile`）→ 前台 worker 子代理执行同一 `touch subagent-probe.txt` **成功**（文件存在）且审查日志无其条目（未被父会话规则拦截）→ 子代理结束后父会话 `touch parent-after.txt` 仍被策略拒绝（子代理创建窗口未污染父会话环境）；全程 **0 条对话框裁决**（无用户介入也成立）
  - 冻结契约：启动器为每条子代理启动路径固定 profile 键并写 `PI_SUBAGENT_PERMISSION_PROFILE_PINNED` 标记，pi-permission-system 仅在看到该标记时固化选择（避免把 pi-subagents 在根会话设置的 `PI_SUBAGENT_PARENT_SESSION` 误判为“本进程是子代理”而冻结宿主选择）
- [x] 7.3 发布前准备（build:types 若适用、pack 验证、exports 完整性），openspec validate --strict 通过；不执行 publish — evidence: 三包均无 build:types 脚本（无需 dist）；`pnpm pack` 产出 xzzpig-pi-agent-role-0.1.0.tgz（12.0KB / 11 文件）、xzzpig-pi-sandbox-0.6.0.tgz（2.68MB / 299 文件）、xzzpig-pi-subagents-0.13.0.tgz（1.29MB / 321 文件），逐个校验 package.json 的 exports 与 pi.extensions 目标在包内均存在、bundledDependencies 已内联（sandbox-runtime、pi-components）、无 .env/.git 凭据，pi-agent-role 与 pi-subagents 的 files 白名单生效（不含 test/）；`npm publish --dry-run` 无 provenance 阻塞；openspec validate --strict 通过；未执行 publish。
