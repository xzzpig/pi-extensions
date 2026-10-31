# 实施任务

## 1. goal-x 最终发送门禁

- [x] 1.1 在 fork-only 模块实现 `pi-goal:before-auto-continue:v1` 同步事件及单向 defer 闭包；添加真实 Pi EventBus 测试，验证无人监听放行、多监听者顺序无关、异步迟到无效、监听返回值无效和有界理由。
- [x] 1.2 在原 timer/readiness 检查之后、authorize/claim 之前增加可选 hook 并接线；增加 fork-only runtime 测试，断言阻止时 used、remainingChecks、checkpointSeq、快照和 checkpoint 均不增加，时间跨过多个 50ms 周期也不重试。
- [x] 1.3 增加门禁后的目标/宿主状态复核；测试同步监听期间焦点切换、暂停、完成及新 pending message，验证不会授权过期 goal 或抢占宿主工作。
- [x] 1.4 在 fork-only 文档说明同步协议、发送位置、不新增重试、strict 契约不变和无监听者行为；以文档示例和协议测试核对一致性，保持 README 不变并更新 goal 测试清单/selfcheck。

## 2. subagents 原生状态适配

- [x] 2.1 对 async、顶层 workflow、detached foreground、notify 队列和 parent-wake pending 建立只读判定映射；在本 change 的验证记录中列出实际来源与交接完成判据，添加正反向测试证明不依赖通用工具字段、磁盘扫描或新计数器。
- [x] 2.2 在 fork-only 模块实现当前父会话及唤醒契约过滤；验证 queued/running 阻止、其他会话/显式不唤醒任务放行、session UUID 与文件路径正确归属，以及自有状态读取异常捕获后阻止本次发送。
- [x] 2.3 接入真实通知交接的只读状态，保持发送/去重/ownership 不变；用原生 notify 和 parent-wake 集成测试覆盖成功、失败、停止结果的“终态未交接→已接受待启动→父回合启动”窗口，确保没有抢先 checkpoint。
- [x] 2.4 接入 session_start/shutdown/reload 生命周期并提供 disposer；测试两种扩展加载顺序、重复安装清理、会话替换、状态恢复和迟到旧请求，验证没有旧会话阻止新会话的残留。
- [x] 2.5 在 fork-only 文档说明监听条件及不拦截结果/监督请求的边界；验证实际监听模块与 goal 发射模块的协议契约一致，不增加反向包依赖或用户设置。

## 3. 跨包与真实运行验收

- [x] 3.1 以两个实际扩展模块和真实 Pi EventBus 验证“异步派发→父执行结束且不调 wait→goal 被阻止→原生结果唤醒→正常续跑”，同时覆盖并行多个 child、workflow、detached foreground 监督请求；自动断言没有重复模型请求、孤立快照或额度误扣。
- [x] 3.2 执行未阻止路径的 golden/消息配对、焦点、预算、普通 readiness timer、strict repair、定时等待和网络恢复回归；保存命令、实际结果与新增规格场景的追踪表，不把原有不相关失败改成通过。
- [x] 3.3 按真实运行技能，在隔离目录以真实 Pi/模型、持久 tmux 和 asciinema 验证无需显式等待的 async 运行、结果回流及监督请求；记录父请求来源、child 身份与结果交接证据，缺条件或预期行为未出现时报 blocked/失败，不宣称 live 通过。
- [x] 3.4 执行两包实际 typecheck/check、受影响测试和打包入口验证，主动检查改动文件 LSP 诊断；仅对 fork-only 文件格式化，运行 `pnpm run audit:fork-divergence` 和相关 prettier 检查，并记录 checked/undeclared 汇总。
- [x] 3.5 按实际 seam 更新两个 subtree 的维护记录及必要的 fork 测试清单，核对无 README/版本/运行依赖/用户配置变更；执行 `openspec validate gate-goal-auto-continuation --strict`，在验证记录中区分规划验证与实现验收结果。
