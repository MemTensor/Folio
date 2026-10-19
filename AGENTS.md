# Folio development

Folio is a local Markdown workspace for people and Agents. See `README.md`,
`docs/开发指南.md` and `docs/架构与数据边界.md` before changing product boundaries.

- Keep normal Markdown files as the source. Preserve encodings, relative assets,
  formulas and table structure.
- Protect unsaved human edits. Model proposals go through review, confirmation
  and a version backup; file writes check the version read by the caller.
- Return invalid edit diagnostics to the model for bounded repair. Do not ask the
  user to repair the model's response format.
- Keep Agent tools limited to bounded document lookup/read and explicit visible
  previews. Do not add shell execution, direct writes or unrestricted browsing.
- Keep local reading, editing and search usable without cloud accounts. New
  background work must have explicit scope, limits and cancellation.
- Update both UI languages. Use Agent in product copy; document actual behavior
  without implementation history or comparisons to other editors.
- Use generated fixtures and isolated `FOLIO_DATA_DIR` values. Do not read real
  user documents or call live accounts for routine tests.
- Keep credentials, app state, local `.claude/` launch configuration and build
  output out of Git. Distributed plugins belong in `integrations/`.
- Run relevant tests and `npm run check`. For packaging, worker or release changes,
  also run `npm run pack` and inspect the packaged result.
- Folio is licensed under Apache-2.0 with NOTICE attribution to MemTensor and
  Zehao Lin. Preserve these files in application, plugin and skill distributions.
  The repository remains private. Do not change its visibility, license terms or
  published assets without explicit user authorization.
