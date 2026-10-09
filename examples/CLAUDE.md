# Writing workspace

Use the Markdown files in this folder directly. Keep edits small and preserve the author's structure and voice. Read AGENTS.md for the collaboration conventions.

When the Folio CLI is available, prefer it for reading and writing here: `folio read FILE --workspace DIR --json` returns the content together with the revision hash, and `folio patch`/`folio write` take that hash through `--expect` so an edit is refused rather than silently overwriting work saved since the read. Folio also records who contributed the change.

Editing the files directly still works, and Folio picks the change up through ordinary filesystem observation. It simply has no revision check, so a concurrent save by the person writing alongside you can be lost.
