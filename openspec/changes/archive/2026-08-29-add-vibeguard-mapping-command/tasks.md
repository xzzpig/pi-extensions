# Tasks: add-vibeguard-mapping-command

## 1. 导入上游 subtree（`pi-upstream-subtree` skill）

- [x] 1.1 阅读并遵循 `.pi/skills/pi-upstream-subtree/SKILL.md`；添加 remote `upstream-pi-vibeguard` → `https://github.com/aizigao/pi-vibeguard.git`（不得覆盖既有 remote），fetch 并确认 HEAD `672121246907a60e646bb3d2e8a1940371f4c904`
- [x] 1.2 `git subtree add --prefix=packages/pi-vibeguard --squash upstream-pi-vibeguard 672121246907a60e646bb3d2e8a1940371f4c904`（导入授权由本变更隐含，仅本地提交、不 push）
- [x] 1.3 新建 `subtrees/pi-vibeguard.json`：source/ref/upstreamCommit/squash 按 schema，`notes` 记录"本地附加 /vibeguard:list 与 /vibeguard:stats 命令（映射查看）"；`direnv reload` 通过 schema 与 ref 校验

## 2. Post-import 适配（`pi-plugin-maintainer` skill）

- [x] 2.1 阅读并遵循 `.pi/skills/pi-plugin-maintainer/SKILL.md`；`package.json` npm 名更名 `@xzzpig/pi-vibeguard`，新增 `peerDependencies["@earendil-works/pi-tui"]`（版本范围对齐 `packages/pi-tool-display/package.json`）与对应 `devDependencies`（`catalog:`）
- [x] 2.2 `pnpm install` 后运行仓库校验：typecheck、`pnpm exec prettier --check .`（含新包）全部通过；`direnv reload` 无报错

## 3. 数据访问层（index.ts 内附加，零引擎改动）

- [x] 3.1 在 `index.ts` 头部新增集中 import 块（`@earendil-works/pi-tui` 类型/组件）
- [x] 3.2 实现映射快照函数：基于 `session.prefix` 动态转义构造解析正则，遍历 `session.forward` + `session.created`，产出 `{ category, placeholder, original, createdAt }[]`；剥壳失败降级 category=`UNKNOWN` 且不丢弃条目；TTL 过期条目天然不在表中（依赖现有 `cleanup`，不重复实现清理）
- [x] 3.3 实现打码函数：长度 >7 保留前 3 + `…` + 后 4；≤7 整体 `•`
- [x] 3.4 单元测试（沿用 monorepo 测试范式）：category 解析（常规格式 / `_<N>` 碰撞后缀 / 自定义 prefix / 异常格式降级 UNKNOWN）、打码边界（8 字符、7 字符、4 字符）、快照只读不触发 `cleanup`/驱逐副作用

## 4. `/vibeguard:list` TUI 组件

- [x] 4.1 基于 `ctx.ui.custom` 实现列表组件：CATEGORY | PLACEHOLDER | ORIGINAL 三列表格 + 每条剩余 TTL（分钟粒度），支持上下滚动（参考 `pi-tool-display/src/config-modal.ts` 的组件模式）
- [x] 4.2 `r` 键全局切换打码/明文，切换时保持滚动位置与条目顺序；标题栏展示条目总数与当前明暗状态（明文时显著提示）；`q`/Esc 关闭
- [x] 4.3 空态与未启用态：无存活映射提示"当前会话暂无存活映射"；配置缺失或 `enabled=false` 时提示未启用原因（含配置查找路径），不渲染空表格
- [x] 4.4 注册 `/vibeguard:list`（冒号命名空间，description 文案），命令处理器只走 `ctx.ui.custom`/`ctx.ui.notify`，不写任何会话消息

## 5. `/vibeguard:stats` 汇总

- [x] 5.1 按 category 分组计数、降序条形图展示（数据量小可复用 list 组件的简化形态或 `ctx.ui.notify`）
- [x] 5.2 与 `/vibeguard:list` 同源同刻：各 category 计数之和恒等于存活映射总数；空态/未启用态行为与 list 一致
- [x] 5.3 注册 `/vibeguard:stats` 及描述文案

## 6. 集成验证与环境切换

- [x] 6.1 全量校验：typecheck、测试、`pnpm exec prettier --check .`、`openspec validate --strict` 全部通过
- [x] 6.2 手动验收：构造含手机号/API key/JWT 的会话触发脱敏，逐项核对 spec 场景（存活列表、TTL 过期消失、打码/明文切换、短原文全 `•`、stats 排序与一致性、空态/未启用态）
- [x] 6.3 上下文零污染验证：执行命令后检查会话无新增消息、后续 provider 请求不含命令输出
- [x] 6.4 环境切换：卸载全局 `@aizigao/pi-vibeguard`，安装本 fork，重启 pi 确认无 `:1`/`:2` 命令后缀、脱敏与 tool_call 还原正常
- [x] 6.5 更新 `subtrees/pi-vibeguard.json` notes（如功能实现引入了 D5 之外的分歧点），完成元数据收尾
