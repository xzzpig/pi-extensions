## 1. pi-permission-system Profile 注册表

- [ ] 1.1 在 `config-schema.ts` 新增 `profiles` 注册表 schema（键为 profile 名称，规则集复用 `permission` schema：工具→决策标量 + bash/mcp/skill/external_directory/special 模式映射 + `'*'` 兜底），并让 `validateUnifiedConfig` 区分全局/项目（项目配置出现 `profiles` 键 → schema 拒绝 → 项目作用域 invalid）；验证：`validateUnifiedConfig(projectConfig, { allowProfiles: false })` 单测拒绝带 `profiles` 的项目配置
- [ ] 1.2 在 `config-loader.ts` 让 `loadUnifiedConfig` 返回全局 `profiles`（`mergeUnifiedConfigs` 不合并 profiles，仅全局携带）；验证：全局配置解析单测断言 profiles 透传、项目路径恒为空
- [ ] 1.3 在 `policy-loader.ts` 的 `loadScopeConfigFrom` 额外提取前端块 `permission-profile`（`parseSimpleYamlMap` + 名称格式校验，格式与 sandbox 一致：`^[A-Za-z0-9][A-Za-z0-9_-]*$`、≤128、拒绝空值/路径/字面 `false`），`ScopeConfig` 增加 `profileName`，并新增从 `PI_SUBAGENT_PERMISSION_PROFILE` 环境变量读取 profile 名称的入口；验证：前端块含/不含该键的解析单测 + 名称格式校验单测
- [ ] 1.4 新增 profile 解析单测（含非法规则条目宽容丢弃、`'*'` 兜底、空规则集判定）；验证：`pnpm --filter pi-permission-system test` 通过

## 2. 作用域装配与失败关闭

- [ ] 2.1 在 `rule.ts` 的 `RuleOrigin` 联合类型新增 `'profile'`，并确认 review 日志/决策溯源路径能承载该值；验证：类型检查通过且溯源单测覆盖 `origin: 'profile'`
- [ ] 2.2 在 `permission-manager.ts` 的 `resolvePermissions` 将 profile 作为独立作用域插入合并序列 `[global, project, profile, agent, project-agent]`（复用 `mergeScopesWithOrigins`），profile 名称优先级为 env > 项目 agent 文件 > 全局 agent 文件，未知名称或空规则集 → 判定为 invalid `'profile'` 作用域 → `floorAllowsToAsk`，`failClosedScopes` 消息输出 "Invalid profile configuration detected"；验证：合并/失败关闭单测 + `getConfigIssues` 诊断单测
- [ ] 2.3 新增作用域合并行为单测：profile 为基底、`permission:` 逐模式覆盖、未提及的全局 deny 保留、规则分别溯源；验证：`pnpm --filter pi-permission-system test` 通过
- [ ] 2.4 新增跨会话 0008 场景单测：服务端按请求者 agent 名解析策略时应用其 profile 规则；验证：对应单测通过

## 3. pi-subagents Frontmatter 与启动传递

- [ ] 3.1 在 `agent-serializer.ts` 的 KNOWN_FIELDS、`runtime-agent-registry.ts` 的校验白名单新增 `permission-profile`，在 `agents.ts` 解析/序列化/内置覆盖路径支持该字段（名称格式校验与 sandbox profile 同款）；验证：字段 round-trip 单测 + 非法名称加载期拒绝单测（agent not runnable）
- [ ] 3.2 在 `child-launch.ts` 注入 `PI_SUBAGENT_PERMISSION_PROFILE`（仅名称），`subagent-runner.ts` / `subagent-executor.ts` 透传，`async-resume.ts` 恢复描述符白名单、`async-status.ts` / `nested-events.ts` 投影、`agent-management.ts` 对照 sandbox 落点逐项镜像；验证：env 注入单测 + 恢复描述符 round-trip 单测
- [ ] 3.3 新增双通道一致性单测（env 与前端块同源同值，env 优先）；验证：对应单测通过

## 4. 安全边界与兼容性

- [ ] 4.1 验证信任门：项目 agent 文件的 `permission-profile` 仅在项目受信时参与解析，未受信时忽略并记录（既有 22.0.0 起机制）；验证：未受信项目场景单测
- [ ] 4.2 验证缓存戳：修改全局配置（含 profiles）或 agent 文件后解析缓存失效重算；验证：`getCacheStamp` 相关单测通过
- [ ] 4.3 验证 yoloMode 组合语义：profile 规则与全局 yolo 组合后仍 deny-preserving；验证：组合单测通过
- [ ] 4.4 验证旧版互操作：旧 pi-permission-system 忽略 env 与前端块新键（行为等同未声明，纯增量）；验证：README/CHANGELOG 记录兼容性声明

## 5. 文档与发布准备

- [ ] 5.1 更新 `packages/pi-permission-system/docs/configuration.md`（profiles 语法、合并顺序、失败关闭、示例）与 `packages/pi-subagents/docs/agents.md`（`permission-profile` 字段、双通道、示例）；验证：prettier 检查通过
- [ ] 5.2 全量验证：两包 typecheck、pi-permission-system 全量单测、pi-subagents 单测、`openspec validate add-agent-permission-profiles --strict`、prettier；验证：全部命令零失败
- [ ] 5.3 版本与发布准备：pi-permission-system 0.6.0 → 0.7.0、pi-subagents 0.11.0 → 0.12.0，同步 `versions.json`、CHANGELOG 条目、lockfile（发布动作按 pi-publish 技能流程）；验证：三处版本号一致且 `pnpm install --lockfile-only` 干净
