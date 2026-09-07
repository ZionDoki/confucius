# 维护者文档

产品使用说明位于 [`docs/`](../../docs/README.md)。这里保留仍需维护的工程约定与
验收证据；临时日志、原始模型 trace 和隔离测试库保留在已忽略的 `output/`。

- [版本与发布规范](releases.md)：版号、Beta 渠道、更新说明、产物与发布验收。
- [任务执行与恢复](runtime.md)：执行、存储、上下文和诊断的维护契约。
- [研究报告修订](research-reports.md)：同一报告的读取、局部修改、复核、恢复与成本验证。
- [研读 harness 验收](acceptance/research-harness-2026-09-07.md)：单报告、上下文恢复、引用跳转与 M3/K3 挑战。
- [历史升级验收](acceptance/upgrade-acceptance.md)：0.3.8 → 0.4.0-beta.1，macOS。
- [Windows 验收清单](acceptance/windows-acceptance.md)：完整场景及复现入口。
- [Windows 实测记录](acceptance/windows-acceptance-2026-09-06.md)：三引擎、PDF、恢复及明确未通过项。
- [0.4.0 发布验收](acceptance/release-0.4.0.md)：正式版候选检查、旧版升级和发布后核对范围。
- [0.4.1 发布验收](acceptance/release-0.4.1.md)：批注接口、合并后的本机实测和旧版升级。
- [0.4.2 发布验收](acceptance/release-0.4.2.md)：报告修订、独立窗口、权限与耗时修复及安装升级。
- [0.4.3-beta.1 发布验收](acceptance/release-0.4.3-beta.1.md)：研读与来源修复、引用写回、Beta 包与隔离升级。

过时的上下文 v3 设计、界面实现草稿及一次性代理设计计划已移出当前文档集，历史
仍可从 Git 查询。验收结果只适用于记录中的安装包和环境。
