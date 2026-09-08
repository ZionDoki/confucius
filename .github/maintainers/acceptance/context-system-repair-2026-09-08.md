# 上下文完整修复验收 — 2026-09-08

代码与本地构建完成，全部自动回归通过；Codex、Kimi 的真实模型冒烟通过。
Native 已通过确定性 HTTP 回放，但配置中的真实端点缺少 API key，返回 HTTP 401，
真实模型验收仍待有效端点。不能将回放结果计作 Native 实模通过。

本次为基于 `ab867e5fc2d05999b8f5ea605a6cd8862ad312f6` 的未提交工作区改动，
版本仍为 `0.4.3-beta.2`，没有打 tag、发布或安装到用户
日常 profile。构建 XPI 仅在新建的隔离 Zotero profile 与样例文库中加载。

## 构建与自动回归

| 检查                | 实际结果                       |
| ------------------- | ------------------------------ |
| `npm test`          | 963 项全部通过，0 失败、0 跳过 |
| `npm run typecheck` | 全部 workspace 通过            |
| `npm run lint`      | Prettier 与 ESLint 通过        |
| `npm run build`     | XPI 打包与类型检查通过         |
| `git diff --check`  | 通过                           |

测试数量为根脚本 8、harness 162、mcp-client 2、memory 60、protocol 111、
skill-format 10、zotero-tools 17、agent-sidecar 31、zotero-addon 562。
XPI SHA-256：
`4266e79819461d7a7e1af0ed8ca8fbf6b603b93f63e0661b8b247dc528f76c6c`。

| 要求与故障场景               | 覆盖与结论                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 多次换窗、追加要求、来源变化 | `WindowContext` 与宿主生命周期测试保留当前 request、工作进度及预算；旧 binding 和迟到回调失效                  |
| 空／旧笔记与必要证据         | `ContextHandoff` 测试覆盖宿主事实补齐、过时笔记隔离、引用不可读或越权时阻止切换；模型笔记不能改写权限          |
| 写入去重、未知结果、审批     | 完成回执跨恢复复用，未决结果和审批阻止切换；写入成功后结果丢失不自动重做                                       |
| 切换事务恢复                 | 注入 prepared、session-ready、committed 与启动阶段失败，保留旧窗口或已提交恢复事务；存储失败与候选迟到均有回归 |
| CLI 会话准备／激活           | 候选会话可发现工具目录，激活前不能执行工具；过期 generation 租约被拒绝                                         |
| 维护额度                     | 单轮共享两次宿主尝试、交接补充最多一次，先持久化再调用；耗尽和重启不补额度，蒸馏批次也限制累计尝试             |
| 超大结果与并行读取           | 原始结果先存档；JSON 凭证保持完整，11 个只读请求分为 4/4/3；必需输入超硬上限仅报告一次                         |
| 检索排名、分页与去重         | 默认 2/4/2 配额与空位互补；中英文深处命中、UTF-16 偏移、游标续页、来源过滤和整段去重均通过                     |
| 真实读取与缓存               | 已确认的文件版本才可复用；显式复核绕过缓存，文件已变但 Reader 未更新时拒绝旧页                                 |
| 归档与迁移                   | 引用及原文件不变；首次迁移备份清单与任务状态，只补元数据和分片；新旧关闭设置兼容                               |
| TTL、容量与保护              | 90 天／500 MiB 策略按实际使用排序；活跃依赖、恢复任务、读取租约和交接引用保护；允许有原因的临时超限            |
| 删除中断、蒸馏失败           | 墓碑先落盘，可恢复删除；归档不依赖模型，蒸馏成功、失败和额度不足均不授权删除原文                               |
| 可观测性                     | 存档、宿主提供、Native 请求交付与业务核验分别记录；提供证据不能将 unknown 自动升级为已核验                     |

主要测试位于 [ContextHandoff.test.ts](../../../apps/zotero-addon/src/modules/host/ContextHandoff.test.ts)、
[AgentHost.lifecycle.test.ts](../../../apps/zotero-addon/src/modules/host/AgentHost.lifecycle.test.ts)、
[ContextMaintenance.test.ts](../../../apps/zotero-addon/src/modules/host/ContextMaintenance.test.ts)、
[ContextTools.test.ts](../../../apps/zotero-addon/src/modules/host/ContextTools.test.ts)、
[history.test.ts](../../../packages/memory/src/history.test.ts) 和
[WindowContext.test.ts](../../../packages/harness/src/WindowContext.test.ts)。

## 三种后端的隔离运行

环境为 macOS、Zotero 10.0.1，Codex CLI 0.153.4、Kimi CLI 0.40.1。使用合成标记和
独立记忆条目，换窗任务要求先读标记、保存下一步及证据引用、换窗后直接回答。
没有修改用户论文、标注或成果。CLI 配置使用隔离副本；验收后确认原运行时配置未变。

| 场景                    | 结果                             | 窗口数 | 上下文工具                   | 宿主维护尝试 |
| ----------------------- | -------------------------------- | ------ | ---------------------------- | ------------ |
| Codex 普通短任务        | 真实模型完成                     | 1      | 无                           | 0            |
| Codex 交接              | 真实模型完成，重启后证据可读     | 2      | read/save/new_context 各一次 | 0            |
| Kimi 普通短任务         | 真实模型完成                     | 1      | 无                           | 0            |
| Kimi 交接               | 真实模型完成，重启后证据可读     | 2      | read/save/new_context 各一次 | 0            |
| Native 真实端点         | HTTP 401：未配置 API key         | 1      | 无                           | 0            |
| Native 确定性 HTTP 回放 | 短任务与交接完成，重启后证据可读 | 1 / 2  | 交接各一次                   | 0            |

两种 CLI 的交接都只启动两次执行器，换窗后没有重复 `context_read`，补充调用为零。
重启检查保留各任务状态、窗口数、已用运行额度和维护额度。该样例证明证据回填可以
避免一次重复读取，尚不构成不同真实研究任务的成本或质量统计结论。

Codex 公开报告的短任务用量为输入 9,626、输出 74、合计 9,700 tokens；交接任务为
输入 41,628、输出 478、合计 42,106，其中缓存输入 19,968。Kimi 未公开本次 token
用量，记录为未知，不能将宿主字段中的零解释为零用量。CLI 内部提示、推理请求数、
内部重试与硬输出限制不可完整观测；本地尝试上限不是服务商账单上限。

首次真实 CLI 检查暴露了两个问题：候选会话初始化 MCP 时被活动租约检查拒绝，
以及 `context_save` 回执被当成新业务历史而多用一次补充。两者修复后增加独立回归，
再次执行真实冒烟，得到上表零补充结果。保留失败原始报告作为诊断，不能与最终通过
报告混合计数。

## 构建 XPI 的本地存储与崩溃检查

以下 10 项在隔离 Zotero 中运行实际文件存储，模型部分只使用本地确定性 HTTP 服务，
没有外部模型调用：

1. 固定标题的短任务：1 次主请求、1 个窗口、0 次维护调用。
2. 固定标题的连续两次换窗：5 次主请求、3 个窗口、0 次维护调用。
3. 归档前后的原文引用一致，完整中文正文可读。
4. 确认原文落盘后释放重复日志。
5. 搜索及诊断导出不更新归档续期时间。
6. 在途读取租约阻止删除。
7. 非空显式读取更新续期时间。
8. 另一活跃任务的证据引用阻止删除。
9. 注入第一次原文文件删除失败，`cleanupPending` 墓碑已持久化。
10. 对隔离 Zotero 执行 SIGKILL，重启后继续清理，最终状态 pruned、pending=false、
    归档字节数为零。

固定标题回放专门排除了既有自动标题请求，用于验证新增维护调用为零；其他冒烟中
仍可能执行原有标题生成，不将其混称为上下文补充。

500 MiB 统计归档正文、词项分片、历史清单及其迁移备份。首次迁移的全局任务状态
恢复备份、旧 runtime 目录副本、用户导出与 CLI 自有日志独立保留，不计入此额度。
归档目标不等于整个 profile 的磁盘上限。

## 文档、流程图及复核资料

用户说明见[上下文、换窗与归档](../../../docs/context-system.md)和
[任务与数据](../../../docs/tasks-and-data.md)，实现约定见
[上下文与记忆管理](../context-memory-refactor.md)。
流程图使用[版本化 JSON 源文件](../diagrams/context-system.architecture.json)，
包含日常运行、事务交接、归档保留三个视图；确定性图表检查 9/9 通过、无警告，
浅色／深色图与交接导航已人工查看。

原始命令输出、隔离脚本、机器路径及样例 trace 只保存在已忽略的
`output/context-system-fix/`。主要复核入口是 `live-smoke.mjs` / `live-smoke.json`、
`local-storage-smoke.mjs` / `local-storage-smoke.json` 及四项检查日志；图表输出和
视觉检查记录位于 `output/context-system/`。这些是本地验收材料，不是发布资产。

真实 Native 端点验证需要可用配置后重跑。Windows/Linux 与不同 CLI 版本没有在本次
隔离运行中复测。此前的[基础验收](context-memory-refactor-2026-09-08.md)和
[专项验收](context-memory-stress-2026-09-08.md)保留为各自源码状态的证据，不能替代
本次采用新归档删除策略的验证。
