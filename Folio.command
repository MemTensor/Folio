#!/bin/sh
set -eu
folio_project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$folio_project_dir/bin/folio" open "$@"
