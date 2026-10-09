#!/bin/sh
set -eu
folio_bundle=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export FOLIO_APP_BUNDLE="$folio_bundle"
export ELECTRON_RUN_AS_NODE=1
exec "$folio_bundle/Contents/MacOS/Folio" "$folio_bundle/Contents/Resources/cli/folio.cjs" "$@"
