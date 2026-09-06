# Confucius

[播放产品短片](https://github.com/user-attachments/assets/8cf1175e-d3f9-4c31-b19f-5e3b171456fc)

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://github.com/ZionDoki/confucius/releases/latest"><img src="https://img.shields.io/github/v/release/ZionDoki/confucius?style=flat-square&label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Zotero-7%2B-CC2936?style=flat-square" alt="Zotero 7+" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-171714?style=flat-square" alt="AGPL-3.0" />
</p>

Confucius 是面向 Zotero 7 及以上版本的开源研究工作区。你可以在 Zotero
里让模型读取论文、集合、PDF 选区和本地文本文件。

[下载最新版本](https://github.com/ZionDoki/confucius/releases/latest) ·
[使用文档](docs/README.md) · [更新记录](CHANGELOG.md) · [从源码构建](#从源码构建)

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
在设置中手动选择。 自动检测覆盖 macOS、Windows 和 Linux 的常见安装目录，
包括 Homebrew、npm、nvm／fnm、uv／pipx，以及 Codex 桌面应用。
安装或登录后点击“重新检测”；自定义目录可直接填写绝对路径。
Codex 的 npm 启动入口会解析到所附的原生程序，不依赖 Zotero 自带 Node。
更多安装方式与故障处理见[运行时识别说明](docs/runtime-discovery.md)。

Native Runtime 支持流式文本和单独的推理输出。模型步骤上限可以调整，默认值为
128。

## 安装

1. 从[最新发布版](https://github.com/ZionDoki/confucius/releases/latest)
   下载 `confucius.xpi`。
2. 在 Zotero 中打开 **工具 → 插件**。
3. 点击齿轮菜单，选择 **Install Add-on From File**。
4. 选择 `confucius.xpi`，安装后点击 Confucius 工具栏按钮。

后续版本可在 **Confucius 设置 → 更新** 中安装。
Confucius 自行检查和校验更新；打开 **接收测试版更新** 可接收 Beta，关闭后只检查
稳定版，不会自动降级。自动检查与 Beta 开关各自保存，安装需点击“下载并安装”。
首次使用仍运行旧更新器的版本时，可手动安装包含新更新器的 XPI。

使用 Native Runtime 时，在 **Zotero → Settings → Confucius** 中填写 Base URL、
模型名和 API Key。本地 Ollama 一般不需要 API Key。使用 Codex 或 Kimi 前，
先在对应 CLI 中登录。

## 文件与数据

- 任务状态、生成文件、历史和会话日志保存在本机 Zotero local profile 的
  `confucius/runtime-v1/` 中，设置中可查看实际路径。
- 研究记忆位于 `<Zotero 数据目录>/confucius/memory/`，格式为 Markdown。
- 原生笔记、PDF 批注和附件由 Zotero 文库管理。
- 模型请求遵循所选端点或 Runtime 的数据政策。

新安装默认使用记忆“审查”模式。记忆保存前可以编辑、接受或拒绝，也可以在
设置中改为“自动”或“关闭”。

从 0.3.x 升级时会迁移任务运行数据，并保留源文件与备份；降级不会反向迁移新版
进度。备份时需要同时保留文库和本机运行时目录，只同步文库不能同步完整任务。
详见[任务恢复、文件与更新](docs/tasks-and-data.md)。

Windows 实测中，Native 曾在长上下文及重启后遗漏早期要求，首次文献报告也需要
事实纠正，续接时应核对关键约束和引用。WPS Cloud 目前验证了本地同步目录的读写
及文件占用恢复；云端同步、多机使用及整个 Zotero 数据库放入云盘仍未验证。

## 权限

- 外部 Runtime 默认只能使用 Zotero 读取工具和 `artifact_upsert`。
- Shell 命令和普通文件写入需要先选择工作目录。
- Zotero 写入会显示拟议变更并等待审批。
- 本地 MCP 使用 Zotero 当前 HTTP 端口（通常为 `127.0.0.1:23119`），除 `/health` 外都需要设置中显示的配对
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

根目录和 `apps/zotero-addon` 目录都可以运行此命令。启动时自动查找已安装的
Zotero：macOS 的系统／用户应用目录，Windows 的常见安装目录和 App Paths
注册项，以及 Linux 的 PATH、系统／用户安装目录和解压版。终端会显示选中的路径。

通常不需要 `.env`。自定义安装位置可以把
`apps/zotero-addon/.env.example` 复制为同目录下的 `.env`，填写
`ZOTERO_PLUGIN_ZOTERO_BIN_PATH`；留空继续自动检测。命令行环境变量优先于 `.env`，
显式路径无效时会报错并提示修正。构建和发布不要求本机安装 Zotero。

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

如果当前 Zotero 使用其他 HTTP 端口，请相应替换。架构、发布规范和验收记录见
[维护者文档](.github/maintainers/README.md)。

## 许可证

AGPL-3.0-or-later
