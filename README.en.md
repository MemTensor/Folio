<p align="center">
  <img src="integrations/plugins/folio/assets/icon.png" width="80" alt="Folio">
</p>

<h1 align="center">Folio</h1>

<p align="center"><strong>People and Agents, working on the same document</strong></p>

<p align="center">Local Markdown workspace · Cross-project search · Equations, diagrams and tables · Reviewable Agent edits</p>

<p align="center"><a href="#get-started">Get started</a> · <a href="#document-workspace">Workspace</a> · <a href="#an-agent-beside-your-document">Agent</a> · <a href="#sharing-sync-and-project-memory">Sharing</a> · <a href="#documentation-and-development">Docs</a> · <a href="README.md">简体中文</a></p>

![Folio workspace: project documents, equations and tables](docs/images/workspace.png)

Plans, experiment notes and technical proposals may come from you, Claude Code, Codex, or an ongoing collaboration. Folio helps you find those documents across project folders, read them, keep writing and review important changes.

**Your documents remain ordinary Markdown files.** Keep your existing folders, relative asset paths and Git workflow. Reading, editing and local search work offline without a model account.

## Get started

**[Download Folio v0.5.0-beta.22 for macOS Apple Silicon](https://github.com/MemTensor/Folio/releases/download/v0.5.0-beta.22/Folio-0.5.0-beta.22-arm64-mac.zip)** · [Release notes](CHANGELOG.md)

Unzip the download and move `Folio.app` to Applications.

1. **Open a document or project:** open a `.md` file or choose a project folder. Pin projects you use often.
2. **Read and write:** switch between writing, source and reading views; open dedicated equation, diagram and table editors when needed.
3. **Work with Agent:** connect a model, ask questions or request changes beside the document, then review edits before applying them.

The interface supports Simplified Chinese and English. Press **⌘ ,** for categorized settings. Find updates through **Folio → Check for updates** or **Settings → About and updates**.

> This private test release requires access to [MemTensor/Folio](https://github.com/MemTensor/Folio). Developer ID signing and Apple notarization are pending. The project is `UNLICENSED`, with no open-source license grant. See [updates](docs/更新说明.md) for installation and private-release access.

## Document workspace

| What you want to do | How Folio helps |
| --- | --- |
| Find a document | Recent documents, pinned projects and cross-project search; project names and paths distinguish same-name files |
| Browse a project | A document list with filtering and sorting; switch to the folder view when you need the directory structure |
| Read and write | Writing, source and reading views in one editor; outlines, themes, focus and typewriter modes |
| Work with technical content | Preview and edit LaTeX equations, Mermaid diagrams, images and Markdown tables; export PDF, HTML or Word |
| Resume your work | Restore tab order and the active document on startup, close all tabs, or choose each time you quit |
| Edit alongside other tools | Receive file changes, retain unsaved drafts, compare both versions and review or merge edits |
| Copy and organize | Choose Markdown source or rich text when copying from reading view; use context menus for formatting, paths, renaming and tabs |

### Equations, diagrams and tables

Preview inline and display LaTeX, matrices, aligned equations, chemistry notation and Mermaid diagrams, then open their editors to make changes. Tables support row and column editing, alignment and spreadsheet paste. Local images keep relative paths. See the [technical content examples](examples/公式、图与表.md).

### Save, review and recover

Autosave, recovery drafts and version history help preserve your work. Folio checks versions when other tools edit the same file. If you have unsaved changes, it retains both versions for review. Restore a historical version to the editor, inspect it and confirm before saving.

Under **Settings → General → Restore tabs on startup**, choose **On**, **Off** or **Ask every time**. You can remember your choice when quitting. Closing tabs keeps documents and recovery drafts.

Projects stay in their original folders. Optional Codex / Claude Code project discovery reads local project records. Removing a project from the library keeps its source files. See the [user guide](docs/使用指南.md) and [projects and sync](docs/项目与同步.md).

## An Agent beside your document

![Folio Agent: a document conversation with reviewable edits](docs/images/agent.png)

Ask a question or describe a change in the same input. Context can be the current draft, selected text or reference documents you add.

- **Understand the document:** summarize, explain and check structure or reasoning. Suggestions in a new conversation are based on the current document.
- **Find evidence:** look up Markdown and text within the same project, inspect citations and open the sources.
- **Check layout:** models with image input can request a read-only preview of the visible document to inspect equations, diagrams and tables.
- **Review edits:** compare changes with the source and choose what to accept, with a version backup and undo.
- **Continue a request:** invalid output or source matching is returned to the model for repair. Interrupted instructions remain available for retry.

Choose the model and reasoning effort in the panel. Agent tools provide document lookup, reading and visible previews. Edits reach the editor through review.

### Connect your model

| Connection | Setup |
| --- | --- |
| ChatGPT subscription | Install [Codex CLI](https://learn.chatgpt.com/docs/cli), connect in Agent settings and complete official sign-in using your account's Codex access |
| OpenAI-compatible API | Enter the service URL, your API Key and model name; requests use that service's API allowance |

**Use a compatible API** opens API configuration directly. Known authentication and address errors can take you to the relevant field. When you enter settings from a document, saving or completing sign-in returns you to the same conversation with your unsent instruction and cursor selection intact. Entering from application settings returns you to the previous category.

If the browser does not open, reopen or copy the sign-in link. See [Agent assistance](docs/Agent文档助手.md) for setup, context boundaries and controls.

> Screenshots use fictional documents and demonstration conversations. Suggestions and chat send the required context to your configured model service. Visible previews are sent only when the model calls the preview tool. See [architecture and data boundaries](docs/架构与数据边界.md) for details.

### Work with Claude Code and Codex

The independent **CLI, skill and plugin** let external Agents find documents, read versions and sections, and submit version-checked edits. The CLI works while the desktop window is closed.

Try these from the source directory:

```bash
./bin/folio search "公式" --workspace ./examples --json
./bin/folio read "公式、图与表.md" --workspace ./examples --json
./bin/folio library add ./examples --json
./bin/folio library search "实验" --json
```

Writes require the version returned by a read. If the document changes, read it again. Workspace reads and searches do not register projects automatically; use `library add` for ongoing retrieval. The app includes a CLI runtime. See the [integration guide](integrations/README.md) for installation and the protocol.

## Sharing, sync and project memory

| Feature | Scope |
| --- | --- |
| DingTalk online documents (experimental) | Publish or update through the logged-in local `dws` CLI with cloud version checks; text and tables are editable, equations and Mermaid diagrams render as images |
| iCloud Drive | Opt in per project for Markdown and referenced local attachments smaller than 100 MB each; conflicting changes require your choice |
| MemOS (optional) | Configure an API Key and a project knowledge base; Agents maintain document navigation and retrieval clues through the CLI / skill |

Enable each feature separately. MemOS helps later tasks find source documents; local Markdown remains authoritative, and Agents handle routine memory maintenance. See [DingTalk](docs/钉钉集成说明.md), [projects and sync](docs/项目与同步.md) and [Agent integration](integrations/README.md).

## Documentation and development

| Guide | Contents |
| --- | --- |
| [User guide](docs/使用指南.md) | Documents, writing, tab restoration, copying, review, export and shortcuts |
| [Agent assistance](docs/Agent文档助手.md) | Model connections, context, effort, previews and edit review |
| [Agent integration](integrations/README.md) | CLI, Codex / Claude Code skill and plugin |
| [Architecture and data boundaries](docs/架构与数据边界.md) | Code entry points, storage locations and data transfers |
| [Development guide](docs/开发指南.md) | Setup, checks, packaging and releases |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Dependencies and licenses |

Run from source with macOS Apple Silicon, Node.js 22.13+, npm and repository access:

```bash
git clone https://github.com/MemTensor/Folio.git
cd Folio
npm ci
node node_modules/electron/install.js
npm run desktop
```

Use `npm run check` to validate code and desktop flows, `npm run pack` to build the app, and `npm run dist` to create the distribution archive. See [contributing](CONTRIBUTING.md) for development conventions and [security](SECURITY.md) for reporting security issues.

For connection or operation problems, copy or export diagnostics from **Settings → About and updates** or Agent settings. Local logs are capped at about 1 MB. They contain runtime events and error categories, excluding document text, conversations, credentials and sign-in links. Exporting does not send the report.

## Roadmap

- Multiple windows and reading-position restoration across sessions.
- Document references, backlinks and related-document navigation.
- Developer ID signing, notarization and additional platforms.
