<p align="center">
  <img src="integrations/plugins/folio/assets/icon.png" width="80" alt="Folio">
</p>

<h1 align="center">Folio</h1>

<p align="center"><strong>A Markdown workspace for people and AI Agents</strong></p>

<p align="center">Read, find and edit documents across projects. Work with Claude Code and Codex on the same files.</p>

<p align="center"><a href="README.md">简体中文</a> · <a href="#get-started">Get started</a> · <a href="#work-with-agents">Agents</a> · <a href="docs/开发指南.md">Development</a></p>

![Folio: project tabs, formulas and tables](docs/images/workspace.png)

## Your documents, in one place

Plans, technical proposals, experiment records and project notes accumulate across folders as people and Agents work together. Folio gives these documents a common place to read, search, edit and review. Original files remain ordinary Markdown in their existing folders, ready for Git and other tools.

- **Find and resume.** Pin projects, reopen recent documents, search across registered projects and keep several project tabs open. The document list puts files first, with filtering, sorting and folder context.
- **Read technical content.** Switch between writing, source and reading in one editor. Preview LaTeX, Mermaid, images and tables; export PDF, HTML or Word. Choose Chinese or English, with themes and focus options.
- **Work on the same files.** External changes arrive in open tabs. Unsaved human edits are retained, differences can be reviewed and merged, and drafts and history survive restarts.
- **Keep cloud features optional.** Local reading, editing and search work without a model account. Agent assistance, MemOS, DingTalk and project iCloud sync are configured separately.

## Get started

### Desktop app

[Download v0.5.0-beta.14 for macOS Apple Silicon](https://github.com/MemTensor/Folio/releases/download/v0.5.0-beta.14/Folio-0.5.0-beta.14-arm64-mac.zip). Unzip and move `Folio.app` to Applications.

Source and installation packages are hosted in MemTensor/Folio and require repository access. Packages do not yet have Developer ID signing or Apple notarization. The current source repository is **MemTensor/Folio**, is private, and has no open-source license grant.

### Run from source

Requires macOS, Node.js 22.13+ and npm, with access to this repository.

```bash
git clone https://github.com/MemTensor/Folio.git
cd Folio
npm ci
node node_modules/electron/install.js
npm run desktop
```

Open a Markdown file or project folder. Click a paragraph to write, use the document list to find files, and review external updates from the toolbar. See the [user guide](docs/使用指南.md), [development guide](docs/开发指南.md) and [changelog](CHANGELOG.md).

## Work with Agents

Open **Agent** beside a document to use a ChatGPT subscription through the local Codex app-server, or configure an OpenAI-compatible Chat Completions API. Ask questions and request edits from one input. Choose the model and its supported reasoning effort.

The current draft or selected text is the context. You may add reference documents; when working with the whole document, the Agent can find and read bounded excerpts from the same project. It can request a read-only image of the visible document region to check rendering. Shell access and direct file writes are unavailable.

Invalid edits are sent back to the model for a limited repair attempt. Valid proposals go through a diff review before you apply them, with version checks, a backup and undo support. Interrupted requests retain their instructions and can be retried. See [Agent assistance](docs/Agent文档助手.md) and [architecture and data boundaries](docs/架构与数据边界.md).

### Independent CLI, skill and plugin

```bash
./bin/folio search "formula" --workspace ./examples --json
./bin/folio read "公式、图与表.md" --workspace ./examples --json
./bin/folio library add ./examples --json
./bin/folio library search "experiment" --json
```

The CLI works while the desktop app is closed. Writes require the version returned by a read, protecting later changes. Reading or searching a workspace does not automatically register it in the library. [Integration guide](integrations/README.md) covers the CLI and the Codex / Claude Code skill and plugin.

## Optional sharing and memory

- **DingTalk:** confirm publication as an online document through the logged-in local `dws` CLI. Text and tables remain editable; formulas and Mermaid render as images. Version checks protect cloud edits. [Guide](docs/钉钉集成说明.md).
- **MemOS:** configure your own API Key and select or create a project knowledge base. Agents use the CLI / skill to maintain document navigation; local Markdown remains the source.
- **iCloud Drive:** opt in per project for Markdown and referenced local attachments smaller than 100 MB each. Conflicting changes require review. [Projects and sync](docs/项目与同步.md).

## Development

```bash
npm run check   # tests, types, production build and native desktop scenarios
npm run pack    # app bundle and packaged worker / CLI checks
npm run dist    # distribution ZIP
```

Use generated documents and isolated application data. Read [contributing](CONTRIBUTING.md), [security](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md) before submitting changes.

## Roadmap

- Multiple windows and reading-position restoration.
- Document links, backlinks and related-document navigation.
- Signed distribution packages and additional platforms.
