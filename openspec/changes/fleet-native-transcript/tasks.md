# Tasks: fleet-native-transcript

## 1. pi-components 公开构造 API（transcript-builder-api）

- [ ] 1.1 在 `packages/pi-components/src/transcript.ts` 将 entries 状态操作提升为公开导出：条目追加、回合开始/结束/移除、按类型查找最近条目、文本与工具结果 upsert、通知追加；签名与现有内部实现保持一致，行为不变
- [ ] 1.2 补充 vitest 用例覆盖新导出 API 的规格场景：历史回放写入、回合幂等结束、toolCallId 配对（含结果先到）、超限参数降级不抛异常、移除回合后组件注册表清理、既有导出回归
- [ ] 1.3 运行 `pnpm --filter @xzzpig/pi-components run typecheck && pnpm --filter @xzzpig/pi-components test` 全绿；版本号升至 0.3.0 并更新 CHANGELOG

## 2. pi-btw 迁移到共享 API

- [ ] 2.1 记录迁移前基线：运行 `pnpm --filter @xzzpig/pi-btw test` 确认全绿并留存输出
- [ ] 2.2 在 `packages/pi-btw/extensions/btw.ts` 删除手写状态机函数（appendTranscriptEntry / ensureTranscriptTurn / finishTranscriptTurn / removeTranscriptTurn / findLatestTranscriptEntry / upsert 系列），改为导入 pi-components 共享导出；逐个核对签名语义一致后再删除
- [ ] 2.3 运行 btw 测试套件并与基线比对，全部通过且无行为差异；确认渲染输出语义不变
- [ ] 2.4 如产生本地分歧，更新 `subtrees/pi-btw.json` 的 notes 字段记录分歧内容

## 3. pi-subagents 适配层与接入

- [ ] 3.1 新建 `packages/pi-subagents/src/tui/fleet-native-transcript.ts`：复用现有 trusted-root 尾部读取入口，将子代理 JSONL 记录转换为 TranscriptEntry（message→user/assistant/thinking、tool_start+argsPayload 解析→tool-call、toolResult→tool-result、stderr→notice、truncated 标记处理）；entries 构造统一经过安全文本处理
- [ ] 3.2 实现截断降级：`JSON.parse(argsPayload)` 失败时以空参数写入 tool-call 并保留完整结果，保证条目仍可渲染
- [ ] 3.3 实现渲染包装：按缓存世代构造 TranscriptToolComponents（携带 cwd、expanded、宽度），调用原生渲染链路产出详情面板行；结构化 header 的 conversation state 行在两条链路下保持
- [ ] 3.4 在 `fleet.ts` 的 `wrappedDetail()` 接入：动态 import + 导出存在性探测，失败或缺失时回退现有 `readFleetTranscript + renderFleetTranscript` 路径；`x` 键位通过缓存失效实现全局展开切换；保留 fingerprint 缓存机制
- [ ] 3.5 `package.json` 增加 `dependencies: @xzzpig/pi-components`（workspace 协议）；确认对 Pi <0.83 宿主的降级路径可用（模拟缺失导出场景）
- [ ] 3.6 新增渲染界面切换：注册可重映射键位动作（默认 `v`），组件实例持有会话级布尔状态；切换时使 transcript 缓存失效并按当前模式重渲；页脚提示同步更新；Prompt Audit 模式下不响应；组件不可用时按键给出明确提示

## 4. 验证与治理收尾

- [ ] 4.1 单元测试：为适配层补充 JSONL→entries 转换用例（正常流、截断参数、stderr、truncated 标记、配对边界）；运行 pi-subagents typecheck + 测试全绿
- [ ] 4.2 交互回归清单手工验收：x 展开切换、v 渲染界面切换（原生⇄文本双向、切后选中保持、操作不受影响）、p Prompt Audit、H Herdr、s steer、D stop、roster 选择切换、宽度拖拽重排、运行中内容追加自动跟随；foreground-active/recent、external 详情视图与文本版 status 无变化
- [ ] 4.3 视觉验收：最小宽度（60 列）下 bash 输出折叠/展开、edit diff、read 预览、thinking 折叠的呈现；确认溢出有截断保护
- [ ] 4.4 按 AGENTS.md 执行整体验证：`direnv reload`、相关包 typecheck/test、prettier 检查（注意 subtree 包的 ignore 范围）
- [ ] 4.5 更新 `subtrees/pi-subagents.json` notes 记录本地分歧（新增文件 + fleet.ts 分支 + 依赖声明）；如组件包已发布，确认 npm 版本同步策略
