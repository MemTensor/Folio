# Third-party components

Folio is an independent implementation.

The application uses the open-source components below. Production builds collect license and notice files into `third-party-licenses/`, included in the application archive. Its `index.json` records installed package names, versions, declared licenses and copied notice paths. The collection includes build dependencies so that notices for frontend code bundled into `dist/` remain available even when those packages are absent from the runtime dependency tree.

This table is a summary; consult the bundled texts and upstream packages for their terms. Folio's own code is covered by the root LICENSE and NOTICE; third-party components keep their separate terms.

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

## Collection limits

The generated inventory records package declarations and the license files present in each installed npm package. An empty `files` array means that the package did not supply a standalone root-level license or notice file; it does not establish that no attribution is required. This occurs, for example, in the currently installed MathJax font packages and `@resvg/resvg-wasm`. These upstream notices and any applicable source-availability requirements need separate verification before further distribution. Adding Folio's own Apache-2.0 license does not complete that dependency review.
