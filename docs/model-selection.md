# Model selection and thinking controls

The composer opens a flat list of models. Each row identifies its endpoint or CLI. Selecting a model replaces that panel with the thinking choices reported for that model; models without adjustable thinking finish selection immediately. The settings gear remains the entry point for configuring endpoints and runtime installations.

## Capability sources

- **Codex:** `model/list` from the installed App Server, including pagination, `supportedReasoningEfforts`, and `defaultReasoningEffort`. CLI values are opaque, so new levels do not require a UI release. They are passed as `model` and `effort` to `turn/start`. [Official App Server reference](https://learn.chatgpt.com/docs/app-server#models).
- **Kimi:** ACP `session/new` / resume responses supply `configOptions`. Thinking options belong to the current model only. The host switches a disposable probe session to discover another model's choices, then uses `session/set_config_option` to select the actual task's model before setting its thinking option. Legacy ACP catalogs retain model selection without fabricated thinking levels. Probe configuration and credentials are copied to private disposable directories, because older CLI versions can persist model switches into their global config. These directories are removed after probing. [ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp), [data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html).
- **Native API:** the shared resolver in `packages/protocol/src/modelReasoning.ts` supplies documented profiles for known model IDs. Unknown IDs and variants keep the provider default and send no guessed reasoning parameter. Endpoint model discovery continues to use the provider's model list; a standard OpenAI `/models` response does not report reasoning capabilities. A custom gateway must honor the advertised model's API semantics for its documented profile to apply.

Native examples, verified against official documentation on 2026-09-05:

| Model / API                | Choices beyond provider default    | Request mapping                         |
| -------------------------- | ---------------------------------- | --------------------------------------- |
| GPT-6 Astra                | low, medium, high, xhigh, max      | `reasoning_effort`                      |
| GPT-5.6 Sol / Terra / Luna | off, low, medium, high, xhigh, max | off → `reasoning_effort: "none"`        |
| GPT-5.5                    | off, low, medium, high, xhigh      | `reasoning_effort`                      |
| Kimi K2.5 / K2.6           | off, on                            | `thinking.type: "disabled" / "enabled"` |
| DeepSeek V4                | off, low, high, max                | `thinking.type` and `reasoning_effort`  |
| Ollama GPT-OSS             | low, medium, high                  | `think` as a level; no off switch       |
| Ollama Qwen3 / DeepSeek R1 | off, on                            | `think: false / true`                   |

Sources: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5), [Kimi models](https://platform.kimi.ai/docs/api/models-overview), [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/), [Ollama thinking](https://docs.ollama.com/capabilities/thinking).

## State and failures

Native preferences belong to the selected endpoint. Switching a model resets an unsupported saved effort to the provider default. “Default” omits the parameter; “Off” sends an explicit supported disable value. The composer, settings picker, and outbound request builder share this rule.

Codex and Kimi choices are stored in the schema-v3 task's optional `runtimeModel` field. Changing a model within the same runtime preserves the task ID, history, window, sources, workflow preset, draft, and artifacts. Changing the runtime clears the previous runtime's model choice. Host persistence rolls back the choice on failure; active turns cannot change models. The CLI's current catalog is validated before applying explicit selections, and failed model/effort changes never proceed to a prompt. Capability lookup alone sends no inference request.

Task source actions now live on the task header's source menu. The composer `+` menu keeps execution mode and permission choices; `@` remains the entry point for adding individual papers and task references. The source menu preserves adding or replacing the current Zotero selection, including collection and reader context.
