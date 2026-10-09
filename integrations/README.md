# Folio Agent 接入

Folio 的主体是文档应用，统一阅读、查找、管理和编辑人及模型持续产生的文档。CLI／skill 为 Agent 提供入口，MemOS 只是可选记忆能力。此目录不修改 harness 内部代码，也不要求每轮对话调用记忆。

本文对应源码开发版 v0.5.0-beta.14；已安装发行版的可用命令以该版本 `--help` 为准。

## CLI

源码目录：`bin/folio`。

安装应用后：`/Applications/Folio.app/Contents/Resources/bin/folio`。

Agent 可直接调用绝对路径；是否加入 PATH 由用户决定。应用自带 CLI 运行时，桌面窗口关闭后仍可读写文档、组装上下文和操作已授权的云知识。

`read`、`search`、`context` 等操作必须指定项目 `--workspace`，但不会自动登记文档库。需要长期跨项目检索时，显式管理登记：

```bash
folio library add /path/to/project --json
folio library list --json
folio library search '实验' --limit 100 --offset 0 --json
folio library remove PROJECT_ID --json
```

移除登记只影响文档库和派生搜索数据，原文件保留。`PROJECT_ID` 来自 `library list` 的项目列表。具体项目搜索可加 `--project-id`。

## Skill / plugin

`plugins/folio` 同时包含 Codex 和 Claude Code 的插件清单，共用一份 `skills/folio/SKILL.md`。没有自动回调 hooks，没有“每轮必须上传”的要求，也不包含 API Key。

Claude Code 可显式加载这个本地插件：

```bash
claude --plugin-dir /absolute/path/to/plugins/folio
```

Codex 可通过其支持的插件分发渠道安装此清单，或独立安装 `skills/folio` 这个 skill。插件目录本身不会自动注册 marketplace 或更改 Codex／Claude Code 配置。

若只想让任意 Agent 立即使用，可直接给它可执行文件路径和 `skills/folio/SKILL.md`。所有必要行为均由独立 CLI 实现，不依赖安装方式。

## 人的使用路径

人正常打开项目、查找和编辑文档。点击当前文件夹名称可查看最近文档并跨项目搜索，这些功能不依赖 MemOS。

可选记忆只在“设置 → AI 记忆设置”中配置 Key，选择或新建当前项目的知识库。用户不维护导航卡、标签、发布记录、索引或处理队列。

Agent 在任务开始调用 `folio task begin`，按当前项目检索并读取原文；结束时调用 `folio task end`，自行整理相关、可复用文档的导航描述。不同项目的默认知识库隔离，历史问题显式读取旧 revision。临时输出和完整聊天不会一律进入记忆。skill 是否被加载取决于 harness 的配置，第三方应用不假定能控制其内部生命周期。

## 可选云端操作与恢复

MemOS 默认接收由 Agent 选择的导航信息，帮助后续任务找到原文。完整内容上传需要单独选择。上传结果不明确时，Agent 先读取现有发布记录并核对远端对象；有完整文件 ID 时可关联已有上传，确认未创建后才允许另行重试。人继续在应用中读写文档，无需维护发布记录或队列。

钉钉发布针对同事可阅读、编辑的在线文档。上传、更新与发送链接均须在用户授权范围内进行；文档检索或启用记忆不代表同意钉钉发布。结果不明确时核对现有文档，云端已有改动时先保留修改。恢复命令、Mermaid 图片格式和退出码见 [CLI 协议](plugins/folio/skills/folio/references/protocol.md)。

## 本地验证

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/folio
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/folio/skills/folio
claude plugin validate plugins/folio
```
