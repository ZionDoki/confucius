# 开发入门

[English](development.md) · 简体中文

[维护者指南](README.zh-CN.md) · [使用指南](../../docs/README.zh-CN.md)

## 构建第一个 XPI

安装 Node.js **22.8+**。预览需要 Zotero **7+**，构建不需要。

```sh
git clone https://github.com/ZionDoki/confucius.git
cd confucius
npm install
npm run build
```

安装包位于 `apps/zotero-addon/.scaffold/build/confucius.xpi`。
本地构建不等于已公开发布。

## 在 Zotero 中预览

在仓库根目录或 `apps/zotero-addon` 中运行 `npm start`。
终端会显示开发工作区选用的 Zotero 程序，点击 Confucius 工具栏按钮打开插件。

自动查找覆盖 macOS、Windows 和 Linux 的常见安装方式。
自定义路径时，将 `apps/zotero-addon/.env.example` 复制为同目录的 `.env`，
填写 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`；留空使用自动检测。
命令行环境变量优先于 `.env`，显式路径无效时会报错。

会创建或修改文库数据的测试应在隔离开发 profile 中运行。

## 修改代码前

先读 [AGENTS.md 中文版](../../AGENTS.zh-CN.md)。
UI 改动还需遵守[统一设计规范](../../docs/design.zh-CN.md)；
版本、更新记录与发布必须遵守[发布规范](releases.zh-CN.md)。

| 命令                        | 用途                              |
| --------------------------- | --------------------------------- |
| `npm test`                  | 同步内置技能并执行 workspace 测试 |
| `npm run typecheck`         | 检查 TypeScript                   |
| `npm run lint`              | 执行已配置的格式与 lint 检查      |
| `npm run build`             | 构建插件并检查其类型              |
| `npm run sync-skills:check` | 检查打包技能副本是否过期          |
| `npm run versions:check`    | 检查版本一致性                    |

代码修改后必须跑测试与类型检查。构建或单测不能替代真实 Zotero、平台、模型或升级验证；
如实说明执行过哪些检查。

## 仓库结构

| 路径                    | 职责                                      |
| ----------------------- | ----------------------------------------- |
| `apps/zotero-addon`     | UI、宿主、Zotero 原生工具和外部运行适配器 |
| `packages/protocol`     | 共用类型、schema 和指令                   |
| `packages/harness`      | Native 循环、上下文窗口、额度和权限       |
| `packages/memory`       | Markdown 记忆、历史、检索与保留策略       |
| `packages/zotero-tools` | 工具目录与论文文本处理                    |
| `packages/mcp-client`   | MCP-over-HTTP 客户端                      |
| `packages/skill-format` | 技能解析器                                |
| `skills`                | 内置技能源文件                            |
| `evals`                 | 脚本化 harness 测试夹具                   |
| `apps/agent-sidecar`    | 旧协议夹具，不打包进 XPI                  |

## 可选集成

本地只读 MCP 默认地址为 `http://127.0.0.1:23119/confucius/v1/mcp`，
端口以 Zotero 实际 HTTP 端口为准。鉴权路由需要设置中的配对令牌；
只有 `/health` 不需要鉴权。不要把令牌写入示例或提交的文件。

外部运行方式的 shell／文件工具需要显式选择工作目录。
Zotero 写入仍由宿主权限和审阅流程控制，详见[运行时契约](runtime.zh-CN.md)。

trace、机器路径和测试库放在已忽略的 `output/`。
修改文档时遵守[文档规范](documentation.zh-CN.md)。
