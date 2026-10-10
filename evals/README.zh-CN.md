# 执行循环脚本检查

[English](README.md) · 简体中文

[开发指南](../.github/maintainers/development.zh-CN.md)

这里的 JSON 用预设模型回复检查 Native 执行循环，不调用真实模型，也不证明回答质量。

在仓库根目录运行 `npm test`。[执行器](../packages/harness/src/evals.test.ts)
会加载本目录所有 `*.json`。

| 用例                                           | 检查内容                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| [read-only-search.json](read-only-search.json) | 只读工具请求、结果，再到最终回答                     |
| [write-approval.json](write-approval.json)     | 写入等待“仅允许一次”的确认后执行                     |
| [budget-exhausted.json](budget-exhausted.json) | 模型步数耗尽后以 `iteration_budget` 结束，不能报成功 |

新增时复制最接近的用例，填写唯一 `id`、`userText` 和 `modelScript`。
可选输入为 `maxIterations`、`approval`（`allow` 或 `deny`）。
按场景使用 `expectedEventTypes`、`expectedToolRequests`、
`expectedLastEvent` 或 `expectedStopReason` 断言结果。
事件序列比较不包含 `model_request_progress`。

其他契约用对应包的专项测试覆盖。真实模型、Zotero 和升级检查需要单独记录到
[验收归档](../.github/maintainers/acceptance/README.zh-CN.md)。
