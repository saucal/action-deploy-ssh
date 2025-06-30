#!/bin/bash
REF="${1:-HEAD}"
cd "${PATH_DIR}" || exit 1;
git add -A . > /dev/null 2>&1
git --no-pager diff -R -M --name-status "$REF" | while read status file; do
  if [ "$status" = "M" ]; then
    git --no-pager diff -R -M "$REF" "$file"
  else
    echo diff --git --simple "$status" "$file"
  fi
done
