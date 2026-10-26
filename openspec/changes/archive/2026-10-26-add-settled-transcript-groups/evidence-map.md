# 规格场景 → 测试/真机证据映射（任务 7.4 附带产物）

本文件汇总 `specs/` 各 Requirement 的验证证据。测试名指向
`packages/pi-group-collapse/test/`（GC 探针为
`test/fixtures/gc-probe.ts`，独立 `--expose-gc` 进程）；真机证据指向
`artifacts/pi-group-collapse/e2e/preaccept-20261025-132153/`。

## transcript-group-folding

| Requirement                     | 证据                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立插件只拥有组级展示          | composition.test.ts（controller/runtime 双序共存、reload 循环）；tool-display 750/750、thinking-collapse 12/12、starline 981/981 独立套件未放宽                             |
| 按可见顺序划分连续片段          | model.test.ts 全部分隔/合并场景；host-contract.test.ts 行区间分割                                                                                                           |
| 可配置成员选择与确定性规则      | rules.test.ts（种类隔离/最后命中/默认）；model.test.ts（keep 切断）                                                                                                         |
| 普通通知匹配的来源与更新安全    | notification-adapter.test.ts（核心直呼不认领、尾行复用、失效先显露）；updates.test.ts（更新重分类）；summary-click.test.ts（通知载体点击）                                  |
| 配置分层与统一生效              | config.test.ts（整表覆盖/继承/回退/去重提示/冻结快照）；真机：预验收 pi-stderr.log 未知字段拒绝                                                                             |
| 活动整轮不进行组级折叠          | pairing.test.ts（并行/流式未安静）；runtime.test.ts（collapse 跳过活动轮）；真机：预验收 04（Working 期透传）                                                               |
| 正常稳定结束后统一折叠          | lifecycle.test.ts（保守分类）；runtime.test.ts（settle 折叠）；真机：预验收 01（echo 轮收组）                                                                               |
| 异常片段延后收纳                | fold-state.test.ts（累积/补收纳/不跨轮合组）；history.test.ts；真机：预验收 05/06（Escape 中止→下轮补收纳，部分回答保持显示）                                               |
| 两级组视图原样恢复成员          | host-adapter.test.ts（titled 字节一致、成员状态不变）；composition.test.ts（真实 bash/edit/write 渲染器）                                                                   |
| 单行摘要可识别且有宽度界限      | view.test.ts（计数/标记/降级/CJK/超窄保持原样）                                                                                                                             |
| 组级与成员级输入互不混淆        | summary-click.test.ts（单击一次、修饰/双击不切换、坐标回传后原生思考点击）；no-hijack.test.ts（拖选/滚轮/浮层/resize/布局变化）                                             |
| 当前分支历史重建与异常延期一致  | history.test.ts（正常默认折叠/异常尾轮常显/补收纳/不伪造通知）；EpochGuard 迟到事件拒绝                                                                                     |
| 有界资源与稳定重绘              | render-stability.test.ts（零 requestRender/零定时器/字节稳定）；scale.test.ts（线性查找/零索引重建/隐藏正文跳过）；gc-reclamation.test.ts（旧组件可回收、强表回新视图规模） |
| 安全降级与首版范围              | runtime.test.ts（非 TUI 零安装）；smoke.test.ts（命令守卫）                                                                                                                 |
| 最终真实 e2e 验收必须可回放核查 | **未完成** — 预验收（report.md）覆盖主体路径但无 asciinema 录制；8.x 待执行                                                                                                 |

## mouse-api（MODIFIED + ADDED）

| Requirement                        | 证据                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| 点击归属由解析能力决定（修改）     | pi-starline test/explicit-expand-target.test.ts（seam 前后行为、fallback） |
| 可选且版本化的显式展开目标（新增） | expand-target.test.ts（版本/命中/身份稳定/无效提供方）；starline 同上      |

## 状态

- 单元/契约/组合/GC：**189/189 + 981/981 + 750/750 + 12/12 全绿**
- 真机预验收：核心路径已验证（见 report.md），**非最终验收**
- 最终 asciinema e2e（阶段 8）：**完成**（cast-d 真实鼠标点击闭合缺口；ctrl+t 同装/OSC52/RPC 画面三项为单元级覆盖，已在 report.md 标注）
