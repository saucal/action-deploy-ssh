#!/bin/bash
# Self-check for consistency-diff.sh: no context lines, long lines summarized.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q . && git config user.email t@t && git config user.name t
# The runner leaves autocrlf off; pin it so a local 'input' setting can't normalize
# the CRLF fixture away and silently pass the whitespace-only assertions.
git config core.autocrlf false

big="$(head -c 40000 /dev/zero | tr '\0' 'x')"

# min.js: one huge minified line + surrounding short lines that must NOT appear as context.
# Committed twice so HEAD~1 (the previously deployed build) differs from HEAD.
{ echo "keep-1"; printf 'var a=0;%s\n' "$big"; echo "keep-2"; } > min.js
echo "untouched" > plain.txt
echo "gone" > removed.txt
printf 'a\nb\nc\n' > crlf.php
printf 'if (x) {\n  y();\n}\n' > reindent.php
git add -A && git commit -qm build-previous
{ echo "keep-1"; printf 'var a=1;%s\n' "$big"; echo "keep-2"; } > min.js
git add -A && git commit -qm build-current

# Simulate the target state reverse-synced over the build.
{ echo "keep-1"; printf 'var a=2;%s\n' "$big"; echo "keep-2"; } > min.js
rm removed.txt
echo "new" > added.txt
printf 'a\r\nb\r\nc\r\n' > crlf.php
printf 'if (x) {\n\t\ty();\n}\n' > reindent.php

out="$(PATH_DIR="$tmp" bash "$here/consistency-diff.sh" HEAD)"
echo "$out"

grep -q '^@@' <<< "$out" || { echo "FAIL: no hunk header"; exit 1; }
if grep -q '^ keep-' <<< "$out"; then echo "FAIL: context lines present"; exit 1; fi
grep -q 'KB, truncated\]$' <<< "$out" || { echo "FAIL: long line not summarized"; exit 1; }
[ "$(awk '{ if (length($0) > 400) c++ } END { print c+0 }' <<< "$out")" = 0 ] || { echo "FAIL: long line leaked"; exit 1; }
grep -q '^diff --git --simple WS crlf.php$' <<< "$out" || { echo "FAIL: missing WS crlf.php"; exit 1; }
grep -q '^diff --git --simple WS reindent.php$' <<< "$out" || { echo "FAIL: missing WS reindent.php"; exit 1; }
if grep -q '^-a' <<< "$out"; then echo "FAIL: whitespace-only body not collapsed"; exit 1; fi
grep -q '^diff --git --simple A removed.txt$' <<< "$out" || { echo "FAIL: missing D"; exit 1; }
grep -q '^diff --git --simple D added.txt$' <<< "$out" || { echo "FAIL: missing A"; exit 1; }
if grep -q 'plain.txt' <<< "$out"; then echo "FAIL: unchanged file listed"; exit 1; fi
# Both artifacts run through the same -R frame, so '+' is the build side and '-' the
# target in each. Only which build is checked; HEAD~1 must label a=0 (the previously
# deployed build) as "build", not as "target".
prev="$(PATH_DIR="$tmp" bash "$here/consistency-diff.sh" HEAD~1)"
grep -q '^+var a=0;.*\[build line, .* truncated\]$' <<< "$prev" || { echo "FAIL: HEAD~1 build side mislabeled"; exit 1; }
grep -q '^-var a=2;.*\[target line, .* truncated\]$' <<< "$prev" || { echo "FAIL: HEAD~1 target side mislabeled"; exit 1; }
grep -q '^+var a=1;.*\[build line, .* truncated\]$' <<< "$out" || { echo "FAIL: HEAD build side mislabeled"; exit 1; }
grep -q '^-var a=2;.*\[target line, .* truncated\]$' <<< "$out" || { echo "FAIL: HEAD target side mislabeled"; exit 1; }
if grep -q '^ keep-' <<< "$prev"; then echo "FAIL: HEAD~1 kept context lines"; exit 1; fi

echo "OK"
