#!/usr/bin/env bash
# Publish the tap so anyone can `brew install verchol/opthub/opthub`.
#
#   ./packaging/publish-tap.sh --yes [version]
#
# This is deliberately opt-in. Running it makes a PUBLIC GitHub repo and uploads
# the CLI tarball as a release asset, which publishes the harness source — 100
# files including optimize.mjs, the lever catalog and the Kong templates. It does
# not publish .env, results/ or any transcript (make-dist.sh excludes them, and
# refuses to build if a credential-shaped string is in the stage).
#
# Until this is run, the tap is local: it exists only on this machine, and
# `brew install` works here and nowhere else.
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"   # $0 goes stale after the cd
cd "$(dirname "$0")/.."

[[ "${1:-}" == "--yes" ]] || { sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'; exit 1; }
shift

VERSION="${1:-$(node -p "require('./package.json').version")}"
OWNER="$(gh api user --jq .login)"
REPO="homebrew-opthub"
TARBALL="packaging/dist/opthub-${VERSION}.tar.gz"
TAG="v${VERSION}"

[[ -f "$TARBALL" ]] || { echo "no $TARBALL — run ./packaging/make-dist.sh first" >&2; exit 1; }

# 1. the tap repo, created public on first run
gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1 \
  || gh repo create "${OWNER}/${REPO}" --public \
       --description "Homebrew tap for opthub — cheaper coding-agent configurations, measured"

WORK="$(mktemp -d)"
git clone -q "https://github.com/${OWNER}/${REPO}.git" "$WORK" 2>/dev/null \
  || { git init -q "$WORK"; git -C "$WORK" remote add origin "https://github.com/${OWNER}/${REPO}.git"; }

# 2. the release that hosts the tarball
gh release view "$TAG" --repo "${OWNER}/${REPO}" >/dev/null 2>&1 \
  && gh release upload "$TAG" "$TARBALL" --repo "${OWNER}/${REPO}" --clobber \
  || gh release create "$TAG" "$TARBALL" --repo "${OWNER}/${REPO}" \
       --title "opthub ${VERSION}" --notes "CLI tarball for the Homebrew formula."

URL="https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/opthub-${VERSION}.tar.gz"
SHA="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"

# 3. the formula, pointed at the public URL instead of file://
mkdir -p "$WORK/Formula"
/usr/bin/sed \
  -e "s|^  url .*|  url \"${URL}\"|" \
  -e "s|^  sha256 .*|  sha256 \"${SHA}\"|" \
  packaging/homebrew/Formula/opthub.rb > "$WORK/Formula/opthub.rb"

cat > "$WORK/README.md" <<MD
# homebrew-opthub

\`\`\`sh
brew tap ${OWNER}/opthub
brew install opthub
\`\`\`

**opthub** reads the transcripts Claude Code already keeps, works out where the
money went, proposes a cheaper configuration, then re-runs a real session under
it in cloud sandboxes and grades the result blind. A configuration that is
cheaper and worse is reported as cheaper and worse.

Reading your own sessions needs no credentials:

\`\`\`sh
opt sessions      # every session on this machine, by cost
opt hub start     # the Optimization Hub in a browser
opt watch --live  # live and open sessions, redrawn in place
\`\`\`

Running an experiment boots sandboxes and costs money — see \`opt secrets\`.
MD

git -C "$WORK" add -A
git -C "$WORK" -c user.email="$(gh api user --jq '.email // "noreply@github.com"')" \
              -c user.name="${OWNER}" commit -qm "opthub ${VERSION}" || echo "nothing to commit"
git -C "$WORK" branch -M main
git -C "$WORK" push -q -u origin main
rm -rf "$WORK"

echo "published: brew tap ${OWNER}/opthub && brew install opthub"
echo "formula url: ${URL}"
