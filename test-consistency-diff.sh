#!/bin/bash
# Self-check for consistency-diff.sh: no context lines, long lines summarized or
# collapsed, whitespace-only files collapsed, and build/target labels correct on
# both the HEAD and HEAD~1 frames.
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

write_fixtures() { # $1 = generation marker
  # min.js: every changed line is minified -> the whole file should collapse to LL.
  { echo "keep-1"; printf 'var a=%s;%s\n' "$1" "$big"; echo "keep-2"; } > min.js
  # mixed.js: one short changed line next to a minified one -> the diff must survive,
  # with only the long line truncated. ctx-* must never print (they are -U0 context).
  { echo "ctx-top"; echo "short-$1"; printf 'var m=%s;%s\n' "$1" "$big"; echo "ctx-bottom"; } > mixed.js
}

write_fixtures 0
echo "untouched" > plain.txt
echo "gone" > removed.txt
printf 'a\nb\nc\n' > crlf.php
printf 'if (x) {\n  y();\n}\n' > reindent.php
git add -A && git commit -qm build-previous

write_fixtures 1
git add -A && git commit -qm build-current

# Simulate the target state reverse-synced over the build.
write_fixtures 2
rm removed.txt
echo "new" > added.txt
printf 'a\r\nb\r\nc\r\n' > crlf.php
printf 'if (x) {\n\t\ty();\n}\n' > reindent.php

fail() { echo "FAIL: $1"; exit 1; }

out="$(PATH_DIR="$tmp" bash "$here/consistency-diff.sh" HEAD)"
echo "$out"

# -U0: no context lines from either fixture.
grep -q '^@@' <<< "$out" || fail "no hunk header"
if grep -qE '^ (keep-|ctx-)' <<< "$out"; then fail "context lines present"; fi

# All changed lines minified -> one line, no body.
grep -q '^diff --git --simple LL min.js$' <<< "$out" || fail "min.js not collapsed to LL"
if grep -q 'var a=' <<< "$out"; then fail "collapsed file leaked its body"; fi

# One short changed line -> diff survives, only the long line is truncated.
grep -q '^-short-2$' <<< "$out" || fail "mixed.js short target line missing"
grep -q '^+short-1$' <<< "$out" || fail "mixed.js short build line missing"
grep -q '^-var m=2;.*\[target line, .* truncated\]$' <<< "$out" || fail "mixed.js target line not truncated"
grep -q '^+var m=1;.*\[build line, .* truncated\]$' <<< "$out" || fail "mixed.js build line not truncated"
[ "$(awk '{ if (length($0) > 400) c++ } END { print c+0 }' <<< "$out")" = 0 ] || fail "long line leaked"

# Whitespace-only drift collapses; A/D still emit; clean files stay absent.
grep -q '^diff --git --simple WS crlf.php$' <<< "$out" || fail "missing WS crlf.php"
grep -q '^diff --git --simple WS reindent.php$' <<< "$out" || fail "missing WS reindent.php"
if grep -q '^-a$' <<< "$out"; then fail "whitespace-only body not collapsed"; fi
grep -q '^diff --git --simple A removed.txt$' <<< "$out" || fail "missing A removed.txt"
grep -q '^diff --git --simple D added.txt$' <<< "$out" || fail "missing D added.txt"
if grep -q 'plain.txt' <<< "$out"; then fail "unchanged file listed"; fi

# Both artifacts run through the same -R frame, so '+' is the build side and '-' the
# target in each. Only which build is compared changes; HEAD~1 must label the
# previously deployed build's line as "build", not as "target".
prev="$(PATH_DIR="$tmp" bash "$here/consistency-diff.sh" HEAD~1)"
grep -q '^+var m=0;.*\[build line, .* truncated\]$' <<< "$prev" || fail "HEAD~1 build side mislabeled"
grep -q '^-var m=2;.*\[target line, .* truncated\]$' <<< "$prev" || fail "HEAD~1 target side mislabeled"
grep -q '^diff --git --simple LL min.js$' <<< "$prev" || fail "HEAD~1 min.js not collapsed to LL"
if grep -qE '^ (keep-|ctx-)' <<< "$prev"; then fail "HEAD~1 kept context lines"; fi

echo "OK"
