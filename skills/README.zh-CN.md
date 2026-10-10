# 内置技能

[English](README.md) · 简体中文

[使用指南](../docs/README.zh-CN.md) · [开发指南](../.github/maintainers/development.zh-CN.md)

技能是插件自带的可复用操作说明。在输入区键入 `/`，选中技能，补充要求，再点
**发送**。方向键浏览，Enter、Tab 或点击选中。选中只填入草稿，不会立即运行。

| 技能                      | 用途                               |
| ------------------------- | ---------------------------------- |
| `paper-deep-reading`      | 研读论文的主张、证据、假设与限制   |
| `claim-evidence-audit`    | 核对实验和图表是否支持主张         |
| `related-work-map`        | 梳理相关论文和研究空白             |
| `library-triage`          | 检索、整理和标记文献               |
| `annotation-pass`         | 提出 PDF 批注，供用户审阅          |
| `mind-map`                | 生成可编辑的 Markdown 思维导图     |
| `research-knowledge-base` | 通过知识索引查找研究背景、维护笔记 |

同一菜单中的预设会准备任务草稿。使用“论文阅读”时，先选择材料和报告风格，再发送。
详见[阅读与批注](../docs/reading-and-annotations.zh-CN.md)。

## 技能如何加载

Agent 先看到技能名称、说明和触发词。发送含 `/slug` 的请求，或 Agent 调用
`skill` 工具时，才加载完整说明。`/slug` 后的文字就是本次要求。
`allowed-tools` 只列出推荐工具，不隐藏其他工具，也不授予写入权限。

每轮消息都可调用技能，包括已有的 Codex 或 Kimi 会话。将 `/slug` 放在请求开头，
允许开头空白。已加载技能继续保留；说明有冲突时，本轮显式调用优先。纯 `/slug`
使用当前 Zotero 上下文并继承对话语言。附件和论文正文不会触发技能。Escape
关闭菜单并保留草稿。

笔记仍走正常确认流程，批注建议仍需审阅。知识库技能使用统一来源索引，
不会要求用户新建知识库容器或填写内部 ID。

## 修改技能

编辑 `skills/<slug>/SKILL.md`，然后在仓库根目录运行：

```sh
npm run sync-skills
npm run sync-skills:check
npm test
npm run typecheck
```

生成文件是 `apps/zotero-addon/src/modules/skills/builtin.ts`，不要直接修改。
每个可执行技能只维护一份；使用说明提供双语，不按语言复制技能包。
