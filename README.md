<p align="center">
  <img src="integrations/plugins/folio/assets/icon.png" width="80" alt="Folio">
</p>

<h1 align="center">Folio</h1>

<p align="center"><strong>让人和 Agent 围绕同一份文档工作</strong></p>

<p align="center">本地 Markdown 工作台 · 跨项目查找 · 公式、图与表 · 可审阅的 Agent 修改</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="#文档工作台">文档工作台</a> ·
  <a href="#文档旁的-agent">Agent</a> ·
  <a href="#分享同步与项目记忆">分享与同步</a> ·
  <a href="#文档与开发">文档</a> ·
  <a href="README.en.md">English</a>
</p>

![Folio 文档工作台：项目文档、公式与表格](docs/images/workspace.png)

计划、实验记录、技术方案和项目笔记，可能由你写下，也可能来自 Claude Code、Codex，或双方持续协作。Folio 帮你找到这些散落在项目文件夹中的文档，读懂它们，继续编辑，并确认每一次重要修改。

**原文始终是普通 Markdown 文件。** 沿用现有目录、相对资源路径和 Git；基础阅读、编辑和本地搜索无需模型账号，也可离线使用。

## 开始使用

**[下载 Folio v0.5.0-beta.22 · macOS Apple Silicon](https://github.com/MemTensor/Folio/releases/download/v0.5.0-beta.22/Folio-0.5.0-beta.22-arm64-mac.zip)** · [更新记录](CHANGELOG.md)

解压后将 `Folio.app` 放入“应用程序”文件夹。

1. **打开文档或项目**：直接打开 `.md` 文件，或选择项目文件夹；常用项目可以置顶。
2. **阅读并继续写作**：在写作、源码和阅读模式之间切换，按需编辑公式、图表和表格。
3. **与 Agent 协作**：连接模型后，在文档旁提问或描述修改要求，审阅后再应用。

界面支持简体中文与英语。按 **⌘ ,** 打开分类设置；从 **Folio → 检查更新** 或 **设置 → 关于与更新** 获取新版。

> 当前为私有测试版，下载需要 [MemTensor/Folio](https://github.com/MemTensor/Folio) 的访问权限。安装包尚未完成 Developer ID 签名与 Apple 公证；项目标记为 `UNLICENSED`，未授予开源许可。安装与私有更新的准备步骤见 [更新说明](docs/更新说明.md)。

## 文档工作台

| 你想做什么 | Folio 如何帮助你 |
| --- | --- |
| 找回某篇文档 | 最近文档、置顶项目、跨项目搜索；同名文件显示所属项目和路径 |
| 浏览一个项目 | 默认展示文档列表，支持名称筛选和排序；需要目录结构时切换文件夹视图 |
| 阅读与写作 | 同一区域切换写作、源码、阅读；支持大纲、主题、专注与打字机模式 |
| 处理技术内容 | 预览和编辑 LaTeX 公式、Mermaid 图表、图片与 Markdown 表格；导出 PDF、HTML、Word |
| 接着上次工作 | 启动时恢复标签顺序和当前文档；也可选择全部关闭，或每次退出时询问 |
| 与外部工具共同编辑 | 接收文件变化，保留未保存草稿，比较双方内容并审阅、合并修改 |
| 复制与整理 | 阅读复制可选 Markdown 源码或带格式文本；右键提供格式、路径、重命名与标签操作 |

### 公式、图与表

行内与块级 LaTeX、矩阵、多行对齐、化学式，以及 Mermaid 图表，都可在文档中预览并打开专用编辑器。表格支持增删行列、列对齐和从电子表格粘贴；本地图片沿用相对路径。完整语法见 [公式、图与表样例](examples/公式、图与表.md)。

### 保存、审阅与恢复

自动保存、恢复草稿和历史版本共同保护写作过程。外部工具修改同一份文件时，Folio 会检查版本；有本地未保存内容时保留双方修改，交由你审阅。历史版本可恢复到编辑区，确认后再保存。

在 **设置 → 通用 → 启动时恢复标签** 中选择“开启”“关闭”或“每次询问”。退出时可以记住本次选择；关闭标签会保留文档和恢复草稿。

项目保留在原位置。可选的 Codex／Claude Code 项目发现只读取本机项目记录；从文档库移除项目不会删除原文。详细范围见 [使用指南](docs/使用指南.md) 与 [项目与同步](docs/项目与同步.md)。

## 文档旁的 Agent

![Folio Agent：围绕文档对话，审阅修改后再应用](docs/images/agent.png)

在同一个输入框中提问或描述修改。上下文可以是当前草稿、选中文字，或你添加的参考文档。

- **理解文档**：总结、解释、检查结构和论证；空白对话中的建议围绕当前文档生成。
- **找到依据**：按需查找和读取同项目的 Markdown／文本，展开来源并打开原文。
- **核对排版**：支持图片输入的模型可请求当前可见区域的只读预览，检查公式、图表与表格。
- **审阅修改**：先对照原文，再选择接受；接受前保留历史，并可撤销。
- **继续处理**：回复格式或原文定位有误时反馈给模型修正；中断后保留指令，供你重试。

模型与思考强度可在面板中选择。Agent 工具限于文档查找、读取和可见预览；修改经审阅进入编辑器。

### 连接你使用的模型

| 接入方式 | 如何配置 |
| --- | --- |
| ChatGPT 订阅 | 安装 [Codex CLI](https://learn.chatgpt.com/docs/cli)，在 Agent 设置中连接并完成官方页面登录，使用账号提供的 Codex 额度 |
| OpenAI 兼容 API | 填写服务地址、自己的 API Key 和模型名称，使用该服务的 API 额度 |

“使用兼容 API”直接打开 API 配置；已知授权或地址错误可定位到相应输入项。从文档进入设置后，保存或登录完成会返回原对话，保留尚未发送的指令与光标选区。从应用设置进入则返回原分类。

登录页未自动打开时，可以重新打开或复制登录链接。接入、上下文范围和操作说明见 [Agent 文档助手](docs/Agent文档助手.md)。

> 截图使用虚构文档与演示对话。文档建议和对话会将所需上下文发送给你配置的模型服务；可见预览仅在模型调用工具时提供。具体数据范围见 [架构与数据边界](docs/架构与数据边界.md)。

### 与 Claude Code、Codex 协作

独立的 **CLI、skill 和 plugin** 为外部 Agent 提供文档入口：查找文件、读取版本与章节、提交带版本检查的修改。CLI 在桌面窗口关闭后仍可使用。

在源码目录中试用：

```bash
./bin/folio search "公式" --workspace ./examples --json
./bin/folio read "公式、图与表.md" --workspace ./examples --json
./bin/folio library add ./examples --json
./bin/folio library search "实验" --json
```

写入须提供读取时的版本；原文变化后需要重新读取。`read`、`search` 不会自动登记项目，需要长期检索时使用 `library add`。应用随包提供 CLI 运行时，安装方式与协议见 [Agent 接入指南](integrations/README.md)。

## 分享、同步与项目记忆

| 功能 | 使用范围 |
| --- | --- |
| 钉钉在线文档（实验性） | 通过本机已登录的 `dws` 发布或更新，并核对云端版本；正文、表格可编辑，公式与 Mermaid 以图片呈现 |
| iCloud Drive | 按项目开启，包含 Markdown 与引用的本地图片／附件，单文件小于 100 MB；双侧修改冲突由你选择 |
| MemOS（可选） | 配置 API Key 并选择或创建项目知识库，由 Agent 经 CLI／skill 维护文档导航与检索线索 |

这些能力分别启用。MemOS 帮助后续任务找到原文，本地 Markdown 始终是文档来源，日常记忆维护由 Agent 完成。详见 [钉钉集成](docs/钉钉集成说明.md)、[项目与同步](docs/项目与同步.md) 与 [Agent 接入](integrations/README.md)。

## 文档与开发

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/使用指南.md) | 文档管理、写作、标签恢复、复制、审阅、导出与快捷键 |
| [Agent 文档助手](docs/Agent文档助手.md) | 模型接入、上下文、思考强度、预览与修改审阅 |
| [Agent 接入指南](integrations/README.md) | 独立 CLI、Codex／Claude Code skill 与 plugin |
| [架构与数据边界](docs/架构与数据边界.md) | 代码入口、存储位置与数据传输范围 |
| [开发指南](docs/开发指南.md) | 环境、检查、构建与发布 |
| [第三方组件](THIRD_PARTY_NOTICES.md) | 依赖与授权说明 |

从源码运行需要 macOS Apple Silicon、Node.js 22.13+、npm 和仓库访问权限：

```bash
git clone https://github.com/MemTensor/Folio.git
cd Folio
npm ci
node node_modules/electron/install.js
npm run desktop
```

运行 `npm run check` 验证代码与桌面流程，`npm run pack` 构建应用，`npm run dist` 生成分发包。提交约定见 [参与开发](CONTRIBUTING.md)，安全问题见 [安全说明](SECURITY.md)。

反馈问题时，可从 **设置 → 关于与更新** 或 Agent 设置复制、导出诊断信息。本地日志最多约 1 MB，保留运行事件和错误类别，不记录正文、对话、凭据或登录链接；导出不会自动发送。

## 路线图

- 多窗口与跨会话阅读位置恢复。
- 跨文件引用、反向链接和相关文档导航。
- Developer ID 签名、公证与更多平台支持。
