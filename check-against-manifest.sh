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
PATH_DIR="${GITHUB_WORKSPACE}/${PATH_DIR}"
manifest_file="${GIT_MANIFEST}"
rsync_file="${RSYNC_MANIFEST}"

echo "--------------------------------------------------"

cd "${PATH_DIR}" || exit 1;

# Echo the stdin lines that are NOT matched by the given gitignore rules.
# core.excludesFile is used rather than writing a .gitignore, so the repo under test is
# never mutated -- the previous mv/restore dance corrupted the checkout if it died early.
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
	ignored="$( printf '%s\n' "$input" | git -c core.excludesFile="$rules_file" \
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
