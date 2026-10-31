# 模型设置

[English](model-selection.md) · 简体中文

[使用指南](README.zh-CN.md)

## 选择接入方式

| 运行方式 | 配置方法                                                                  |
| -------- | ------------------------------------------------------------------------- |
| Native   | 添加端点，填写 Base URL、模型 ID 和 API Key。本机 Ollama 通常不需要 Key。 |
| Codex    | 安装并登录 CLI，再到设置中重新检测。                                      |
| Kimi     | 安装并登录 CLI，再到设置中重新检测。                                      |

模型会收到你的消息和本次纳入上下文的材料；数据处理遵循所选端点或运行方式的政策。

在输入框旁选择模型。运行期间需先停止，再切换模型。
同一运行方式内换模型会保留任务、来源和报告；切换运行方式会清除上一个运行方式的模型选择。

## Native API 协议（从 0.6.4-beta.2 起）

在**设置 → 模型 → API 协议**中选择端点接受的协议。Zotero 的 Confucius
偏好设置也提供同一选项。工作区设置需要保存端点；Zotero 偏好设置会立即保存选择。
每个端点独立保存协议。

| 协议                    | Base URL 示例                                      | 鉴权方式          |
| ----------------------- | -------------------------------------------------- | ----------------- |
| OpenAI Chat Completions | `https://api.openai.com/v1`                        | Bearer API Key    |
| OpenAI Responses        | `https://api.openai.com/v1`                        | Bearer API Key    |
| Anthropic Messages      | `https://api.anthropic.com/v1`                     | Anthropic API Key |
| Gemini Generate Content | `https://generativelanguage.googleapis.com/v1beta` | Google API Key    |
| Ollama                  | `http://localhost:11434`                           | 可选 Bearer Key   |

通过网关连接时填写网关提供的 Base URL。网关路径前缀和查询参数会保留。
也可以填写以 `/responses`、`/messages`、`/chat/completions`、`/api/chat`
或 Gemini 生成方法结尾的完整 URL，不会重复追加对应路径。

**自动（根据 URL）**识别明确的原生 API 路径以及 Anthropic、Google 的官方 API 域名。
其他 URL 沿用 Chat Completions，保留已有通用网关配置的行为；不会发送探测请求或试换协议。
只支持 Responses 的网关应明确选择 **OpenAI Responses**，Base URL 保持网关提供的 `/v1`
地址即可。能够读取模型列表不代表网关支持 Chat Completions。

这五种协议支持文字、页面图片、流式输出和函数／工具调用。Responses 的推理数据、
Anthropic 的思考签名和 Gemini 的 thought signature 会与对应工具往返一起保留，
只回传到相同端点、模型和协议。思考选项仍按模型提供；默认不发送可选思考参数。
本设置不覆盖服务端托管工具、音视频生成、Gemini Interactions，以及云平台特有的
OAuth 或 AWS 请求签名。需要这些鉴权流程的 Bedrock、Vertex、Azure 部署需通过兼容网关接入。

models.dev 提供模型 ID、容量和思考档位参考，不会协商网关的 API 协议。
应用目录配置会保留已选协议，改变协议不需要迁移文献库。

CLI 未识别时看[连接说明](runtime-discovery.zh-CN.md)。检测到程序不代表账号有权使用所有模型。

## 思考选项

先选模型，再选择它提供的思考选项。**默认**表示由服务决定。
不同运行方式和模型的档位不同，即使名称相同，行为和费用也未必相同。

Codex、Kimi 的可选项来自本机 CLI。Native 使用已知配置或你保存的配置；
未知模型沿用服务默认值，不猜测参数。

## 可选：查询模型配置

在**设置 → 模型 → 从 models.dev 查询模型配置**中搜索模型，选择后核对建议的
容量与思考选项，再应用到表单。

公开目录只提供参考，请核对所用服务或网关是否支持。它不会替换 Base URL 或 API Key，
只有模型 ID 为空时才填写 ID。可用模型列表来自端点的 `/models` 或 Ollama 的 `/api/tags`。

下载目录后在本地筛选，不会把端点凭据或对话发送给目录服务；离线时仍可手动配置。

## 可选：自定义 Native 思考档位

勾选**自定义此模型的思考选项**，填写逗号分隔的档位。Chat Completions 和 Ollama
还可选择端点接受的参数格式；其他协议由对应适配器生成原生思考参数。

| 格式                          | 行为                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `reasoning_effort`            | 发送档位，`off` 转为 `none`。                                |
| `thinking + reasoning_effort` | `off` / `on` 控制思考，其他档位同时发送 `reasoning_effort`。 |
| `Ollama think`                | `off` / `on` 转为布尔值，其他档位保留字符串。                |

`auto` 不发送思考参数。配置只作用于当前端点和精确模型 ID；
取消自定义即可恢复内置选项。

从 0.6.3-beta.2 起，Native 每次用户提问默认最多 **128 次模型步骤**，所有后端的工具调用默认上限为
每次提问 **48 次**。同一提问的自动续跑共享模型轮次和工具调用额度；新提问会重置
这些执行计数，Token 总数仍保留用于累计统计。输入继续也会保留已保存的写入回执，
避免重复执行中断前已成功的写入。已有自定义上限保持不变。增加次数
不会扩大模型上下文容量。详见[上下文与历史](context-system.zh-CN.md)。
