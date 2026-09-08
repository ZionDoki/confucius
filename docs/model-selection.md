# 模型与思考选项

在设置中连接一个模型来源，再在任务输入框旁选择模型。

| 运行方式 | 需要准备                                                    | 适用情况                                  |
| -------- | ----------------------------------------------------------- | ----------------------------------------- |
| Native   | OpenAI 兼容接口的 Base URL、模型名和 API Key，或本地 Ollama | 直接连接模型服务，使用 Confucius 管理任务 |
| Codex    | 本机已安装并登录的 Codex CLI                                | 使用 Codex 的模型和执行循环               |
| Kimi     | 本机已安装并登录的 Kimi CLI                                 | 使用 Kimi Code 的模型和执行循环           |

本地 Ollama 通常不需要 API Key。Codex、Kimi 的安装或登录未被识别时，参阅
[检测与连接](runtime-discovery.md)。模型请求的费用与数据处理政策取决于所选服务。

## 选择思考强度

先选择模型，再选择该模型提供的思考选项。不同模型的选项可能不同，不应把某个
引擎的强度名称或上下文用量直接与另一个引擎比较。

Codex 和 Kimi 的模型与思考选项来自当前 CLI 返回的能力列表。Native 对已知模型
使用对应的接口配置；对于没有已知配置的模型，保留服务默认值，不猜测思考参数。
自定义网关需要支持所选模型的接口语义。

Kimi 不同型号的控制方式有区别：

| 模型或接入方式                                     | 思考选项                 |
| -------------------------------------------------- | ------------------------ |
| Kimi CLI 的 K2.7 Coding、Highspeed                 | 开启                     |
| Kimi CLI 的 K3、K3-256k                            | low、high、max           |
| Native 的 kimi-k2.5、kimi-k2.6                     | 默认、关闭、开启         |
| Native 的 kimi-k2.7-code、kimi-k2.7-code-highspeed | 默认、开启；始终保留思考 |
| Native 的 kimi-k3、Coding Plan 的 k3 / k3-256k     | 默认、low、high、max     |

切换 Kimi 模型时，Confucius 会向 CLI 确认实际生效的思考值，避免沿用上一型号的
残留档位。CLI 默认值取决于它的配置；公开 API 的 K3 默认 max，Coding Plan 的
K3 默认 high，不能混用。参阅 [Kimi API 参数说明](https://platform.kimi.com/docs/api/models-overview)
和 [Kimi Code 模型说明](https://www.kimi.com/code/docs/en/kimi-code/models.html)。

Codex 与 Native API 也可能提供不同档位。例如，部分 Codex 模型会报告 ultra，
Native API 的 GPT-6 Astra 当前最高为 max；Confucius 分别读取各自的支持范围。
参阅 [Codex 模型能力](https://learn.chatgpt.com/docs/app-server#models)
和 [GPT-6 Astra API](https://developers.openai.com/api/docs/models/gpt-6-astra)。

“默认”让服务自行决定；“关闭”仅在支持明确关闭思考的模型上出现。切换模型后，
不再适用的旧思考设置会重置。若服务拒绝某个模型或选项，请确认账号权限和服务
支持范围，再重新选择。

## 切换模型与继续任务

任务运行期间不能切换模型。任务停止后，在同一运行方式中切换模型会保留任务、
历史、来源和成果；切换运行方式时，旧运行方式的模型选择会清除。

Native 的模型步骤上限可在设置中调整，默认 128。额度与上下文容量是不同设置，
增加步骤上限不保证模型能正确找回全部历史。长任务和重启后的核对方法见
[任务恢复](tasks-and-data.md#继续未完成的任务)。
