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

Enable **Customize reasoning options for this model**, enter comma-separated levels,
then select the parameter format your endpoint accepts.

| Format                        | Behavior                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| `reasoning_effort`            | Sends a level; `off` becomes `none`.                                       |
| `thinking + reasoning_effort` | `off` / `on` controls thinking; other levels also send `reasoning_effort`. |
| `Ollama think`                | `off` / `on` becomes a boolean; other levels remain strings.               |

`auto` sends no thinking parameter. Custom levels belong to the exact endpoint
and model ID. Disable the customization to restore built-in options.

In the unreleased development branch, Native defaults to **128 model steps per user prompt**. The default tool-call
limit is **48 per user prompt** across backends. Automatic continuations share
the current prompt's model-step and tool-call allowances; a new prompt resets
those execution counters, while token totals remain cumulative for accounting.
Typing a continuation also preserves saved write receipts, so an interrupted
write that already succeeded is not dispatched again.
Existing custom limits are preserved. Raising a limit does not increase the
model's context window. See [context and history](context-system.md).
