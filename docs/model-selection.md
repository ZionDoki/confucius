# Model setup

English · [简体中文](model-selection.zh-CN.md)

[User guide](README.md)

## Choose a connection

| Runtime | Setup                                                                               |
| ------- | ----------------------------------------------------------------------------------- |
| Native  | Add an endpoint: Base URL, model ID and API key. Local Ollama usually needs no key. |
| Codex   | Install and sign in to the CLI, then refresh detection in Settings.                 |
| Kimi    | Install and sign in to the CLI, then refresh detection in Settings.                 |

The model receives your messages and material included in its context. Data
handling follows the endpoint or runtime you choose.

Select the model next to the composer. Stop the current run before changing it.
Changing models within one runtime keeps the task, sources and reports; changing
runtimes clears the previous runtime's model selection.

## Native API protocol (from 0.6.4-beta.2)

In **Settings → Model → API protocol**, choose the protocol accepted by your
endpoint. The same control is available in Zotero's Confucius preferences.
Save the endpoint in workspace settings; Zotero preferences save the selection
immediately. Each endpoint keeps its own choice.

| Protocol                | Example Base URL                                   | Authentication      |
| ----------------------- | -------------------------------------------------- | ------------------- |
| OpenAI Chat Completions | `https://api.openai.com/v1`                        | Bearer API key      |
| OpenAI Responses        | `https://api.openai.com/v1`                        | Bearer API key      |
| Anthropic Messages      | `https://api.anthropic.com/v1`                     | Anthropic API key   |
| Gemini Generate Content | `https://generativelanguage.googleapis.com/v1beta` | Google API key      |
| Ollama                  | `http://localhost:11434`                           | Optional Bearer key |

Use the gateway's own Base URL when connecting through a proxy. Gateway path
prefixes and query parameters are preserved. Full URLs ending in `/responses`,
`/messages`, `/chat/completions`, `/api/chat`, or a Gemini generation method
are also accepted; the matching route is not appended twice.

**Auto (from URL)** recognizes explicit native API paths and the Anthropic and
Google API hosts. Other URLs use Chat Completions, preserving existing generic
gateway configurations. Auto does not send probe requests or try other protocols.
For a Responses-only gateway, select **OpenAI Responses** explicitly while
keeping its `/v1` Base URL. A successful model-list lookup alone does not prove
that Chat Completions is available.

These five protocols support text, page images, streaming, and function/tool
calls. Responses reasoning items, Anthropic thinking signatures, and Gemini
thought signatures stay attached to their tool exchanges and are replayed only
to the same endpoint, model, and protocol. Reasoning options remain model-specific;
Default sends no optional reasoning controls. Provider-hosted tools, audio/video
generation, Gemini Interactions, and cloud-specific OAuth or AWS request signing
are not covered by this endpoint editor. Bedrock, Vertex, and Azure deployments
requiring those authentication flows need a compatible gateway.

models.dev supplies model IDs, limits, and reasoning levels; it does not negotiate
your gateway's API protocol. Importing catalog settings preserves the selected
protocol. Protocol changes require no library migration.

For CLI problems, see [CLI connections](runtime-discovery.md). A detected
executable does not prove your account can use every model.

## Thinking options

Choose the model first, then one of its available thinking options. **Default**
lets the service decide. Options vary by runtime and model; matching names do not
guarantee matching behavior or cost.

Codex and Kimi report their capabilities through the installed CLI. Native uses
known profiles or your saved configuration. An unknown model keeps the service
default instead of receiving guessed parameters.

## Optional: look up model settings

In **Settings → Model → Look up model settings on models.dev**, search for a
model, select it, review the suggested limits and apply them to the form.

The public directory is a reference. Confirm that the settings match your
provider or gateway. It does not replace your Base URL or API key, and only fills
the model ID when that field is empty. The endpoint's model list comes from
`/models` or Ollama's `/api/tags`.

Filtering happens locally after downloading the directory; endpoint credentials
and conversations are not sent to it. Manual configuration still works offline.

## Optional: custom Native thinking levels

Enable **Customize reasoning options for this model** and enter comma-separated
levels. Chat Completions and Ollama also offer parameter-format overrides; the
other protocols use their native reasoning parameters.

| Format                        | Behavior                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| `reasoning_effort`            | Sends a level; `off` becomes `none`.                                       |
| `thinking + reasoning_effort` | `off` / `on` controls thinking; other levels also send `reasoning_effort`. |
| `Ollama think`                | `off` / `on` becomes a boolean; other levels remain strings.               |

`auto` sends no thinking parameter. Custom levels belong to the exact endpoint
and model ID. Disable the customization to restore built-in options.

Since 0.6.3-beta.2, Native defaults to **128 model steps per user prompt**. The default tool-call
limit is **48 per user prompt** across backends. Automatic continuations share
the current prompt's model-step and tool-call allowances; a new prompt resets
those execution counters, while token totals remain cumulative for accounting.
Typing a continuation also preserves saved write receipts, so an interrupted
write that already succeeded is not dispatched again.
Existing custom limits are preserved. Raising a limit does not increase the
model's context window. See [context and history](context-system.md).
