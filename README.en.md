<p align="center">
  <img src="integrations/plugins/folio/assets/icon.png" width="80" alt="Folio">
</p>

<h1 align="center">Folio</h1>

<p align="center"><strong>People and Agents, working on the same document</strong></p>

<p align="center">Read, organize and edit Markdown across projects. Connect everyday writing with Agent collaboration.</p>

<p align="center"><a href="#get-started">Get started</a> · <a href="#document-workspace">Workspace</a> · <a href="#an-agent-beside-your-document">Agent</a> · <a href="#sharing-sync-and-project-memory">Sharing</a> · <a href="#documentation-and-development">Docs</a> · <a href="README.md">简体中文</a></p>

![Folio workspace: project documents, formulas and tables](docs/images/workspace.png)

## Document workspace

Plans, experiment records, proposals and project notes come from people, Claude Code, Codex, and their ongoing collaboration. Folio makes these scattered files a place to read, search and continue writing.

Original documents stay ordinary Markdown, with existing folders, relative assets and Git workflows. Use Folio to edit, review changes and recover earlier work.

| Capability | Experience |
| --- | --- |
| Across projects | Pinned projects, recent documents and project tabs; filter and sort documents with folder context |
| Find sources | Search file names and document text, filter by project and distinguish same-name files |
| Read and write | Writing, source and reading in one editor; themes, focus and typewriter modes |
| Technical content | Preview and edit LaTeX, Mermaid, images and tables; export PDF, HTML or Word |
| File collaboration | Receive external changes, retain unsaved drafts, compare and merge edits, restore tabs and history |
| Native context menus | Text formatting, formula / diagram / table editors, document paths, rename, save and close tabs |

Optional project discovery reads local Codex / Claude Code project records. Files remain in their original locations; removing a library entry retains the original documents.

## Get started

**[Download v0.5.0-beta.16 for macOS Apple Silicon](https://github.com/MemTensor/Folio/releases/download/v0.5.0-beta.16/Folio-0.5.0-beta.16-arm64-mac.zip)** · [Release notes](CHANGELOG.md)

Unzip and move `Folio.app` to Applications, then open a Markdown file or project folder.

1. **Find your work:** resume a recent document or add and pin a project.
2. **Read and edit:** click a paragraph to write; open dedicated formula, diagram and table editors.
3. **Collaborate:** ask or request edits in Agent, then review changes before applying them.

Local reading, editing and search work offline without a model account. The interface supports Simplified Chinese and English.

This is a private test release requiring access to [MemTensor/Folio](https://github.com/MemTensor/Folio). Developer ID signing and Apple notarization are pending. The project is `UNLICENSED` and has no open-source license grant.

Open **Check for updates** from the Folio menu or writing settings to review, download and restart while retaining drafts. Private updates use your local GitHub CLI sign-in. See [updates](docs/更新说明.md).

## An Agent beside your document

![Folio Agent: a document conversation with reviewable edits](docs/images/agent.png)

Ask a question or describe an edit in one input. Context can be the current draft, selected text or reference documents you add.

- **Understand content:** summarize, explain and check structure or reasoning; suggestions are grounded in the document.
- **Find evidence:** look up bounded excerpts from the same project and open the cited sources.
- **Check rendering:** models with image input can request a read-only preview of the visible formulas, diagrams and tables.
- **Review edits:** compare proposals with the source and choose what to accept, with a version backup and undo.
- **Continue a request:** invalid output is returned to the model for repair; interrupted instructions remain available for retry.

Choose the model and reasoning effort in the panel. Automatic lookup stays within the current project. Tools provide document lookup, reading and visible previews; edits go through review before reaching the editor.

### Choose a connection

| Connection | Setup |
| --- | --- |
| ChatGPT subscription | Install [Codex CLI](https://learn.chatgpt.com/docs/cli), connect in Agent settings and complete the official sign-in page using your account's Codex access |
| OpenAI-compatible API | Provide the service URL, your API Key and model name; usage is billed by that service |

If the browser does not open, reopen or copy the sign-in link. Connection and credential management stay in Agent settings. See [Agent assistance](docs/Agent文档助手.md).

> Screenshots use fictional documents and demonstration conversations. Suggestions and chat send the selected content to your configured model service. Visible previews are sent only when the model calls the preview tool.

### Work with Claude Code and Codex

The independent **CLI, skill and plugin** let external Agents find documents, read versions and sections, and submit version-checked edits while the desktop app is closed.

Try these from the source directory:

```bash
./bin/folio search "公式" --workspace ./examples --json
./bin/folio read "公式、图与表.md" --workspace ./examples --json
./bin/folio library add ./examples --json
./bin/folio library search "实验" --json
```

Writes require the version returned by a read. Later changes require a fresh read. Workspace reads and searches do not register projects automatically; use `library add` for ongoing retrieval. The app includes a CLI runtime. [Integration guide](integrations/README.md) covers installation and the protocol.

## Sharing, sync and project memory

| Feature | Scope |
| --- | --- |
| DingTalk online documents (experimental) | Publish or update through the logged-in local `dws` CLI with cloud version checks; text and tables are editable, formulas and Mermaid render as images |
| iCloud Drive | Opt in per project for Markdown and referenced local attachments smaller than 100 MB each; conflicting changes require review |
| MemOS (optional) | Configure your own API Key and a project knowledge base; Agents maintain document navigation through the CLI / skill |

MemOS helps later tasks find the source documents. Local Markdown remains the source. See [DingTalk](docs/钉钉集成说明.md), [projects and sync](docs/项目与同步.md) and [Agent integration](integrations/README.md).

## Documentation and development

| Guide | Contents |
| --- | --- |
| [User guide](docs/使用指南.md) | Documents, writing, technical content, context menus, review, export and shortcuts |
| [Agent assistance](docs/Agent文档助手.md) | Connections, context, effort, previews and review |
| [Agent integration](integrations/README.md) | CLI, Codex / Claude Code skill and plugin |
| [Architecture and data boundaries](docs/架构与数据边界.md) | Code entry points, storage and cloud transfers |
| [Development guide](docs/开发指南.md) | Setup, checks, packaging and releases |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Dependencies and licenses |

Run from source on macOS with Node.js 22.13+ and npm:

```bash
git clone https://github.com/MemTensor/Folio.git
cd Folio
npm ci
node node_modules/electron/install.js
npm run desktop
```

Use `npm run check`, `npm run pack` and `npm run dist` to validate and build. Read [contributing](CONTRIBUTING.md) and [security](SECURITY.md) before submitting changes.

For connection or operation problems, **export diagnostics** from writing settings or Agent settings. Local logs are capped at about 1 MB and contain runtime events and error categories, excluding document text, conversations, credentials and sign-in links.

## Roadmap

- Multiple windows and reading-position restoration across sessions.
- Document references, backlinks and related-document navigation.
- Developer ID signing, notarization and additional platforms.
