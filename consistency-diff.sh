#!/bin/bash
cd "${PATH_DIR}" || exit 1;
git add -A . > /dev/null 2>&1
git --no-pager diff -R -M HEAD
