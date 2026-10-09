# Third-party components

Folio is an independent implementation.

The application uses the open-source components below. Production builds collect license and notice files into `third-party-licenses/`, included in the application archive. Its `index.json` records installed package names, versions, declared licenses and copied notice paths. The collection includes build dependencies so that notices for frontend code bundled into `dist/` remain available even when those packages are absent from the runtime dependency tree.

This table is a summary; consult the bundled texts and upstream packages for their terms. The component licenses do not establish a license for Folio itself.

| Component | License | Purpose |
| --- | --- | --- |
| Electron | MIT | Desktop runtime |
| React | MIT | Application UI |
| CodeMirror and Lezer | MIT | Source-preserving editor |
| markdown-it and plugins | MIT | Markdown parsing |
| DOMPurify | Apache-2.0 OR MPL-2.0 | Markup sanitization |
| MathJax | Apache-2.0 | Math layout and SVG output |
| KaTeX | MIT | Inline math rendering support |
| MathJax New Computer Modern fonts | Apache-2.0 | Math glyphs |
| Mermaid | MIT | Diagrams |
| Phosphor Icons | MIT | UI icons and application icon |
| highlight.js | BSD-3-Clause | Code highlighting |
| jsdiff | BSD-3-Clause | Text diffs and merge support |
| chokidar | MIT | Filesystem observation |
| image-size | MIT | Image dimensions |
| yauzl | MIT | Validating and extracting update archives |
| [resvg-wasm](https://github.com/yisibl/resvg-js) | MPL-2.0 | Offline formula image rendering |

Pandoc is a separately installed optional tool; Folio invokes the existing local executable for Word export.
