# @confucius/memory

[English](README.md) · 简体中文

[开发指南](../../.github/maintainers/development.zh-CN.md) ·
[用户指南：知识库与记忆](../../docs/knowledge.zh-CN.md)

本包保存本地 Markdown 记忆，提供离线检索、对话历史与保留策略。
模型调用、用户授权、研究课题提取和统一知识索引由 Zotero 宿主管理。

## 存储

宿主的记忆目录是 `<Zotero 数据目录>/confucius/memory/`：

```text
MEMORY.md             # 可重建的可读目录
memories/<id>.md      # 正文与 frontmatter 元数据
access/<id>.json      # 显式读取产生的使用记录
```

源文件是正文依据，`MEMORY.md` 可以重建。每条记录包含标题、类型、标签、
时间、保护状态、来源、置信度和正文。受保护记忆可保留修订历史；
普通自动维护不会建立无限增长的旧版本档案。

任务和当前对话历史另存于 Zotero 本地配置目录的 `confucius/runtime-v1/`。
备份应包含这两个位置及 Zotero 文库，见[任务与数据](../../docs/tasks-and-data.zh-CN.md)。

## 主要接口

| 接口                                     | 用途                                         |
| ---------------------------------------- | -------------------------------------------- |
| `MemoryEngine`                           | 串行处理记忆操作、容量限制与检索             |
| `FileMemoryStore`                        | 读写 Markdown 源文件、重建目录               |
| `search` / `list`                        | 查找记录，不延长保留时间                     |
| `read`                                   | 读取最新来源，保存明确使用记录               |
| `refresh`                                | 在写入队列中核对外部修改和删除               |
| `save` / `update` / `delete`             | 修改记录，仍需宿主授权                       |
| `applyOrdinaryOps`                       | 应用普通自动维护，不修改受保护记忆或研究记录 |
| `maintain`                               | 清理符合过期或容量淘汰条件的普通记忆         |
| `MemoryFileSystem`                       | 宿主文件接口；测试使用 `InMemoryFileSystem`  |
| `HistoryStore` / `ConversationLogEngine` | 由宿主配置的历史存储与旧日志读取             |

写入前刷新源文件，再决定替换或清理哪些记录。明确读取产生的使用记录单独落盘，
不会因为更新使用时间而恢复已删除文件或覆盖外部编辑。

## 检索与保留

检索结合 BM25 文本匹配、中文双字切分、近期使用、访问次数、置信度和标签，
不需要向量模型或网络。

普通记忆和研究记忆共用 200 条、约 16,000 个正文 token 的预算，保留的修订也计入。
普通记忆超过 90 天未被明确读取会过期。受保护记忆和活跃课题不自动淘汰，
但仍占容量；若它们占满预算，应先解决容量问题，不能直接丢弃。
旧知识库文档不计入此记忆预算。

搜索、刷新索引、组装提示词和导出诊断不会续期。
当前宿主不会自动置顶高频记忆，也不会把反复阅读的历史片段都升级为永久记忆。
部分旧辅助接口仍为兼容而保留，不代表现行产品设置。

## 接入与检查

保护、纠正、忘记和研究课题规则见宿主的
[知识索引契约](../../.github/maintainers/knowledge.zh-CN.md)；
上下文交接与历史保留见[上下文与记忆](../../.github/maintainers/context-memory-refactor.zh-CN.md)。

在仓库根目录运行 `npm test` 和 `npm run typecheck`。
测试使用内存文件和预设模型回复，不需要真实模型服务。
