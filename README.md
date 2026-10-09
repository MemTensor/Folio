<p align="center">
  <img src="integrations/plugins/folio/assets/icon.png" width="80" alt="Folio">
</p>

<h1 align="center">Folio</h1>

<p align="center"><strong>人与 AI Agent 共用的 Markdown 文档工作台</strong></p>

<p align="center">阅读、查找和编辑不同项目的文档，与 Claude Code、Codex 协作同一份文件。</p>

<p align="center">
  <a href="#为什么是-folio">产品简介</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#与-ai-agent-协作">Agent 协作</a> ·
  <a href="docs/使用指南.md">使用指南</a> ·
  <a href="README.en.md">English</a> ·
  <a href="#路线图">路线图</a>
</p>

![Folio 的跨项目标签、公式排版与表格阅读界面](docs/images/workspace.png)

## 为什么是 Folio？

计划、技术方案、实验记录和项目笔记，正在由你和 AI Agent 共同产生。它们分散在不同文件夹里，随着工作不断更新，也需要在几周、几个月之后重新找到。

Folio 为这些文档提供一个统一入口。你可以跨项目查找、同时保留多个文档标签、直接编辑原文，也可以审阅 Agent 刚刚写入的内容。文件始终保留为普通 Markdown，继续使用原来的目录、Git 和其他工具。

### 跨项目，接着工作

首页集中显示常用项目与最近文档，可以置顶经常使用的项目，直接继续阅读。其他项目从“添加项目”中查找；开启 Codex／Claude Code 项目发现后，也可从本机记录中选择，临时任务默认收起。进入项目后，左侧直接列出文档，支持按名称查找、按修改时间排序和查看所在目录，也可切换到文件夹视图。

跨项目搜索覆盖文件名与正文，结果可以按项目筛选，同名文件会标明归属。你可以从文档库移除不再需要的项目，磁盘上的文档继续保留。项目发现只读取本机项目记录并缓存，不扫描整个磁盘。

### 让技术内容清楚可读

在同一个编辑区域切换写作、源码和阅读模式。LaTeX 公式、Mermaid 图表、图片和表格都能直接预览与编辑，支持导出 PDF、HTML 和 Word。专注模式、打字机模式及三种主题，让长时间阅读和写作更舒适。

### 人和 Agent，共同维护原文

Claude Code 或 Codex 修改文件后，Folio 会显示变化。如果你也在编辑，草稿会被保留，双方的修改可以比较、合并或逐处选择。后台标签同样接收更新，关闭应用后还可以恢复标签、草稿和历史版本。

## 快速开始

### 下载桌面应用

[下载 Folio v0.5.0-beta.15 · macOS Apple Silicon](https://github.com/MemTensor/Folio/releases/download/v0.5.0-beta.15/Folio-0.5.0-beta.15-arm64-mac.zip)

解压后将 `Folio.app` 放入应用程序文件夹。当前版本为 **v0.5.0-beta.15**，也可按下方步骤本地构建。各版本的功能与限制见 [更新记录](CHANGELOG.md)。

安装包尚未签名和公证。源码仓库为 [MemTensor/Folio](https://github.com/MemTensor/Folio)，当前为私有且未授予开源许可。安装包与源码均从该仓库获取，下载需要相应访问权限。

### 应用内更新

从 Folio 菜单、写作设置或命令面板打开“检查更新”，查看版本说明并下载。下载完成后点击“保留草稿并重启更新”，即可在保留文档草稿后安装新版。私有测试版会复用本机 GitHub CLI 登录；账号需有仓库访问权限。详细步骤与限制见 [更新说明](docs/更新说明.md)。

此入口从 v0.5.0-beta.2 起提供。首次安装或仍在使用较早版本时，请通过上方下载或源码构建安装。

### 从源码运行

需要 **Node.js 22.13+** 和 npm。

```bash
git clone https://github.com/MemTensor/Folio.git
cd Folio
npm ci
node node_modules/electron/install.js
npm run desktop
```

启动后，打开一个 Markdown 文件或项目文件夹即可开始：

1. **阅读与编辑**：点击段落写作，或切换到源码、阅读模式。
2. **查找文档**：从首页打开最近文档，或在项目左侧按名称筛选；点击项目名称可进入文档库进行跨项目搜索。
3. **继续协作**：让 Agent 编辑同一份文件，在“改动审阅”中查看更新。

基础文档功能可离线使用，无需模型账号或 API Key。

构建独立桌面应用、配置导出工具及更多操作，见 [使用指南](docs/使用指南.md) 和 [开发指南](docs/开发指南.md)。

### 语言与 iCloud

界面支持简体中文和英语，在首次引导或写作设置中切换。可按项目开启 iCloud Drive 同步，仅包含 Markdown 与引用的本地图片／附件，单文件小于 100 MB。原项目目录保留，双侧修改发生冲突时由你选择；另一台 Mac 可连接已有 iCloud 项目。详见 [项目与同步](docs/项目与同步.md)。

## 与 AI Agent 协作

文档右上角的 **Agent** 面板可连接 ChatGPT 订阅或 OpenAI 兼容 API，围绕当前文档或所选文字提问、润色和检查，无需切换操作方式。可按模型选择思考强度，按需查看文档的可见渲染效果；回复或修改定位有误时，先反馈给模型自动修正。修改建议先显示原文对比，可选择接受并撤销；可主动添加参考文档，或让 Agent 按需查找同项目文档；读取来源可以展开和打开。后台会话保持连接，切换面板即时显示账号和模型；文档建议由轻量模型根据内容生成并缓存。接入方式集中在 Agent 设置中，操作见 [Agent 文档助手](docs/Agent文档助手.md)。

Folio 提供独立 CLI，以及适用于 Codex、Claude Code 的 skill/plugin。Agent 可以查找文档、读取原文、获取上下文并提交有版本检查的修改，桌面窗口关闭后仍可使用。

```bash
# 在项目中查找文档
./bin/folio search "公式" --workspace ./examples --json

# 读取正文、版本和章节位置
./bin/folio read "公式、图与表.md" --workspace ./examples --json

# 将需要长期查找的项目加入文档库
./bin/folio library add ./examples --json

# 在已登记的项目间查找
./bin/folio library search "实验" --json
```

`read`、`search` 等指定工作区的 CLI 操作不会自动将项目加入文档库。仅在需要长期跨项目检索时使用 `library add`；移除登记使用 `library remove PROJECT_ID`。

Agent 写入时提供读取到的文件版本。如果期间发生了修改，CLI 会提示重新读取，避免覆盖后续工作。skill 负责指导 Agent 如何检索、编辑和处理冲突。

接入方式与完整协议见 [Agent 接入指南](integrations/README.md)。

### 可选的项目记忆

Folio 可以连接 MemOS，让 Agent 在后续任务中更容易找到相关文档。用户只需在 **写作设置 → AI 记忆设置** 中填写自己的 API Key，并选择或创建当前项目的知识库。

启用相应 skill 后，Agent 负责整理和检索文档线索。默认上传用于定位原文的导航信息；完整 Markdown 仍在本机，阅读、编辑与本地搜索独立可用。

## 发布到钉钉（实验性）

点击文档右上角的发布按钮，可将当前 Markdown 转为钉钉在线文档。Folio 使用本机已登录的 `dws` CLI，记住文档对应关系，并在后续同步时检查钉钉版本。链接可复制或按姓名发送给同事。

当前源码版将公式和 Mermaid 图表以图片呈现，正文和表格可在钉钉编辑；本地原文继续保留可编辑源码。发布结果不明确或云端已有修改时，可核对已有文档、恢复关联或保留云端内容后解除关联。接入方法与限制见 [钉钉集成说明](docs/钉钉集成说明.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/使用指南.md) | 文档管理、公式与图表、改动审阅、导出、快捷键 |
| [Agent 接入指南](integrations/README.md) | CLI、Codex／Claude Code skill 与 plugin |
| [开发指南](docs/开发指南.md) | 环境准备、项目结构、检查与构建 |
| [架构与数据边界](docs/架构与数据边界.md) | 代码入口、数据流与 Agent 工具权限 |
| [项目与同步](docs/项目与同步.md) | 项目首页、自动发现、iCloud 与语言设置 |
| [更新说明](docs/更新说明.md) | 检查版本、下载、保留草稿重启及私有测试版访问 |
| [第三方组件](THIRD_PARTY_NOTICES.md) | 使用的开源项目与许可证 |

## 路线图

- **更连贯的文档工作区**：多窗口、跨窗口标签操作与跨会话阅读位置恢复。
- **更强的文档关联**：跨文件引用、反向链接和相关文档导航。
- **更方便的桌面分发**：签名安装包、公证与更多平台支持。

## 参与开发

有仓库访问权限的协作者可通过 Issue 描述使用场景或问题，提交代码前请运行 `npm run check`。涉及公式、图表或文件协作时，请附上可以复现问题的最小 Markdown 示例。

开发约定和验证方法见 [参与开发](CONTRIBUTING.md) 与 [开发指南](docs/开发指南.md)。安全问题见 [安全说明](SECURITY.md)。
