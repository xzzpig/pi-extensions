# 实施任务：Goal-X 项目本地配置层

## 1. 三层读取、合并与来源

- [x] 1.1 实现 fork-only 层级/路径/已校验 sparse 合并辅助模块，扩展 local 范围与原始快照，并最小接入现有解析；以 fork-only 测试验证 global/project/local/已有环境变量优先级、无 local 兼容及自定义共享路径不改变 local 定位。
- [x] 1.2 全配置域接入逐字段继承与来源，包括任务、auditor、Oracle、网络恢复、commands、keybindings、pauseOrder；以矩阵测试验证嵌套兄弟字段、旧别名、false/合法 0/空数组、数组整体替换和删除后继承。
- [x] 1.3 将 local 纳入诊断、快照复制、缓存键及既有失效边界，并扩展有效配置报告；测试非法 JSON/非法字段及合法兄弟字段、同路径不同范围诊断、local 修改后刷新和返回数组隔离，确认不引入文件监听。
- [x] 1.4 新增 `docs/project-local-settings.md` 的层级、路径、覆盖和刷新规则说明；将文档纳入 package files，并检查示例字段与测试一致。

## 2. 分范围持久化与设置主界面

- [x] 2.1 local 写入接入现有路径锁、锁内重读、校验和原子写入；增加 fork-only 并发/文件安全测试，证明不同字段不丢失、非法目标与符号链接被拒绝、旧 project-only 读写接口仍指向 project。
- [x] 2.2 `/goal-settings` 支持三个范围并保持默认 project，显示目标路径、有效来源、本层值/未设置与遮蔽提示；增加交互测试覆盖只读切换不写文件、环境只读、低层修改不改变高层值及只修改所选文件。
- [x] 2.3 为三层提供明确的删除覆盖/恢复继承动作，不复制继承值到当前层；测试 local → project → global/default 的恢复链及设置后的 UI 刷新，更新文档中的界面操作说明。

## 3. Controls 与运行配置消费者

- [x] 3.1 将 Controls 的范围切换、继承、来源、重置和保存提示接入三层辅助逻辑，保留命令 reload 与恢复入口保护；增加 fork-only Commands/Keys/Pausing 测试，验证三个范围及逐层删除。
- [x] 3.2 扩展锁内 Controls 修改前后校验到 global、global+project、global+project+local 三个视图；测试跨层命令/快捷键新增冲突被拒绝、被 local 遮蔽的低层冲突仍被发现，以及既有冲突可修复，补充文档中的冲突与遮蔽说明。
- [x] 3.3 检查所有配置消费者，保持 per-goal auditor override 在三层文件解析之后应用；新增集成测试验证本地审计模型、共享清单、全局其他字段共同传入审计，并验证请求层与定义层原有生效时机及未配置时不改变审计 gate。

## 4. Git 隔离与维护记录

- [x] 4.1 在根 `.gitignore` 显式忽略 `/.pi/pi-goal-x-settings.local.json`；使用 `git check-ignore` 验证规则，确认共享配置仍受版本管理，且不修改用户已有共享/全局配置或运行时自动维护 Git 规则。
- [x] 4.2 完成三来源使用说明、非强制团队策略/非凭据存储边界和回滚说明；仅修正 README 现有 Settings 中必要事实，更新 CHANGELOG，并检查 tarball 包含新增详细文档而不包含个人配置。
- [x] 4.3 按实际 fork-only/上游修改分类维护 `subtrees/pi-goal-x.json` 的同步成本与债务条目；运行 inventory、`direnv reload` 和 `pnpm run audit:fork-divergence`，记录非零 checked、undeclared=0 的结果，不为纯 fork-only 自有逻辑虚构维护条目。

## 5. 集成验收

- [x] 5.1 在 direnv/Nix 环境运行 `pnpm --filter @xzzpig/pi-goal-x run typecheck`、该包单元及集成测试、settings-race 回归和相关 Controls/auditor 测试；对新增/变更 TypeScript 主动执行 LSP 诊断，记录命令、退出码及具体故障，不以空会话缓存当作检查通过。
- [x] 5.2 按真实运行与 tmux 技能建立隔离 Pi TUI 验收并保留 asciinema 录制：验证默认 project、三范围编辑与遮蔽、删除继承、Controls 操作和逐文件差异；运行真实审计并收集实际选模与共享清单输入证据，缺运行条件时报告具体阻塞，不用 stub 冒充真实验证。
- [x] 5.3 生成规格场景到测试/真实运行证据的追踪记录，执行 OpenSpec 严格校验、变更文档格式检查与最终 fork-divergence gate，核对 diff 仅在批准范围；确认工作区原有 `.pi/pi-goal-x-settings.json` 改动保持原样，无全局个人文件改写、提交、推送或发布。
