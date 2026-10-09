// Update bundles are physical directories. Electron's patched fs presents
// app.asar as a virtual directory, which must not affect bundle verification.
module.exports = process.versions.electron ? require('original-fs') : require('node:fs');
