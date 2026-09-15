#!/bin/bash
# Reconciles what git says changed against what rsync says it is about to do.
#
# The two lists cannot be compared raw, because the ignore rules make rsync legitimately
# do less (or more) than git asked for. Each class of mismatch gets its own gitignore
# view of the same rules, built by rsyncRulesFormatter.toGitignore:
#
#   SSH_IGNORE_LIST       rsync will not transfer these -> drop git's additions
#   SSH_NOT_DELETED_LIST  rsync will not remove these   -> drop git's deletions
#   SSH_HIDDEN_LIST       rsync removes these unasked   -> drop rsync's deletions
#
# Both lists are relative to the deploy root: main.js scopes the git manifest to it when
# the deploy root is a subdirectory, and rsync's plan is already relative to it.
manifest_file="${GIT_MANIFEST}"
rsync_file="${RSYNC_MANIFEST}"

echo "--------------------------------------------------"

# check-ignore needs a repository to run in, and nothing else: with --no-index it only
# matches patterns. An empty throwaway repo keeps the answer to exactly our rules, relative
# to the deploy root. Running inside the built checkout would also apply that repo's own
# .gitignore, and would anchor the rules to the repo root rather than the deploy root.
match_repo="$(mktemp -d)"
git init -q "$match_repo"
trap 'rm -rf "$match_repo"' EXIT

# Echo the stdin lines that are NOT matched by the given gitignore rules.
keep_unignored() {
	local rules="$1"

	if [ -z "$rules" ]; then
		cat
		return
	fi

	local rules_file input ignored
	rules_file="$(mktemp)"
	printf '%s\n' "$rules" > "$rules_file"
	input="$(cat)"

	if [ -z "$input" ]; then
		rm -f "$rules_file"
		return
	fi

	# One check-ignore for the whole list; the per-line loop this replaces spawned a git
	# process per manifest entry.
	ignored="$( printf '%s\n' "$input" | git -C "$match_repo" -c core.excludesFile="$rules_file" \
		check-ignore --stdin --no-index 2>/dev/null )"
	rm -f "$rules_file"

	if [ -z "$ignored" ]; then
		printf '%s\n' "$input"
		return
	fi

	echo "Excluded from comparison:" >&2
	printf '%s\n' "$ignored" | sed 's/^/  /' >&2

	printf '%s\n' "$input" | grep -vxF -f <( printf '%s\n' "$ignored" )
}

# git's view: additions/modifications carry "+", deletions carry "-".
git_side="$(
	{
		grep '^+ ' "$manifest_file" | sed -E 's/^\+ //' | keep_unignored "$SSH_IGNORE_LIST"
		grep '^- ' "$manifest_file" | sed -E 's/^- //'  | keep_unignored "$SSH_NOT_DELETED_LIST"
	} | grep -v '^$' | sort
)"

# rsync's view: plain paths are transfers, "deleting " prefixed ones are removals.
# Directory entries are dropped from both -- git tracks files, not directories.
rsync_side="$(
	{
		grep -v '^deleting ' "$rsync_file" | grep -v '/$'
		grep '^deleting ' "$rsync_file" | sed -E 's/^deleting //' | grep -v '/$' \
			| keep_unignored "$SSH_HIDDEN_LIST"
	} | grep -v '^$' | sort
)"

diff_output=$(diff -u <(echo "$git_side") <(echo "$rsync_side"))
echo "--------------------------------------------------"

if [ -n "$diff_output" ]; then
	echo "::error title=Manifest and Rsync list DO NOT MATCH :: Please check the following diff. Lines starting with + are in the rsync list but not in the manifest. Lines starting with - are in the manifest but not in the rsync list."
	echo "--------------------------------------------------"
	echo "::group::DIFF OUTPUT"
	echo "$diff_output"
	echo "::endgroup::"
	exit 1
else
	echo "Manifest and Rsync list match."
	echo "--------------------------------------------------"
	exit 0
fi
