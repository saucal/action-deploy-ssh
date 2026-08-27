#!/bin/bash
REF="${1:-HEAD}"
cd "${PATH_DIR}" || exit 1;

# rsync never deploys the files in its ignore list (composer.json/lock, vendor/,
# auth.json, logs, ...), so they must not surface in the consistency diff. The list is
# gitignore-formatted, so let git's own matcher apply it via check-ignore instead of
# reimplementing gitignore semantics (wildcards, negations, anchoring). --no-index makes
# the match pattern-only, so it also catches tracked files — e.g. a composer.json that
# changed between builds would otherwise show up in the HEAD~1 diff even though rsync
# leaves it untouched.
exclude_file=""
if [ -n "$IGNORE_LIST" ]; then
  exclude_file="$(mktemp)"
  printf '%s\n' "$IGNORE_LIST" > "$exclude_file"
fi

# Longest line kept verbatim before it is truncated to a size summary. Minified css/js
# is one line of hundreds of KB; printing it whole buries the actual change.
MAX_LINE=300

# Working tree holds the deployed (remote) state reverse-synced over the build; REF is
# the build. -R keeps the diff in deploy direction ('+' = build, '-' = target), matching
# the artifact headers/README. -U0 drops context lines: on minified files the context is
# noise, and only the changed lines answer "what differs".
git add -A . > /dev/null 2>&1
git --no-pager diff -R -M --name-status "$REF" | while read status file; do
  if [ -n "$exclude_file" ] && git -c core.excludesFile="$exclude_file" check-ignore -q --no-index "$file"; then
    continue
  fi
  if [ "$status" = "M" ]; then
    # A CRLF flip or a reindent makes every line of a file "change" while the content is
    # identical, which is the other way a diff blows up. -w emits nothing at all when the
    # only difference is whitespace, so an empty result collapses the file to one line.
    # WS is a content modification like M, just one with nothing worth printing.
    if [ -z "$(git --no-pager diff -R -M -w "$REF" -- "$file")" ]; then
      echo diff --git --simple WS "$file"
      continue
    fi
    # A minified bundle changes one or two lines, and both are the whole file. Truncating
    # them leaves 300 bytes of unreadable prefix per side and nothing learned, so when
    # EVERY changed line is over the limit the file collapses the way WS does. A file with
    # even one short changed line keeps its diff — that line is the readable part.
    body="$(git --no-pager diff -R -M -U0 "$REF" -- "$file")"
    read -r changed long <<< "$(printf '%s\n' "$body" | LC_ALL=C awk -v max="$MAX_LINE" '
      /^[+-]/ && !/^(\+\+\+|---) / { changed++; if (length($0) > max) long++ }
      END { print changed + 0, long + 0 }
    ')"
    if [ "$changed" -gt 0 ] && [ "$changed" -eq "$long" ]; then
      echo diff --git --simple LL "$file"
      continue
    fi

    printf '%s\n' "$body" | LC_ALL=C awk -v max="$MAX_LINE" '
      # LC_ALL=C so length()/substr() count bytes, matching the reported size.
      # "diff --git" is left alone: downstream tooling parses it as the file marker.
      length($0) > max && $0 !~ /^diff --git / {
        c = substr($0, 1, 1)
        printf "%s... [%s line, %.1f KB, truncated]\n", substr($0, 1, max), \
          (c == "+" ? "build" : (c == "-" ? "target" : "context")), length($0) / 1024
        next
      }
      { print }
    '
  else
    echo diff --git --simple "$status" "$file"
  fi
done

# Guarded rm returns 1 when there is no ignore list, which would make a clean run look
# like a failure; the script has no other failure signal, so end on 0 explicitly.
[ -n "$exclude_file" ] && rm -f "$exclude_file"
exit 0
