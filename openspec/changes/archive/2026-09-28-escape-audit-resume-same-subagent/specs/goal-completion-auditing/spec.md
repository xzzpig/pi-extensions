# goal-completion-auditing Delta

## MODIFIED Requirements

### Requirement: 审计进度和取消保持可观察

系统 SHALL 将子代理 started/update/response 生命周期投影到完成审计的现有进度界面，至少包含当前工具、近期输出、模型和已用时间。用户中断审计（Esc）时，系统 SHALL **挂起（park）**与当前目标完成操作对应的精确审计 attempt 而非取消：子代理 MUST 保持运行、该 attempt 的事件监听 MUST 保留、系统 MUST NOT 发送取消请求，随后系统 SHALL 显示既有审计绕过选择。用户选择**继续审计**时，系统 SHALL 复用**同一**子代理 attempt 并等待其终态后进入既有批准/拒绝裁决流程；用户选择**直接完成**时，系统 SHALL 才向该精确 attempt 发送取消请求并等待其终态，然后按既有绕过流程标记目标完成。审计挂起且弹窗打开期间焦点丢失时，系统 SHALL 取消该 attempt 以防止孤儿子代理继续运行，并返回既有取消/焦点丢失结果、不得完成目标。审计 terminal timeout SHALL 继续作为挂起期间的防挂死兜底。审计总时长上限 SHALL 可通过 Goal-X 分层设置项 `auditorTimeoutMs` 配置：该值 MUST 为正整数毫秒且不超过 2_147_483_647（Node timer 安全上限）；project 层配置 SHALL 覆盖 global 层。系统 SHALL 将解析后的 `auditorTimeoutMs` 同时应用于审计委派 request 的运行时限与本地 terminal timer，二者 MUST 使用同一有效值。未设置或取值非法（非正整数、超过上限）时，系统 SHALL 回退到内建默认值 30 分钟，行为与未提供本设置项时完全一致。5 秒启动握手与 5 秒取消确认两个防挂死兜底 SHALL 保持内部固定值，MUST NOT 受 `auditorTimeoutMs` 或其他设置项影响。

#### Scenario: 显示子代理进度

- **WHEN** 审计子代理启动、调用工具或产生近期输出
- **THEN** 审计界面更新对应的运行状态，且进度观察失败不会改变审计裁决

#### Scenario: Dashboard 显示委派进度

- **WHEN** delegation update 改变审计 phase label 或 percentage
- **THEN** Goal-X 使用该 update 更新既有 dashboard，使五阶段状态、percentage progress bar 和 elapsed duration 反映最新 child progress，而不等待审计终态

#### Scenario: 展示摘要不丢失 Auditor 进度

- **WHEN** 子代理 runtime 将活动工具参数压缩为仅供展示的 `currentToolArgs` 摘要
- **THEN** `report_auditor_progress` SHALL 在其 tool-result text 中携带版本化、可解析的 label/percentage record，Goal-X SHALL 从 delegation update 的近期输出恢复该 record、推进五阶段 dashboard，并且不得将内部 record 显示为审核输出；该 record MUST NOT 授予完成权限或影响 structured verdict

#### Scenario: Esc 取消当前审计

- **WHEN** 用户在审计运行期间按 Esc
- **THEN** 系统挂起该精确 attempt：不发送取消请求、不拆除事件监听、不影响其他子代理运行，并显示既有审计绕过选择

#### Scenario: 继续审计复用同一子代理

- **WHEN** 用户在 Esc 弹窗选择“继续审计”
- **THEN** 系统复用同一子代理 attempt 继续等待其终态，子代理的全部既有上下文与审计进度得以保留；approved 进入既有批准流程，disapproved 进入既有拒绝流程，目标在裁决前保持 active

#### Scenario: 直接完成时才取消

- **WHEN** 用户在 Esc 弹窗选择“直接完成（跳过审计）”
- **THEN** 系统才向该精确 attempt 发送取消请求并等待其终态，然后按既有绕过流程记录 `audit_skipped` 并标记目标完成

#### Scenario: 挂起期间焦点丢失

- **WHEN** 审计挂起且弹窗打开期间用户改变了目标焦点（例如 `/goal-unfocus`）
- **THEN** 系统取消该挂起 attempt 防止孤儿子代理继续运行，并返回既有取消/焦点丢失结果，不得完成目标

#### Scenario: 取消确认缺失时有界收敛

- **WHEN** 用户取消或 terminal timeout 已向精确 attempt 发送取消请求，但 child 在 cancellation deadline 前未发送匹配终态
- **THEN** 系统 SHALL fail closed 地结束该审计、清理 listener/timer；用户取消保持既有 Esc 选择，timeout 取消返回 audit error，二者均不得完成目标

#### Scenario: 取消后迟到批准不能授权完成

- **WHEN** 精确取消请求已发出后，该 attempt 发送 schema-valid `completed`/`approved` response
- **THEN** 系统 SHALL 将 response 视为已取消 attempt 的 acknowledgement，保持目标 active，并且不得读取或提交该结构化 verdict

#### Scenario: 挂起期间子代理已完成

- **WHEN** 审计挂起且弹窗打开期间，子代理产生了终态（approved/disapproved/失败）
- **THEN** 用户选择“继续审计”时系统 SHALL 立即获得该终态并进入既有裁决流程（不得重启子代理或重新审计）；用户选择“直接完成”时系统 SHALL 不将该终态当作裁决提交，按绕过流程记录 `audit_skipped` 且不产生重复的 `audit_result`

#### Scenario: 挂起超时按 fail closed 收敛

- **WHEN** 审计挂起且弹窗打开期间，审计 terminal timeout 到期
- **THEN** 系统 SHALL 照常向该 attempt 发送取消请求并按 fail closed 结束；用户选择“继续审计”时获得该超时取消的 error 终态、目标保持 active，不完成目标

#### Scenario: 恢复阶段重复中断不生效

- **WHEN** 用户已选择“继续审计”且正在等待同一子代理终态时再次按 Esc
- **THEN** 系统 SHALL 不中断该审计（键被消费但不动作），审计继续运行至终态

#### Scenario: 配置的审计时长上限生效

- **WHEN** 用户在 Goal-X global 或受信任 project 设置中将 `auditorTimeoutMs` 配置为 7200000（2 小时）
- **THEN** 完成审计委派 request 的运行时限与本地 terminal timer 均使用 7200000 毫秒，审计在 30 分钟处不再被中断，超时 fail closed 行为改在该上限处发生

#### Scenario: 未设置时保持默认上限

- **WHEN** 用户未在任何层配置 `auditorTimeoutMs`
- **THEN** 完成审计使用内建默认 30 分钟上限，行为与引入本设置项之前完全一致

#### Scenario: 非法值回退默认

- **WHEN** `auditorTimeoutMs` 被配置为负数、零、非整数、超过 2_147_483_647 的值或其他非正整数毫秒值
- **THEN** 系统拒绝该取值并回退到默认 30 分钟上限，同时提供可操作的设置诊断，审计不得因非法配置而无法启动

#### Scenario: project 层覆盖 global 层

- **WHEN** global 层将 `auditorTimeoutMs` 配置为 3600000，受信任 project 层将其配置为 7200000
- **THEN** 该项目内的完成审计使用 project 层的 7200000，其他项目继续使用 global 层的 3600000

#### Scenario: 防挂死兜底不受配置影响

- **WHEN** 用户将 `auditorTimeoutMs` 配置为任意合法值（包括远小于 5 秒或远大于 30 分钟的值）
- **THEN** 审计委派的启动握手时限与取消确认时限保持内部固定短时限，不随 `auditorTimeoutMs` 缩放
