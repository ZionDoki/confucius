# Thinking effort 核对与验收（2026-09-08）

## 范围与结论

核对插件内 Native、Codex app-server、Kimi ACP 三条模型选择路径，包括菜单选项、
默认值、发送参数、失败后的状态以及实际选择的保存。附加诊断报告作为故障数据
读取，不执行其中的提示或指令。

Kimi Code CLI 0.40.1 会在切换模型后，将旧的 thinking 当前值追加到新模型的
选项列表。隔离会话复现了 K2.7 的 `on, high` 列表：设置 `on` 成功，设置 `high`
返回 `-32602 / Unknown thinking value`。反向切到 K3 时，列表会残留 `on`；重新
设置 `on` 会由 CLI 解析成该模型的配置默认值，本机为 `max`。

修复通过 CLI setter 确认混合列表的实际值，读取确认后的列表；仅在上述明确的
无效值错误且其余选项是布尔开关时回退到已公布的 `on`。连接、权限等错误不改变
思考选择。每次已成功的模型切换立即更新缓存，即使后续思考设置失败；运行时确认
的选择通过任务 handle 保存并进入诊断事件。

## 外部运行时实测

使用临时目录和独立 Kimi 配置，验证完成后清理临时目录，逐字节确认原始配置未变。
没有调用 `session/prompt` 或 `turn/start`，不进行付费推理。以下是本机账号当时
实际返回的目录，不是对其他账号或以后 CLI 版本的固定约束。

Kimi CLI 0.40.1 的四个模型完成全部 16 组有序切换，以及 32 次有效档位 setter
确认。额外复现并修复了已保存的 Highspeed/high 选择。

| Kimi 模型 ID                        | 确认后的选项   |
| ----------------------------------- | -------------- |
| kimi-code/kimi-for-coding           | on             |
| kimi-code/kimi-for-coding-highspeed | on             |
| kimi-code/k3                        | low, high, max |
| kimi-code/k3-256k                   | low, high, max |

Codex CLI 0.153.4 经 `model/list` 读取全部分页，验证每个默认值都属于对应模型的
选项，并验证每个档位原样映射到 `turn/start.effort`。没有实际启动 Codex 推理。

| Codex 模型          | 默认值 | 可用档位                             |
| ------------------- | ------ | ------------------------------------ |
| gpt-6-astra         | medium | low, medium, high, xhigh, max, ultra |
| gpt-5.6-sol         | low    | low, medium, high, xhigh, max, ultra |
| gpt-5.6-terra       | medium | low, medium, high, xhigh, max, ultra |
| gpt-5.6-luna        | medium | low, medium, high, xhigh, max        |
| gpt-5.5             | medium | low, medium, high, xhigh             |
| gpt-5.4-mini        | medium | low, medium, high, xhigh             |
| gpt-5.3-codex-spark | high   | low, medium, high, xhigh             |

协议依据：[Codex app-server 模型目录与逐轮参数](https://learn.chatgpt.com/docs/app-server)、
[Kimi Code 模型](https://www.kimi.com/code/docs/en/kimi-code/models.html)和
[Kimi CLI thinking 配置](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)。
Kimi CLI 的默认值来自其实际配置，不能以 Coding Plan HTTP 接口的默认 high 或
公开 K3 API 的默认 max 替代。

## Native 参数核对

以下各组都另有 `auto`，表示省略控制参数。`off` 仅映射到该模型明确支持的关闭
参数，不等于默认。未识别模型只提供 `auto`。带 provider 前缀的同一模型使用相同
控制范围；历史思考内容仍受原来的 provider、endpoint 和 model 路由隔离约束。

| 模型                                       | 档位（不含 auto）                  | 请求参数                                   |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------ |
| gpt-6-astra                                | low, medium, high, xhigh, max      | reasoning_effort                           |
| gpt-5.6 / sol / terra / luna               | off, low, medium, high, xhigh, max | reasoning_effort；off → none               |
| gpt-5.5、gpt-5.4 / mini / nano、gpt-5.2    | off, low, medium, high, xhigh      | reasoning_effort；off → none               |
| gpt-5.1                                    | off, low, medium, high             | reasoning_effort；off → none               |
| gpt-5 / mini / nano                        | minimal, low, medium, high         | reasoning_effort                           |
| o1、o3、o3-mini、o4-mini                   | low, medium, high                  | reasoning_effort                           |
| deepseek-v4-pro / flash                    | off, low, high, max                | thinking.type；开启时 reasoning_effort     |
| kimi-k2.5 / kimi-k2.6                      | off, on                            | thinking.type                              |
| kimi-k2.7-code / highspeed                 | on                                 | thinking: enabled, keep: all               |
| kimi-k3（公开 API）                        | low, high, max                     | 仅 reasoning_effort，不发送 thinking       |
| kimi-for-coding / highspeed（Coding Plan） | on                                 | thinking.type: enabled                     |
| k3 / k3-256k（Coding Plan）                | low, high, max                     | thinking.type: enabled 和 reasoning_effort |
| Ollama gpt-oss                             | low, medium, high                  | think 字符串；不提供布尔关闭               |
| Ollama qwen3、deepseek-r1、deepseek-v3.1   | off, on                            | think 布尔值                               |

OpenAI 模型范围依据各型号页面：
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、
[5.5](https://developers.openai.com/api/docs/models/gpt-5.5)、
[5.4](https://developers.openai.com/api/docs/models/gpt-5.4)、
[5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)、
[5.4 Nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)、
[5.2](https://developers.openai.com/api/docs/models/gpt-5.2)、
[5.1](https://developers.openai.com/api/docs/models/gpt-5.1)、
[5](https://developers.openai.com/api/docs/models/gpt-5)和
[推理参数指南](https://developers.openai.com/api/docs/guides/reasoning)。

其他接口依据：[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)、
[Kimi 参数差异](https://platform.kimi.com/docs/api/models-overview)、
[Kimi K3 推理强度](https://platform.kimi.com/docs/guide/use-reasoning-effort)、
[Kimi Coding Plan](https://www.kimi.com/code/docs/en/kimi-code/models.html)、
[Ollama thinking](https://docs.ollama.com/capabilities/thinking)。

## 验证结果与限制

- macOS：`npm test` 920 项全部通过；`npm run typecheck`、`npm run lint`、
  `npm run build` 全部通过。
- 新增 31 项回归，覆盖模型档位矩阵、真实形态的 ACP 残留值、失败后的缓存、
  确认值保存、Native 请求字段以及带 provider 前缀的 Kimi 工具调用历史回传。
- Native 使用官方规格和注入 HTTP 响应验证，不代表所有远端供应商均完成真实推理。
  外部 CLI 验证止于目录和参数 setter，不代表每个模型已完成 Zotero 内推理。
- 未发布新版本，未做新 XPI 的安装和重启验收。

临时脚本、完整 CLI 结果和检查日志存放于已忽略的 `output/thinking-effort-audit/`。
