# Confucius

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

Confucius 是面向 Zotero 7 及以上版本的开源研究工作区。你可以在 Zotero
里让模型读取论文、集合、PDF 选区和本地文本文件。

[下载最新版本](https://github.com/ZionDoki/confucius/releases/latest) ·
[更新记录](CHANGELOG.md) · [从源码构建](#从源码构建)

## 功能

- 阅读单篇论文，或比较多篇论文。
- 对照原文、图表和标注核验论断。
- 生成笔记、报告、文献地图、筛选表和 PDF 标注。
- 写入 Zotero 笔记、标注、集合或标签前查看差异。
- 恢复未完成的任务，搜索已保存的研究记忆。
- 使用 OpenAI 兼容端点、Ollama、Codex 或 Kimi。

你可以从 Zotero 条目菜单、PDF 阅读器选区菜单或 Confucius 工作区发起任务。
输入 `@` 添加文献，输入 `/` 选择任务，也可以把 PDF、Markdown 或 TXT 文件
拖入工作区。

任务生成的文件显示在活动视图中，并保留引用和修订记录。普通回复留在活动
视图中。

## Runtime

| Runtime | 接入方式                    |
| ------- | --------------------------- |
| Native  | OpenAI 兼容 API 或 Ollama   |
| Codex   | 本机 Codex CLI 及其登录状态 |
| Kimi    | 本机 Kimi CLI 及其登录状态  |

Codex 和 Kimi 通过 Zotero 插件运行。可执行文件路径留空时使用自动检测，也可以
在设置中手动选择。

Native Runtime 支持流式文本和单独的推理输出。模型步骤上限可以调整，默认值为
128。

## 安装

1. 从[最新发布版](https://github.com/ZionDoki/confucius/releases/latest)
   下载 `confucius.xpi`。
2. 在 Zotero 中打开 **工具 → 插件**。
3. 点击齿轮菜单，选择 **Install Add-on From File**。
4. 选择 `confucius.xpi`，安装后点击 Confucius 工具栏按钮。

后续版本可在 **Confucius 设置 → 更新** 中安装。

使用 Native Runtime 时，在 **Zotero → Settings → Confucius** 中填写 Base URL、
模型名和 API Key。本地 Ollama 一般不需要 API Key。使用 Codex 或 Kimi 前，
先在对应 CLI 中登录。

## 文件与数据

- 任务、生成文件和会话记录保存在 Zotero 数据目录中。
- 研究记忆位于 `<Zotero 数据目录>/confucius/memory/`，格式为 Markdown。
- 会话日志位于 `<Zotero 数据目录>/confucius/logs/`。
- 模型请求遵循所选端点或 Runtime 的数据政策。

新安装默认使用记忆“审查”模式。记忆保存前可以编辑、接受或拒绝，也可以在
设置中改为“自动”或“关闭”。

## 权限

- 外部 Runtime 默认只能使用 Zotero 读取工具和 `artifact_upsert`。
- Shell 命令和普通文件写入需要先选择工作目录。
- Zotero 写入会显示拟议变更并等待审批。
- 本地 MCP 监听 `127.0.0.1:23119`，除 `/health` 外都需要设置中显示的配对
  令牌。
- PDF 文本、网页内容和元数据按数据处理，不作为指令执行。

## 从源码构建

开发需要 Node.js 22.8 及以上版本，以及 Zotero 7 及以上版本。

```bash
git clone https://github.com/ZionDoki/confucius.git
cd confucius
npm install
npm run build --workspace @confucius/zotero-addon
```

生成的 XPI 位于：

```text
apps/zotero-addon/.scaffold/build/confucius.xpi
```

启动开发版本：

```bash
npm start
```

## 仓库结构

```text
apps/zotero-addon     Zotero 插件与 Runtime Host
packages/protocol     RPC、任务、产物与事件类型
packages/harness      Native Agent 循环、模型适配器与权限
packages/memory       Markdown 记忆与会话日志
packages/zotero-tools Zotero 工具与论文文本处理
packages/mcp-client   MCP-over-HTTP 客户端
packages/skill-format SKILL.md 解析器
skills/               内置技能源文件
evals/                测试轨迹
apps/agent-sidecar    旧协议夹具，不打包进 XPI
```

常用命令：

```bash
npm test
npm run typecheck
npm run verify
npm run build
```

本地只读 MCP 地址：

```text
http://127.0.0.1:23119/confucius/v1/mcp
```

## 许可证

AGPL-3.0-or-later
