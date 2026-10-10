# Confucius

[English](README.md) · 简体中文

**在 Zotero 中阅读、比较和整理研究资料。**

Confucius 可以检索论文、解释 PDF、生成报告和提出批注建议。报告保存为 Zotero 笔记，
知识库统一索引笔记与研究记忆。

[下载安装包](https://github.com/ZionDoki/confucius/releases/latest) ·
[使用指南](docs/README.zh-CN.md) · [更新方法](docs/updates.zh-CN.md) ·
[产品短片](https://github.com/user-attachments/assets/8cf1175e-d3f9-4c31-b19f-5e3b171456fc)

> 本指南对应当前源码，已安装版本可能不同。
> 请按[更新说明](docs/updates.zh-CN.md)核对版本。

## 安装

需要 **Zotero 7 或更新版本**。

1. 从[发布页](https://github.com/ZionDoki/confucius/releases/latest)下载 `confucius.xpi`。
2. 在 Zotero 中打开 **工具 → 插件**。
3. 点击齿轮菜单 → **Install Add-on From File**，选择下载的 XPI。
4. 点击 **Confucius 工具栏按钮**，打开工作区。

## 连接模型

打开 **Confucius 设置**，选择一种接入方式：

| 接入方式 | 需要准备                                                      |
| -------- | ------------------------------------------------------------- |
| Native   | OpenAI 兼容接口的 Base URL、模型 ID 和 API Key，或本机 Ollama |
| Codex    | 本机已安装并登录的 Codex CLI                                  |
| Kimi     | 本机已安装并登录的 Kimi CLI                                   |

使用 Codex 或 Kimi 时，可执行文件路径留空即可自动检测；安装或登录后点击**重新检测**。
可用模型和费用取决于所选服务。详见[模型设置](docs/model-selection.zh-CN.md)。

## 开始第一个任务

- **读论文：**输入 `@` 添加文章，再问“解释这篇论文的方法，并给出对应页码”。
- **找文献：**提出研究问题，打开文献胶囊检查候选，确认后才入库并下载 PDF。
- **保存成果：**打开报告，点击 **Zotero 笔记**，检查预览并确认。需要独立 HTML
  副本时点击**导出文件**。
- **做批注：**让 Agent 提出高亮建议，再到**批注**胶囊中接受或拒绝。

新对话不必先选论文。切换 PDF 标签不会改变对话来源；也可以把 PDF、Markdown 或
TXT 文件拖入工作区。

接下来可看[使用指南](docs/README.zh-CN.md)或[常见问题](docs/troubleshooting.zh-CN.md)。

## 从源码构建

需要 Node.js **22.8+**。构建不要求安装 Zotero，本地预览需要。

```sh
npm install
npm run build
npm start
```

安装包位于 `apps/zotero-addon/.scaffold/build/confucius.xpi`。
下载源码、自定义 Zotero 路径、检查命令和仓库结构见[开发入门](.github/maintainers/development.zh-CN.md)。

## 许可证

AGPL-3.0-or-later。
