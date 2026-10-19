// Minimum runtime files required by both publication and installation.
const BUNDLE_FILES = Object.freeze([
  'Contents/Info.plist',
  'Contents/MacOS/Folio',
  'Contents/Resources/app.asar',
  'Contents/Resources/bin/folio',
  'Contents/Resources/cli/folio.cjs',
  'Contents/Resources/cli/index-worker.cjs',
  'Contents/Resources/cli/resvg.wasm',
  'Contents/Resources/updater/folio-update-helper',
  'Contents/Resources/updater/build-info.json',
]);
module.exports = { BUNDLE_FILES };
