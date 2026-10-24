#!/usr/bin/env bash
# Assemble a self-contained build context for the read-only hub.
#
# Nothing is copied wholesale: docs/ holds material that has no business on a
# public host (an investor memo, for one), so the pages that ship are listed
# here by name. Symlinks are dereferenced (-L) because the real files live in
# the other repo.
set -euo pipefail
cd "$(dirname "$0")"
SRC=..
OUT=build

rm -rf "$OUT"
mkdir -p "$OUT/lib" "$OUT/docs" "$OUT/config"

# 1. the server, the module that serves the page, and the page itself — built here,
#    so the image needs no npm and no node_modules
cp "$SRC/hub-demo.mjs" "$OUT/"
cp "$SRC/lib/web-dist.mjs" "$OUT/lib/"
(cd "$SRC" && npm run build:web >/dev/null)
mkdir -p "$OUT/web"
cp -R "$SRC/web/dist" "$OUT/web/dist"

# 2. the frozen API surface, rebuilt from the live store
node "$SRC/tools/hub-snapshot.mjs" "$OUT/snapshot"

# 3. the documents worth showing, by name
for f in anatomy.html experiment-loop.html experiment-loop-short.html; do
  cp -L "$SRC/docs/$f" "$OUT/docs/$f"
done

# 4. the lever catalog, which the Catalog view cites as its source
cp "$SRC/config/optimizations.json" "$OUT/config/"

cp Dockerfile "$OUT/"
printf '\nbuild context: %s\n' "$(du -sh "$OUT" | cut -f1)"
find "$OUT" -maxdepth 2 -type f | sed 's|^|  |' | head -20
