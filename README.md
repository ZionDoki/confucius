# Confucius

English · [简体中文](README.zh-CN.md)

**Read, compare and organize research inside Zotero.**

Confucius helps you find papers, ask questions about PDFs, write reports and review
suggested annotations. Reports save as Zotero notes; the knowledge library indexes
your notes and research memory.

[Download](https://github.com/ZionDoki/confucius/releases/latest) ·
[User guide](docs/README.md) · [Changelog](CHANGELOG.md) ·
[Product film](https://github.com/user-attachments/assets/8cf1175e-d3f9-4c31-b19f-5e3b171456fc)

> These guides describe the current source code.
> An installed release may differ. See [updates](docs/updates.md) to check your version.

## Install

Requires **Zotero 7 or later**.

1. Download `confucius.xpi` from the [release page](https://github.com/ZionDoki/confucius/releases/latest).
2. In Zotero, open **Tools → Add-ons**.
3. Use the gear menu → **Install Add-on From File**, then select the XPI.
4. Click the **Confucius toolbar button** to open the workspace.

## Connect a model

Open **Confucius Settings** and choose one connection:

| Connection | What you need                                                                 |
| ---------- | ----------------------------------------------------------------------------- |
| Native     | An OpenAI-compatible Base URL, model ID and API key, or a local Ollama server |
| Codex      | Codex CLI installed and signed in on this computer                            |
| Kimi       | Kimi CLI installed and signed in on this computer                             |

For Codex or Kimi, leave the executable path empty for automatic detection, then
click **Check again** after installation or sign-in. Model access and costs depend on
your provider. See [model setup](docs/model-selection.md).

## Start your first task

- **Read a paper:** add it with `@`, then ask “Explain the method and show the supporting pages.”
- **Find literature:** ask a research question, review the literature capsule, then
  confirm candidates before importing papers and downloading PDFs.
- **Save a result:** open the report, choose **Zotero note**, review the preview and
  confirm. Use **Export file** for a separate HTML copy.
- **Annotate a PDF:** ask for highlights, then accept or reject suggestions in the
  **Annotations** capsule.

A new conversation can start without a paper. Switching PDF tabs does not change
its sources. You can also drop PDF, Markdown or TXT files into the workspace.

Continue with the [user guide](docs/README.md) or [troubleshooting](docs/troubleshooting.md).

## Build from source

Requires Node.js **22.8+**. Building does not require Zotero; local preview does.

```sh
npm install
npm run build
npm start
```

The package is `apps/zotero-addon/.scaffold/build/confucius.xpi`.
See [development setup](.github/maintainers/development.md) for cloning, custom
Zotero paths, checks and repository layout.

## License

AGPL-3.0-or-later.
