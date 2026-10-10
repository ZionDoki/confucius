# 运行时与工具历史验收

原文语言：简体中文。以下内容迁自原维护指南，保留其中日期、版本、检查结果和限制；不代表当前版本已重新验证。

## 验证与证据

```sh
npm test
npm run typecheck
npm run build --workspace=@confucius/zotero-addon
node scripts/live-http-check.mjs
npm run test:live:zotero-tools
node --import tsx scripts/live-zotero-recovery.mjs
```

确定性回归覆盖协议切块和异常结束、非法参数零派发、累计预算、取消竞态、部分成功与重放、迁移、receipt 保存失败及上下文恢复。`AgentHost.lifecycle.test.ts` 直接调用宿主生命周期方法验证准备失败、并发提交和迟到回调，而不以源码字符串代替行为。

`0.4.0-beta.1` 发布候选曾通过 696 项测试及相应构建检查，历史安装记录见 [升级验收](upgrade-acceptance.md)。之后针对 0.4.0 所含修复完成了 [Windows 三引擎与平台实测](windows-acceptance-2026-09-06.md)：持久化与专项恢复通过，Native 语义召回未通过。按 [Windows 验收清单](windows-acceptance.md) 区分已验证和剩余范围，不将历史结果作为所有版本的保证。

`live-zotero-tools.mjs` 只接受 scaffold 开发 profile 和专用端口，以确定性模型驱动真实 Zotero API，并输出 `output/tool-e2e-report.json`。脚本核对实体和停止语义，记录清理结果；测试创建的开发库 fixture 单独列出，不操作真实主库。

2026-09-06 在 macOS / Zotero 10.0.1 的开发 profile 完成最终构建的 60/60 工具、34/34 MCP 读取及 15/15 附加断言验证（`output/tool-e2e-sixth-run.json`），原配置、临时 endpoint、任务和知识库清理通过。批注辅助报告 `output/zotero-recovery-final-report.json` 核对首次 8 条真实写入、仅修复余下 2 条、无需读取凭证的重放新增 0 条、最终 10 个实体和原八条 key 不变；该套测试创建的批注已清理。辅助套通过配对的 `task/toolCall` 验证宿主及领域执行，不代表真实基础模型或外部引擎的端到端质量评测。最后再次点击工具栏图标，Confucius 工作区正常打开。

当前真实 Reader 定位仍观察到约每条 5 秒的等待：十条首次准备和提交约 50.4 秒，仅修复两条约 10.1 秒。共享执行时限仍生效，但未证明大批量候选能在默认时限内全部定位。不能以直接字符匹配取代原生搜索的完成判断来提速：原生搜索的空白、重音和连字规范化可能揭示额外歧义。

多模型评测使用 `scripts/live-matrix.mjs`，逐模型固定来源、profile、预算与声明的 modelRevision，保留每项结果、假完成、重复操作、参数修复、恢复和成本指标。`--dry-run` 仅验证配置，不代表模型效果通过。未取得升级前后相同模型与环境的实测结果前，不宣称成功率提升。

当前 macOS 自动化与开发 Zotero 验收不能替代 Windows/WPS 的文件占用、权限拒绝、磁盘满、中断迁移及真实 Windows Worker 验证，也不能替代各真实模型的批注质量评测。这些结果需按平台和模型分别记录。
