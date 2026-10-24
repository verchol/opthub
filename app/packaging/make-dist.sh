#!/usr/bin/env bash
# Build the distributable tarball for the opthub CLI, and point the formula at it.
#
#   ./packaging/make-dist.sh [version]
#
# What does NOT go in the tarball is the point of this script: .env (1Password
# references and, historically, a live key), results/ and exports/ (real run
# output from real sessions), local-sessions/, node_modules/ and the deploy
# build. Everything excluded is listed below rather than hidden in a .npmignore,
# because shipping one of them by accident is the failure that matters.
set -euo pipefail
cd "$(dirname "$0")/../.."   # the repo root: the tarball keeps its layout (app/, sandbox/, docs/atlas)

VERSION="${1:-$(node -p "require('./package.json').version")}"
DIST="app/packaging/dist"
NAME="opthub-${VERSION}"
STAGE="$(mktemp -d)/${NAME}"

mkdir -p "$STAGE" "$DIST"

# The hub page is a React app (app/web/); the tarball ships it built, not its toolchain.
npm run build:web >/dev/null

# The CLI, its modules, and the assets it reads at runtime.
tar -cf - \
  --exclude='.env' --exclude='.env.*' \
  --exclude='node_modules' \
  --exclude='results' --exclude='exports' --exclude='replays' --exclude='tuning' \
  --exclude='local-sessions' \
  --exclude='analysis' --exclude='audit' --exclude='sandbox-out' --exclude='otel' --exclude='claude-profile' \
  --exclude='packaging' --exclude='deploy' --exclude='app/web' \
  --exclude='.git' --exclude='.DS_Store' \
  --exclude='*.log' --exclude='__pycache__' \
  package.json package-lock.json opt README.md \
  app sandbox docs/atlas docs/preview/session-graph tools/*.py 2>/dev/null \
  | tar -xf - -C "$STAGE"
# the built page only, not its toolchain
mkdir -p "$STAGE/app/web" && cp -R app/web/dist "$STAGE/app/web/dist"

# Belt and braces: fail loudly rather than ship a credential.
if find "$STAGE" -name '.env*' -o -name '*.pem' | grep -q .; then
  echo "refusing to package: credential-shaped file in the stage" >&2; exit 1
fi
if grep -rlE '(AKIA[0-9A-Z]{12,}|sk-ant-[A-Za-z0-9-]{20,})' "$STAGE" >/dev/null 2>&1; then
  echo "refusing to package: credential-shaped string in the stage" >&2; exit 1
fi

TARBALL="${DIST}/${NAME}.tar.gz"
tar -czf "$TARBALL" -C "$(dirname "$STAGE")" "$NAME"
rm -rf "$(dirname "$STAGE")"

SHA="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
SIZE="$(du -h "$TARBALL" | cut -f1)"

# Rewrite the formula's url and sha256 in place.
FORMULA="app/packaging/homebrew/Formula/opthub.rb"
ABS="$(cd "$DIST" && pwd)/${NAME}.tar.gz"
/usr/bin/sed -i '' \
  -e "s|^  url .*|  url \"file://${ABS}\"|" \
  -e "s|^  sha256 .*|  sha256 \"${SHA}\"|" \
  -e "s|^  version .*|  version \"${VERSION}\"|" \
  "$FORMULA"

echo "built   ${TARBALL}  (${SIZE})"
echo "sha256  ${SHA}"
echo "formula ${FORMULA} updated"
