# Confucius

<p align="center">
  <video src="https://github.com/ZionDoki/confucius/raw/master/docs/media/confucius-promo.mp4" poster="docs/media/confucius-promo-cover.png" width="720" controls muted playsinline>
    <a href="docs/media/confucius-promo.mp4">播放 44 秒产品短片</a>
  </video>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <strong>从文献出发，把研究向前推进。</strong><br />
  面向 Zotero 7+ 的开源研究 Agent 工作台
</p>

<p align="center">
  <a href="https://github.com/ZionDoki/confucius/releases/latest"><img src="https://img.shields.io/github/v/release/ZionDoki/confucius?style=flat-square&label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Zotero-7%2B-CC2936?style=flat-square" alt="Zotero 7+" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-171714?style=flat-square" alt="AGPL-3.0" />
</p>

Zotero 擅长收藏和管理文献。Confucius 负责把它们变成下一步。

选中一篇论文、一个集合或一段原文，就可以启动精读、证据审计、
跨文献比较和综述整理。Agent 的结果会保存为带引用、版本和写回状态的
研究产物，不会随着聊天滚动消失。

[下载最新版本](https://github.com/ZionDoki/confucius/releases/latest) ·
[查看更新记录](CHANGELOG.md) · [从源码构建](#从源码构建)

## 一条完整的研究链路

```text
锁定来源 → Agent 分析 → 结构化产物 → 审查差异 → 写回 Zotero
```

1. **锁定研究材料**：在 Zotero 中选择论文、集合、保存搜索或阅读器选区。
   也可以用 `@` 搜索文献库，或把 PDF、Markdown、TXT 文件拖进工作区。
2. **交给合适的 Agent**：使用内置 Native Runtime，或直接调用已经登录的
   Codex、Kimi。任务开始后，Zotero 当前选择的变化不会污染原上下文。
3. **得到可继续工作的产物**：精读报告、证据审计、文献地图、筛选表、
   笔记草稿、标注集和引用列表都以文件块出现在活动流中，并保留修订历史。
4. **确认后再写回**：笔记、高亮、集合和标签在写入 Zotero 前都会显示
   before/after 差异。你决定接受、修改还是拒绝。

## 用文献做真正的研究工作

| 你手上的材料      | 可以直接开始                       | 典型结果                             |
| ----------------- | ---------------------------------- | ------------------------------------ |
| 单篇论文          | 精读、证据审计、相关工作、生成笔记 | 论点、方法、证据、局限与原文定位     |
| 多篇论文或集合    | 比较、筛选、综合、文献地图         | 共识、分歧、研究空白与结构化表格     |
| 阅读器选区        | 解释、核验论断、保存洞见           | 带页码引用的笔记或标注草稿           |
| PDF、MD、TXT 文件 | 阅读、整理、交叉分析               | 与当前 Zotero 来源一起进入任务上下文 |

### 精读，直达证据

Confucius 不只生成摘要。它按研究问题、方法、证据和局限组织结果，引用可以
回到 Zotero 条目、PDF 页码或具体选区。需要核验时，不必重新翻完整篇论文。

### 多篇论文，一眼看清

把多篇文献放进同一个任务，Agent 会对齐它们的研究问题、方法和证据，整理
共识与分歧。结果可以继续修订，也可以转成文献地图、筛选表或报告。

### 从证据里长出新 Idea

研究空白、方法限制和开放问题会保留各自的来源。后续提出的假设和研究设计
可以沿证据链回到出处，方便复核，也方便下一次继续推进。

### 划重点、记笔记，再写回 Zotero

Agent 可以起草笔记、标注、集合和标签操作。所有 Zotero 写入都先进入审查，
提交成功后记录来源与产物版本。

## 活动流是工作现场，产物是长期结果

工作区以活动流为主。消息、计划、推理、工具调用、审批、错误和任务状态按时间
排列，研究过程随时可追溯。产物则以文件块嵌在活动流里，点击后进入完整阅读
视图，查看正文、引用、修订和写回状态。

任务可以中断和恢复。Native Runtime 从安全检查点继续；Codex 和 Kimi 使用
各自的会话 ID 恢复。未知结果的工具调用不会在重启后被偷偷重放。

## 选择你信任的 Agent

| Runtime | 适合什么场景                            | 接入方式                  |
| ------- | --------------------------------------- | ------------------------- |
| Native  | 自建模型、OpenAI-compatible API、Ollama | Confucius 内置 Agent 循环 |
| Codex   | 长任务、计划、工具与流式推理            | 官方 Codex App Server     |
| Kimi    | 中文研究任务与 ACP 工作流               | 官方 Kimi ACP v1          |

Codex 与 Kimi 由 Zotero 插件直接启动，不需要 sidecar、额外端口或单独运行
Node 脚本。Confucius 会自动搜索官方安装目录、PATH、WinGet 和常见用户目录；
如果自动识别失败，也可以在设置中选择可执行文件。登录仍由官方 CLI/SDK
管理，插件不会读取或复制桌面端令牌。

Native Runtime 支持流式文本与推理事件，也能识别 OpenAI-compatible 和
Ollama 响应中的 `<think>...</think>`。每次 Agent Run 默认最多执行 128 个
模型步骤，可在设置中调整。

## 让长期研究接得上

Confucius 把任务、产物、会话记录和研究记忆分别保存。下次回来时，Agent 能
找到之前的结论、尝试过的方法和你的研究偏好，而不是从空白对话重新开始。

- 记忆以 Markdown 文件保存在
  `<Zotero 数据目录>/confucius/memory/`，可以直接查看、编辑和备份。
- 新安装与升级默认使用“审查”模式。候选记忆可编辑、接受或拒绝，不会静默
  写入。
- 完整会话以追加式日志保存在
  `<Zotero 数据目录>/confucius/logs/`，上下文压缩不会删除原记录。
- 研究知识库可以组织文献、笔记、洞见、方法与讨论结果，并维护 Markdown
  思维导图。

## 安装

### 安装发布版

1. 从 [Releases](https://github.com/ZionDoki/confucius/releases/latest)
   下载最新的 `.xpi`。
2. 打开 Zotero，进入 **工具 → 插件**。
3. 点击右上角齿轮，选择 **Install Add-on From File**，安装下载的文件。
4. 点击 Zotero 工具栏中的 Confucius 按钮打开工作区。

使用 Native Runtime 时，在 **Zotero → Settings → Confucius** 中添加 Base URL、
模型名和 API Key。本地 Ollama 通常不需要 API Key。使用 Codex 或 Kimi 时，
先完成官方登录，再在输入框的 Runtime 菜单中选择它。

### 从源码构建

需要 Node.js 22.8 或更高版本。

```bash
git clone https://github.com/ZionDoki/confucius.git
cd confucius
npm install
npm run build --workspace @confucius/zotero-addon
```

生成的插件位于：

```text
apps/zotero-addon/.scaffold/build/confucius.xpi
```

本地开发可以运行：

```bash
npm start
```

需要本机已安装 Zotero 7+。

## 安全与数据边界

- 默认的 Zotero-only 模式只向外部 Runtime 提供当前任务的 Zotero 读取能力和
  `artifact_upsert`，Shell 与文件写入保持关闭。
- 工作区能力必须由用户选择并确认规范化目录。命令和文件修改仍需单次或会话
  级审批。
- 任何 Zotero 写入都先展示差异，不会因为模型声称完成而直接提交。
- 本地 MCP 仅监听 `127.0.0.1:23119`，除 `/health` 外均要求 Bearer token。
  公开 MCP 只提供只读 Zotero 工具。
- PDF、网页和文献元数据都按不可信内容处理，不会被当作系统指令。
- 任务与记忆保存在本地；模型请求是否离开本机，取决于你选择的模型服务或
  Runtime。

## 面向开发者

```text
apps/zotero-addon     Zotero 7+ 生产插件与 Runtime Host
packages/protocol     RPC、任务、产物与事件协议
packages/harness      Native Agent 循环、模型适配器与权限
packages/memory       纯文本持久记忆与会话日志
packages/zotero-tools Zotero 工具目录与论文文本处理
packages/mcp-client   MCP-over-HTTP 客户端
packages/skill-format SKILL.md 解析器
skills/               内置研究技能的源文件
evals/                可重复执行的黄金轨迹
apps/agent-sidecar    旧协议契约测试夹具，不进入 XPI 运行路径
```

```bash
npm test        # 单元测试与评估轨迹
npm run verify  # 同步、版本、类型与完整测试
npm run build   # 构建所有 workspace
```

本地只读 MCP 地址：

```text
http://127.0.0.1:23119/confucius/v1/mcp
```

请求需要 Settings 中显示的 pairing token。

## License

AGPL-3.0-or-later
