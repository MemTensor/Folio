# CLI contract

This reference describes source version v0.5.0-beta.13. Check the installed CLI's `--help` before using newer commands with an older application.

Every command accepts `--json`. stdout contains one `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message", "details"? } }` object. Inspect the returned state: command success does not imply completed cloud ingestion. `--help`, `help` and `-h` display help; opening a window requires explicit `open [path]`.

| Exit | Meaning | Response |
| --- | --- | --- |
| 0 | Command completed | Verify the artifact, state and any warnings |
| 1 | Unexpected local failure | Inspect `error.code`; preserve the original file and draft |
| 2 | Invalid command or input | Correct the command using `--help` |
| 3 | Revision conflict / busy | Re-read and reassess; preserve concurrent changes |
| 4 | Configuration, authentication or state recovery needed | Inspect the error; use the relevant local setup or recovery path |
| 5 | Cloud request or processing failure | Inspect existing remote records before retrying a mutation |
| 6 | Uncertain cloud mutation | Verify its outcome and recover the existing record |

## Local documents and library

```bash
folio doctor --json
folio read notes.md --workspace /path/to/project --json
folio search '实验条件' --workspace /path/to/project --json
folio context '训练目标' --workspace /path/to/project --max-chars 12000 --json
folio provenance notes.md --workspace /path/to/project --json
folio history notes.md --workspace /path/to/project --json
folio read notes.md --revision REVISION_HASH --workspace /path/to/project --json
folio library add /path/to/project --json
folio library list --json
folio library search '实验' --project-id PROJECT_ID --limit 100 --offset 0 --json
folio library remove PROJECT_ID --json
```

Scoped `read`, `search`, `context` and edit commands require `--workspace` but do not register it in the library. They validate that the directory exists and confine document paths to it; they do not apply the library's broad-directory admission restrictions. Choose a specific project directory to keep the operation scoped to the task.

`library add` is explicit registration and rejects the filesystem root, the home directory and its ancestors, and most of `~/Library`. `library remove` removes registration and derived search data, preserving source files.

`read`, `write` and `patch` accept Markdown and text documents only (`.md`, `.markdown`, `.mdown`, `.mkd`, `.txt`, `.mdx`, `.qmd`, `.rmd`). A project root is usually a whole repository, and Folio does not read the `.env`, key and configuration files sitting beside the documents. Use the harness's own file tools for those, subject to whatever the user has authorised.

`--expect` is a hash from a recent `read`, never a guessed token or a force flag. New documents use `--expect new`. Use `write --input FILE|-` or `patch --patch JSON_FILE`; do not interpolate document contents into shell code. Patch input is an array of `{ "find": "unique exact text", "replace": "replacement" }` objects.

A successful write may return `metadataWarning` or `warnings`. The source has already been saved; re-read it and report the associated-record failure instead of repeating the write. `ENCODING_BUDGET` means the mixed-line-ending edit was stopped before writing. Preserve the draft and use smaller edits or separately authorized normalization.

Historical reads return only retained snapshots. Never substitute current text for an unavailable requested revision. History uses a soft total budget; necessary recovery copies can remain above the budget. The filesystem may also be edited by tools outside Folio's process lock, so use actual post-write evidence.

Local state lives in Folio's application data. `FOLIO_DATA_DIR` selects an isolated profile for tests. Do not delete identity or publication state to get around an error: it can create new identities or duplicate remote objects. `STATE_RECOVERY_REQUIRED` preserves the damaged state for recovery. The installed application's bundled CLI works without a separate Node installation or active GUI.

## Task and project boundaries

`task begin QUERY --workspace DIR --json` returns a task ID, start time and optional project-scoped memory candidates. An unbound project does not inherit a default collection. Disabled/unavailable memory does not stop local work.

`task end --task-id ID --manifest FILE --workspace DIR --json` receives only relevant reusable documents selected by the Agent. It uploads navigation for the original project binding, deduplicates repeated versions and checks pending projections. Inspect each returned result and any deferred operations, even if the overall task command succeeded. Ready replacement navigation permits retirement of older owned navigation; historical source snapshots remain local. People do not maintain these internal objects.

`memos bind --workspace DIR --collection ID` and `memos unbind --workspace DIR` are explicit setup operations. Cross-project search does not authorize mixing project-specific memories or changing cloud bindings.

```bash
folio memos status --workspace /path/to/project --json
folio discover '训练目标' --workspace /path/to/project --json
folio resolve DOCUMENT_ID --workspace /path/to/project --json
folio read --document-id DOCUMENT_ID --workspace /path/to/project --json
```

Cloud discovery returns navigation hints. `source.association` distinguishes provider file metadata from a known navigation anchor. Neither establishes factual correctness: fetch and read the source before answering. Ambiguous or absent locators remain unassociated. `source.revision` is the indexed version; `source.currentRevision` is the current local version.

People configure their API Key and project knowledge base in Folio. Managed environments can use `MEMOS_API_KEY` or a permission-restricted `MEMOS_API_KEY_FILE`. Advanced CLI configuration accepts `memos configure --key-file FILE --base-url HTTPS_URL`; changing a destination can expose its credential to that destination and requires the intended configuration to be known. Do not put secrets in chat, command arguments, plugins or logs.

## Cloud outcome recovery

Start with the existing publication journal:

```bash
folio memos publications --workspace /path/to/project --json
folio memos refresh PUBLICATION_ID --workspace /path/to/project --json
```

If a mutation is uncertain and no file IDs were returned, refreshing cannot determine whether an upload exists. Check the remote service using available authorized tools. Use only observed file IDs for the correct knowledge base and source package; a local timeout is not evidence that nothing was created.

After verifying an existing upload, associate its complete file set:

```bash
folio memos resolve PUBLICATION_ID --workspace /path/to/project \
  --outcome attach --file-ids FILE_ID_1,FILE_ID_2 --note 'How the files were verified' --yes --json
```

The CLI reads the supplied IDs back and checks their count and any returned knowledge-base identity. The operator remains responsible for verifying that those files belong to this source package. Use one ID for a one-file navigation upload; include every file for a package with assets.

If the service has been checked and no upload was created:

```bash
folio memos resolve PUBLICATION_ID --workspace /path/to/project \
  --outcome not-created --note 'How absence was verified' --yes --json
```

This records the resolution and allows a later explicit retry; it does not upload anything. It is rejected when file IDs already exist. Known remote files that fail indexing are retained and not blindly uploaded again. Keep the original publication IDs and report unresolved service problems while continuing local document work.

## DingTalk publishing and recovery

DingTalk publishes editable online documents through the local `dws` CLI. Text and tables remain editable; formulas and Mermaid diagrams are images, with editable sources retained locally. Publishing and link delivery must be within the user's request; memory setup alone does not authorize either operation.

```bash
folio dingtalk status notes.md --workspace /path/to/project --json
folio dingtalk plan notes.md --workspace /path/to/project --json
folio dingtalk sync --plan PLAN_ID --workspace /path/to/project --yes --json
folio dingtalk check notes.md --workspace /path/to/project --json
```

Inspect the plan's account, target, action and warnings before using authorized `sync --yes`. Plans expire after ten minutes and are invalidated by relevant source, asset, binding or remote changes. The core checks the remote revision again at execution. Formula/diagram rendering still needs visual checking in the final online document.

For Mermaid, the desktop produces PNGs. A CLI caller can supply `--diagram-file JSON_FILE --expect DOCUMENT_HASH`. The JSON is an ordered array of `{ "source": "exact fence body including its final newline", "png": "data:image/png;base64,..." }`. Include every Mermaid fence, including fences with attributes. Generate images from the same document revision given by `--expect`; the CLI rejects mismatched source blocks, counts and revisions.

Uncertain writes keep their binding. Read the current recovery information; for an unknown creation ID, supply the candidate observed in DingTalk:

```bash
folio dingtalk recovery notes.md --workspace /path/to/project --json
folio dingtalk recovery notes.md --workspace /path/to/project --node-id NODE_ID --json
```

Recovery uses `binding.planId` as `--expected-plan-id`; `remote.revision` becomes `--remote-revision`. Do not substitute the document hash or a new publish plan ID.

| `recover --action` | Required evidence and effect |
| --- | --- |
| `attach` | Provide a verified candidate `--node-id` and `--remote-revision`; its content must match the uncertain submission. Restores the binding without creating a document. |
| `adopt-remote` | Inspect the known remote document and provide its revision. Records that version as a new baseline, preserving cloud content. A later update requires reviewing both versions and separately confirming replacement by the local text. |
| `detach` | Confirm the known association should end. Keeps the remote document and archives the local binding; a subsequent publish creates a new document. |
| `confirm-not-created` | Available only for an uncertain creation without a node ID, after verifying no document was created. Allows a later explicit publish. |

Every recovery command also requires `--workspace`, `--expected-plan-id` and `--yes`. It does not write or delete the remote document. Do not use detachment or an invented ID to bypass an uncertain result. When `plan.requiresReview` is true, present `remotePreview`, `localPreview` and the effect of replacement before proceeding; reconcile desired colleague changes into local Markdown first.

For uncertain link delivery:

```bash
folio dingtalk share-status notes.md --workspace /path/to/project --to 'A,B' --json
folio dingtalk share-resolve notes.md --workspace /path/to/project --to 'A,B' \
  --outcome sent --expected-package-hash PACKAGE_HASH --yes --json
```

Use the package hash returned by `share-status`. `sent` means every recipient's delivery was verified. `not-sent` means none received it and allows a separately confirmed resend. Partial delivery needs recipient-by-recipient reconciliation; do not resend the full list by guessing. These commands record verified outcomes without sending messages. Link delivery does not alter document permissions.
