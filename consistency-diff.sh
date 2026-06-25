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

# Working tree holds the deployed (remote) state reverse-synced over the build; REF is
# the build. -R keeps the diff in deploy direction ('+' = build, '-' = target), matching
# the artifact headers/README.
git add -A . > /dev/null 2>&1
git --no-pager diff -R -M --name-status "$REF" | while read status file; do
  if [ -n "$exclude_file" ] && git -c core.excludesFile="$exclude_file" check-ignore -q --no-index "$file"; then
    continue
  fi
  if [ "$status" = "M" ]; then
    git --no-pager diff -R -M "$REF" -- "$file"
  else
    echo diff --git --simple "$status" "$file"
  fi
done

[ -n "$exclude_file" ] && rm -f "$exclude_file"
