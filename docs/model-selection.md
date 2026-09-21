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

### 从开源目录查询配置

在 **设置 → 模型 → 从 models.dev 查询模型配置** 中输入模型 ID 或名称，
也可加入服务商名称缩小范围，输入时会自动筛选。列表内可滚动浏览，也可用
方向键和 Enter 选择；Escape 收起候选列表。选择后会显示上下文、输出上限与思考档位；
点击“应用到表单”，核对后保存。

[models.dev](https://models.dev) 是[开源模型目录](https://github.com/anomalyco/models.dev)，
不是所有网关通用的模型 ID 标准。同一模型在不同服务商处可能有不同 ID、容量和
参数格式。目录用于填写参考配置，可用模型列表仍来自配置端点的 `/models`
（Ollama 使用 `/api/tags`）。已有模型 ID、Base URL 和 API Key 不会被目录替换；
模型 ID 为空时才填写所选条目的 ID，因此可以继续使用网关的模型别名。

仅展开目录或使用其筛选框时下载公开目录，查询词在本地筛选，不向 models.dev 发送端点地址、
密钥或对话内容。目录在当前运行期间缓存 24 小时。查询失败时仍可手动设置；
已保存的配置离线保留，模型调用不依赖目录。目录条目可能滞后或与网关不同，
思考 token 预算目前不会导入。

### 自定义 Native 思考档位

在“思考强度”下勾选 **自定义此模型的思考选项**，填写用逗号分隔的档位，
例如 `low, high, ultra`，再选择网关接受的思考参数格式：

| 格式 | 请求行为 |
| ---- | -------- |
| `reasoning_effort` | 发送档位字符串；`off` 转为 `none` |
| `thinking + reasoning_effort` | `off` / `on` 控制 `thinking.type`；其他档位开启思考并发送 `reasoning_effort` |
| `Ollama think` | `off` / `on` 转为布尔值；其他档位作为 `think` 的字符串值 |

“默认”（`auto`）始终不发送思考参数。每个档位最多 64 个字母、数字、下划线或
短横线，最多 32 个档位。保存后可在任务输入区选择，自定义值会发送给服务。
配置按端点和精确模型 ID 保留，其他模型继续使用自己的选项；取消勾选并保存
恢复内置选项。目录只提供参考档位，不保证网关支持同样的请求格式。

此设置用于 Native。Codex 和 Kimi CLI 继续使用各自返回的能力列表。

### 各运行方式的内置选项

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
