#!/bin/bash
# Real-rsync check on default-ignore.txt. The git rules must be root-anchored:
# unanchored, they match a vendored .gitignore/.github deep in a plugin, and an
# excluded file is also PROTECTED FROM DELETION -- so a directory the build
# removed can never be cleared from the target ("cannot delete non-empty
# directory"), which fails the manifest check on every deploy, forever.
#
#   bash tests/default-ignore.test.sh
set -u

here="$( cd "$( dirname "$0" )" && pwd )"
work="$( mktemp -d )"
trap 'rm -rf "$work"' EXIT
src="$work/src"; dst="$work/dst"
fail=0

rules="$work/rules.txt"
node -e '
const fs = require( "fs" );
let l = fs.readFileSync( process.argv[ 1 ], "utf8" );
l = l.split( "\n" ).filter( ( x ) => x.trim() !== "" && ! x.trim().startsWith( "#" ) ).join( "\n" );
fs.writeFileSync( process.argv[ 2 ], require( process.argv[ 3 ] ).run( l ) );
' "$here/../default-ignore.txt" "$rules" "$here/../rsyncRulesFormatter.js" || exit 1

# Build: a plugin carrying a vendored package, exactly as composer ships it.
mkdir -p "$src/plugins/keep/vendor/acme/pkg/.github/workflows" "$src/.git"
echo x > "$src/plugins/keep/vendor/acme/pkg/.gitignore"
echo x > "$src/plugins/keep/vendor/acme/pkg/.github/workflows/ci.yml"
echo x > "$src/plugins/keep/plugin.php"
echo x > "$src/.gitignore"
echo x > "$src/.git/HEAD"

# Target: a previous deploy, plus a plugin the build has since dropped. That
# plugin also carries a vendored .gitignore, so it is the directory rsync must
# be able to delete. Nothing here is copied from the build, so every check
# below reads what THIS transfer did.
mkdir -p "$dst/plugins/keep" "$dst/plugins/gone/vendor/acme/pkg"
echo x > "$dst/plugins/keep/plugin.php"
echo x > "$dst/plugins/gone/vendor/acme/pkg/.gitignore"
echo x > "$dst/plugins/gone/gone.php"

out="$( rsync -rc --delete --filter="merge $rules" "$src/" "$dst/" 2>&1 )"

check() { # <description> <path> present|absent
	local desc="$1" path="$2" want="$3" got=absent
	[ -e "$dst/$path" ] && got=present
	if [ "$got" = "$want" ]; then
		echo "ok   - $desc"
	else
		echo "FAIL - $desc (wanted $want on target, got $got)"
		fail=1
	fi
}

check "the build's own .git is never deployed"          ".git"                                          absent
check "the build's own root .gitignore is not deployed" ".gitignore"                                    absent
check "a vendored .gitignore IS deployed"               "plugins/keep/vendor/acme/pkg/.gitignore"       present
check "a vendored .github IS deployed"                  "plugins/keep/vendor/acme/pkg/.github/workflows/ci.yml" present
check "a dropped plugin is deleted whole"               "plugins/gone"                                  absent

if grep -q "cannot delete non-empty directory" <<< "$out"; then
	echo "FAIL - rsync could not clear a deleted directory:"
	grep "cannot delete non-empty directory" <<< "$out" | sed 's/^/       /'
	fail=1
else
	echo "ok   - rsync cleared every deleted directory"
fi

exit "$fail"
