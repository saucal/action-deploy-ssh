#!/bin/bash
# Exercises check-against-manifest.sh: does it forgive exactly the mismatches that the
# ignore rules make legitimate, and still fail on real drift?
cd "$(dirname "$0")/.." || exit 1
ACTION_DIR="$PWD"
pass=0; fail=0

# run <name> <rules> <git manifest> <rsync manifest> <expect: MATCH|MISMATCH>
run() {
	local name="$1" rules="$2" gitm="$3" rsyncm="$4" expect="$5"
	local work; work="$(mktemp -d)"
	git -C "$work" init -q
	printf '%s' "$gitm"   > "$work/git-manifest"
	printf '%s' "$rsyncm" > "$work/rsync-manifest"

	# Derive the three views the same way main.js does.
	local sides
	if ! sides="$( node -e "
		const F = require('$ACTION_DIR/rsyncRulesFormatter');
		const r = F.parse(process.argv[1]);
		for (const s of ['not-sent','not-deleted','hidden'])
			console.log('---' + s + '---\n' + F.toGitignore(r, s));
	" -- "$rules" )"; then
		fail=$((fail+1)); echo "FAIL  $name: could not derive gitignore sides"; rm -rf "$work"; return
	fi
	local not_sent not_deleted hidden
	not_sent="$(   sed -n '/^---not-sent---$/,/^---not-deleted---$/p'  <<< "$sides" | sed '1d;$d' )"
	not_deleted="$(sed -n '/^---not-deleted---$/,/^---hidden---$/p'    <<< "$sides" | sed '1d;$d' )"
	hidden="$(     sed -n '/^---hidden---$/,$p'                        <<< "$sides" | sed '1d' )"

	local out code
	out="$( GITHUB_WORKSPACE="$work" PATH_DIR="" \
		GIT_MANIFEST="$work/git-manifest" RSYNC_MANIFEST="$work/rsync-manifest" \
		SSH_IGNORE_LIST="$not_sent" SSH_NOT_DELETED_LIST="$not_deleted" SSH_HIDDEN_LIST="$hidden" \
		bash "$ACTION_DIR/check-against-manifest.sh" 2>&1 )"
	code=$?
	rm -rf "$work"

	local got=MATCH; [ $code -ne 0 ] && got=MISMATCH
	if [ "$got" = "$expect" ]; then
		pass=$((pass+1))
	else
		fail=$((fail+1))
		echo "FAIL  $name: expected $expect, got $got"
		echo "$out" | sed 's/^/        /'
	fi
}

run "clean deploy matches" \
	'/uploads/' \
	'+ plugins/acme/acme.php
' \
	'plugins/acme/acme.php
' MATCH

run "excluded path in git manifest is forgiven" \
	'/vendor/' \
	'+ plugins/acme/acme.php
+ vendor/autoload.php
' \
	'plugins/acme/acme.php
' MATCH

run "protect: git deletes a file rsync will not remove" \
	'protect /mu-plugins/' \
	'- mu-plugins/old-helper.php
' \
	'' MATCH

run "hide: rsync deletes a file git never knew about" \
	'hide /old-plugin/' \
	'' \
	'deleting old-plugin/leftover.php
' MATCH

run "hide + protect together" \
	'protect /mu-plugins/
hide /old-plugin/' \
	'- mu-plugins/gone.php
+ plugins/acme/acme.php
' \
	'plugins/acme/acme.php
deleting old-plugin/leftover.php
' MATCH

run "hidden path that git still tracks is forgiven on the send side" \
	'hide /old-plugin/' \
	'+ old-plugin/x.php
+ plugins/acme/acme.php
' \
	'plugins/acme/acme.php
' MATCH

# Without the -x in `grep -vxF`, an ignored path that is a PREFIX of another manifest
# entry would drag that entry out of the comparison too, and the deploy would fail.
run "an ignored path does not drag its prefix-siblings out of the comparison" \
	'/vendor/autoload.php' \
	'+ vendor/autoload.php
+ vendor/autoload.php.bak
' \
	'vendor/autoload.php.bak
' MATCH

run "REAL drift still fails: rsync deletes something unexplained" \
	'/uploads/' \
	'+ plugins/acme/acme.php
' \
	'plugins/acme/acme.php
deleting plugins/other/x.php
' MISMATCH

run "REAL drift still fails: git expects a file rsync will not send" \
	'/uploads/' \
	'+ plugins/acme/acme.php
+ plugins/missing.php
' \
	'plugins/acme/acme.php
' MISMATCH

run "protect does NOT forgive an unexplained deletion elsewhere" \
	'protect /mu-plugins/' \
	'' \
	'deleting themes/twenty/style.css
' MISMATCH

echo
echo "$pass passed, $fail failed"
[ $fail -eq 0 ]
