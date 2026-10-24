#!/usr/bin/env bash
# Take the token from the clipboard, strip any line-wrap whitespace, validate,
# and write it into .env. Never echoes the value.
set -euo pipefail
cd "$(dirname "$0")"

tok="$(pbpaste | tr -d '[:space:]')"

if [ -z "$tok" ]; then
  echo "clipboard is empty — copy the sk-ant-oat01-… token first" >&2; exit 1
fi
case "$tok" in
  sk-ant-oat01-*) ;;
  sk-ant-api03-*) echo "that is a console API key, not a license token. run: claude setup-token" >&2; exit 1 ;;
  *) echo "unexpected prefix '${tok:0:14}…' — expected sk-ant-oat01-" >&2; exit 1 ;;
esac

touch .env
# drop any existing line, append the new one
grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' .env > .env.tmp 2>/dev/null || true
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$tok" >> .env.tmp
mv .env.tmp .env
chmod 600 .env

echo "written to .env — length ${#tok} (payload $(( ${#tok} - 13 )) chars), prefix ${tok:0:13}"
echo "previous attempt was length 64 (payload 51). If this one is also 64, the copy is complete and the token is genuinely being rejected."
