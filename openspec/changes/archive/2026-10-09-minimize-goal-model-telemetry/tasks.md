# 新范围实施任务

用户已确认只精简新生成内容，不处理 session 中旧消息/旧工具结果；旧范围勾选不能证明本轮完成。任务按新范围重新验收。

## 1. 先同步契约

- [x] 1.1 同步 proposal/spec/design/tasks/validation 为新生成边界，明确旧消息允许重放；不再要求旧 JSON 片段/cursor 链清洗。验证：七项 Requirement/十九场景映射一致，严格 OpenSpec 校验通过。

## 2. 精简生成与接缝

- [x] 2.1 删除 goal-history-view.ts 及旧消息投影/布局匹配/gate 追溯/JSON 片段解析，context handler 仅保留既有过滤规范化和新 prompt helper。验证：无历史投影调用残留，不读取宿主上下文使用量，typecheck 通过。
- [x] 2.2 核对新 context/state、get_goal summary/verbose、创建/草稿/完成和审计反馈，保留真实 spending/run 约束与 UI/details/usage/auditor 语义。验证：新生成各渠道正负回归通过。
- [x] 2.3 新历史查询仅在分页前选择事件字段；撤销旧投影版本/revision-token 缓存接缝，保留普通内容 cursor 校验、objective/tasks 页和压缩恢复。验证：新查询分页与原始数据不变、恢复和执行 gate 测试通过。

## 3. 新范围回归

- [x] 3.1 删除旧历史清洗专用用例和 SDK 历史夹具；保留新输出、约束、free text、UI 与原始数据兼容测试，新增“旧消息原样保留”效果边界用例。验证：unit、core/recovery 及两种 SDK pre-dispatch 捕获通过，无 HTTP 请求。
- [x] 3.2 用既有 writer 更新 manifest，test:selfcheck 通过；对无预算遥测变化、有限/零/隐藏 runs、预算删除的当前 live retention 继续回归。

## 4. 文档与分歧

- [x] 4.1 更新 fork 使用说明、changelog 和 subtree metadata，清理只服务旧历史清洗的维护条目；按 upstream inventory 核验最小接缝，不扩写 README。验证：direnv/schema、fork audit checked 非零、undeclared=0、stale=0。
- [x] 4.2 核对真实 worktree/index 与用户 settings 修改边界。验证：适用 Prettier、git diff --check 与 cached check 通过；无版本/lockfile/baseline/其它包/session/ledger 的改动。

## 5. 复跑与交付

- [x] 5.1 安装冻结依赖，复跑 typecheck、test:all、test:selfcheck、模型视图/SDK、context:gate/provider-check；只允许目标逐项批准例外，出现新失败须询问。记录实际输出、计数、退出状态，不沿用旧绿灯。
- [x] 5.2 汇总十九场景与受影响 D/I 基线的测试/真实证据，复跑 fork audit、格式/diff 与严格 OpenSpec，tasks 全部闭合后才请求独立 completion audit。不归档、不提交、不发布、不推送。
