# Tasks

## 1. 代码块布局复用与流式缓存

- [x] 1.1 为最终回复代码块派生布局增加输入完整的稳定重绘缓存；补充正文/宽度/选项失效与多代码块复制/悬停测试，并运行 `pnpm --filter @xzzpig/pi-tidy test`
- [x] 1.2 将流式代码 token 派生缓存与当前有效 token 集合对齐并清理过期版本；增加多次前缀更新、多个代码块和当前复制文本回归测试，并运行 `pnpm --filter @xzzpig/pi-tidy test`

## 2. Hex 色块线性扫描

- [x] 2.1 将 hex/rgb/hsl 候选识别改为当前位置锚定的线性扫描；为有效/无效候选、边界、围栏/行内代码建立结果等价测试，并运行 `pnpm --filter @xzzpig/pi-tidy test`
- [x] 2.2 增加密集无效候选的多规模 benchmark，记录输入长度与测量趋势、不设机器相关绝对耗时门槛；运行 benchmark 并确认输出/识别结果正确

## 3. 活动期间历史分组缓存

- [x] 3.1 将分组缓存有效性改为对应工具/分组的实际波动状态；为 agent 活动期间静止历史组、partial 工具、任务/思考更新和分组交互增加回归测试，并运行 `pnpm --filter @xzzpig/pi-tidy test`
- [x] 3.2 扩展工具转录 benchmark 覆盖 agent 运行时的历史折叠/展开组，并与 agent 空闲基线比较；确认活动输出仍刷新且静止历史行可复用

## 4. Fork 差异与整体验证

- [x] 4.1 按每项上游渲染改动更新 `subtrees/pi-tidy.json` 的 `reapplyOnSync` 与必要 `knownDebt`；运行 `.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh pi-tidy` 并确认 `checked` 非零、未声明和过期项均为零
- [x] 4.2 运行 `pnpm --filter @xzzpig/pi-tidy run typecheck`、`pnpm --filter @xzzpig/pi-tidy test`、`pnpm --filter @xzzpig/pi-tidy run test:e2e` 与 `pnpm exec prettier --check .`；汇总功能回归和性能基准结果，确认未改用户配置及无关文件
