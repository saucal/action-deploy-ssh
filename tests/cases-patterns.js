// CHARACTERISATION: gitignore-flavoured ignore list -> rsync filter file.
//
// Everything here pins what rsyncRulesFormatter.js + real rsync DO today. Nothing here
// asserts what they ought to do. Cases marked `bug:` pin a result that is wrong; they
// still assert the current result so the suite stays green until someone changes the
// translation on purpose.
//
// Note on scope: the harness feeds the raw ignore list straight to the formatter, which
// is also what main.js does -- parse() itself drops `#` comment lines, blank lines and
// duplicates. check-against-manifest.sh does NOT see the raw list: it gets gitignore
// views of the parsed rules built by formatter.toGitignore().
module.exports = [

	// ---------------------------------------------------------------------------
	// 1. ANCHORING
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: a leading slash anchors to the deploy root',
		rules: '/uploads/',
		filter: '- /uploads/',
		send: {
			'/uploads/a.jpg': 'IGNORED',
			'/wp-content/uploads/b.jpg': 'SENT',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'patterns: no leading slash matches at every depth',
		rules: 'uploads/',
		filter: '- uploads/',
		send: {
			'/uploads/a.jpg': 'IGNORED',
			'/wp-content/uploads/b.jpg': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'patterns: a mid-pattern slash is NOT anchored (documented divergence from git)',
		rules: 'wp-content/uploads/',
		filter: '- wp-content/uploads/',
		send: {
			'/wp-content/uploads/a.jpg': 'IGNORED',
			// git anchors any pattern containing a slash, so git would deploy this one.
			'/deep/wp-content/uploads/b.jpg': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'patterns: a trailing slash is carried through verbatim',
		rules: '/logs/',
		filter: '- /logs/',
		send: { '/logs/a.txt': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: a lone slash excludes nothing at all',
		rules: '/',
		filter: '- /',
		send: { '/a.php': 'SENT', '/b/c.php': 'SENT' },
	},
	{
		name: 'patterns: a lone slash surrounded by spaces still trims to "/"',
		rules: ' / ',
		filter: '- /',
		send: { '/a.php': 'SENT' },
	},
	{
		name: 'patterns: a ./ prefix is passed through and then matches nothing',
		rules: './cache/',
		filter: '- ./cache/',
		send: { '/cache/x.txt': 'SENT', '/keep.php': 'SENT' },
		note: 'inert, and git agrees: gitignore has no ./ prefix either, so neither engine matches /cache/ with it',
	},
	{
		name: 'patterns: a ../ prefix escapes nothing and matches nothing',
		rules: '../secrets',
		filter: '- ../secrets',
		send: { '/secrets': 'SENT', '/a/secrets': 'SENT' },
		note: 'inert, and git agrees: ".." is not resolved in a pattern, so it matches nothing in either engine',
	},
	{
		name: 'patterns: doubled slashes are passed through and match nothing',
		rules: '//uploads//',
		filter: '- //uploads//',
		send: { '/uploads/a.jpg': 'SENT', '/keep.php': 'SENT' },
		note: 'inert, and git agrees: neither engine normalises a doubled slash in a pattern',
	},
	{
		name: 'patterns: a bare name matches files at any depth',
		rules: '.env',
		filter: '- .env',
		send: { '/.env': 'IGNORED', '/sub/.env': 'IGNORED', '/a.env': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: a rooted glob only fires at the root',
		rules: '/*.log',
		filter: '- /*.log',
		send: { '/a.log': 'IGNORED', '/sub/b.log': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: an unrooted glob fires at every depth',
		rules: '*.log',
		filter: '- *.log',
		send: { '/a.log': 'IGNORED', '/sub/b.log': 'IGNORED', '/keep.php': 'SENT' },
	},

	// ---------------------------------------------------------------------------
	// 2. GLOBS
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: a lone * excludes the entire build',
		rules: '*',
		filter: '- *',
		send: { '/a.php': 'IGNORED', '/b/c.php': 'IGNORED' },
	},
	{
		name: 'patterns: a lone ** excludes the entire build',
		rules: '**',
		filter: '- **',
		send: { '/a.php': 'IGNORED', '/b/c.php': 'IGNORED' },
	},
	{
		name: 'patterns: a lone *** excludes the entire build',
		rules: '***',
		filter: '- ***',
		send: { '/a.php': 'IGNORED', '/b/c.php': 'IGNORED' },
	},
	{
		name: 'patterns: * does not cross a slash',
		rules: '/wp-content/*/cache/',
		filter: '- /wp-content/*/cache/',
		send: {
			'/wp-content/plugins/cache/x.txt': 'IGNORED',
			'/wp-content/a/b/cache/x.txt': 'SENT',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'patterns: ** crosses slashes',
		rules: '/wp-content/**/cache/',
		filter: '- /wp-content/**/cache/',
		send: {
			'/wp-content/plugins/cache/x.txt': 'IGNORED',
			'/wp-content/a/b/cache/x.txt': 'IGNORED',
			// rsync needs at least one path component between the literal slashes;
			// git's a/**/b matches "zero or more directories" and would ignore this.
			'/wp-content/cache/x.txt': 'SENT',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'patterns: **/ prefix reaches every depth including the root',
		rules: '**/node_modules/',
		filter: '- **/node_modules/',
		send: { '/node_modules/a.js': 'IGNORED', '/a/node_modules/b.js': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: a trailing *** covers the directory and its subtree',
		rules: '/a/***',
		filter: '- /a/***',
		send: { '/a/b.txt': 'IGNORED', '/a/c/d.txt': 'IGNORED', '/a.txt': 'SENT' },
	},
	{
		name: 'patterns: ? matches exactly one character',
		rules: '/?.php',
		filter: '- /?.php',
		send: { '/a.php': 'IGNORED', '/ab.php': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: [abc] character class',
		rules: '/[abc].php',
		filter: '- /[abc].php',
		send: { '/a.php': 'IGNORED', '/d.php': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: [a-z] character range',
		rules: '/[a-c].php',
		filter: '- /[a-c].php',
		send: { '/b.php': 'IGNORED', '/z.php': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: [!a] negated class is kept intact',
		rules: '/[!a].php',
		// Only a LEADING ! negates, so the class reaches rsync untouched. Before #22 the first
		// ! anywhere was stripped and this became "- /[a].php" -- the exact inverse.
		filter: '- /[!a].php',
		send: {
			'/a.php': 'SENT',
			'/b.php': 'IGNORED',
			'/c.php': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'patterns: [^a] negated class survives (only ! is stripped)',
		rules: '/[^a].php',
		filter: '- /[^a].php',
		send: { '/a.php': 'SENT', '/b.php': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: an unclosed [ matches nothing, not even itself',
		rules: '/[abc.php',
		filter: '- /[abc.php',
		send: { '/[abc.php': 'SENT', '/a.php': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: an escaped \\* matches a literal asterisk',
		rules: '/\\*.log',
		filter: '- /\\*.log',
		send: { '/*.log': 'IGNORED', '/a.log': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: an unescaped * in a filename rule also swallows the neighbours',
		rules: '/star*.php',
		filter: '- /star*.php',
		send: { '/star*.php': 'IGNORED', '/starry.php': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: multiple * in one segment',
		rules: '/a*b*c.php',
		filter: '- /a*b*c.php',
		send: { '/axbxc.php': 'IGNORED', '/abc.php': 'IGNORED', '/acb.php': 'SENT' },
	},

	// ---------------------------------------------------------------------------
	// 3. NEGATION
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: ! becomes a + include rule',
		rules: '!/only-include.php',
		filter: '+ /only-include.php',
		send: { '/only-include.php': 'SENT', '/other.php': 'SENT' },
	},
	{
		name: 'patterns: a negation under a fully excluded directory never fires',
		rules: '/cache/\n!/cache/keep.php',
		filter: '+ /cache/keep.php\n- /cache/',
		send: { '/cache/keep.php': 'IGNORED', '/cache/junk.txt': 'IGNORED', '/x.php': 'SENT' },
		note: 'git agrees -- a file cannot be re-included once its parent directory is excluded. rsync never descends into /cache/, so the include is emitted first and never consulted',
	},
	{
		name: 'patterns: a negation under a glob-excluded directory never fires either',
		rules: '/wp-content/*/\n!/wp-content/plugins/keep.php',
		filter: '+ /wp-content/plugins/keep.php\n- /wp-content/*/',
		send: {
			'/wp-content/plugins/keep.php': 'IGNORED',
			'/wp-content/plugins/x.php': 'IGNORED',
			'/a.php': 'SENT',
		},
		note: 'git agrees: the parent directory is excluded, so the re-include is never evaluated in either engine',
	},
	{
		name: 'patterns: a negation DOES fire when only the children are excluded',
		rules: '/cache/*\n!/cache/keep.php',
		filter: '+ /cache/keep.php\n- /cache/*',
		send: { '/cache/keep.php': 'SENT', '/cache/junk.txt': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a negation written BEFORE its broad rule still wins (documented divergence from git)',
		rules: '!/keep.log\n*.log',
		filter: '+ /keep.log\n- *.log',
		send: { '/keep.log': 'SENT', '/other.log': 'IGNORED', '/a.php': 'SENT' },
		// git is last-match-wins, so git would ignore /keep.log for this raw list. The
		// manifest check no longer trips over it: see "divergence 1" below.
	},
	{
		name: 'patterns: the same negation written after its broad rule behaves identically',
		rules: '*.log\n!/keep.log',
		filter: '+ /keep.log\n- *.log',
		send: { '/keep.log': 'SENT', '/other.log': 'IGNORED', '/a.php': 'SENT' },
	},
	{
		name: 'patterns: a mid-pattern ! is kept as a literal character',
		rules: '/foo!bar.php',
		filter: '- /foo!bar.php',
		send: {
			'/foo!bar.php': 'IGNORED', // the file the author meant to exclude
			'/foobar.php': 'SENT',     // before #22 the ! was deleted and this was excluded instead
			'/a.php': 'SENT',
		},
	},
	{
		name: 'patterns: a ! inside a directory name is kept as a literal character',
		rules: '/pl!ugins/',
		filter: '- /pl!ugins/',
		send: { '/pl!ugins/a.php': 'IGNORED', '/plugins/a.php': 'SENT' },
	},
	{
		name: 'patterns: !! keeps the second ! and produces an include of a literal !name',
		rules: '*\n!!weird',
		filter: '+ !weird\n- *',
		send: { '/!weird': 'SENT', '/weird': 'IGNORED', '/other': 'IGNORED' },
	},
	{
		name: 'patterns: a lone ! line is dropped instead of breaking the filter',
		rules: '!',
		// Before #22 this emitted "+ ", which rsync rejects ("unexpected end of filter
		// rule") with exit 1. The send below would throw if that came back.
		filter: '',
		send: { '/a.php': 'SENT', '/b/c.php': 'SENT' },
	},
	{
		name: 'patterns: a lone !/ produces an include-everything rule',
		rules: '!/',
		filter: '+ /***',
		send: { '/a.php': 'SENT', '/b/c.php': 'SENT' },
	},
	{
		name: 'patterns: whitespace after ! is trimmed and the re-include works',
		rules: '/cache/*\n!  /cache/keep.php',
		filter: '+ /cache/keep.php\n- /cache/*',
		send: { '/cache/keep.php': 'SENT', '/cache/junk.txt': 'IGNORED' },
		manifest: { git: '+ cache/keep.php\n+ cache/junk.txt\n', rsync: 'cache/keep.php\n', expect: 'MATCH' },
		note: 'UNPLANNED change from #22, and it now DIFFERS FROM GIT. parseRule() trims what follows the leading "!", so "!  /cache/keep.php" re-includes /cache/keep.php. git does not strip whitespace after "!": for git the pattern keeps its two leading spaces, matches nothing, and keep.php stays ignored (verified with git check-ignore). Before #22 rsync agreed with git. The manifest check follows the formatter (its view is "!/cache/keep.php"), so it does not flag the difference',
	},
	{
		name: 'patterns: negating a pattern nothing excluded is a harmless no-op',
		rules: '/vendor/\n!/plugins/keep.php',
		filter: '+ /plugins/keep.php\n- /vendor/',
		send: { '/plugins/keep.php': 'SENT', '/plugins/other.php': 'SENT', '/vendor/a.php': 'IGNORED' },
	},
	{
		name: 'patterns: nested re-includes under an excluded directory are all dead',
		rules: '/cache/\n!/cache/sub/\n!/cache/sub/deep/keep.php',
		filter: '+ /cache/sub/deep/keep.php\n+ /cache/sub/***\n- /cache/',
		send: {
			'/cache/sub/deep/keep.php': 'IGNORED',
			'/cache/sub/a.txt': 'IGNORED',
			'/cache/junk.txt': 'IGNORED',
		},
		note: 'git agrees: with /cache/ itself excluded, neither re-include is consulted in either engine',
	},
	{
		name: 'patterns: nested re-includes DO work when the parent exclude is child-scoped',
		rules: '/cache/*\n!/cache/sub/\n!/cache/sub/deep/keep.php',
		filter: '+ /cache/sub/deep/keep.php\n+ /cache/sub/***\n- /cache/*',
		send: {
			'/cache/sub/deep/keep.php': 'SENT',
			'/cache/sub/a.txt': 'SENT',
			'/cache/junk.txt': 'IGNORED',
		},
	},
	{
		name: 'patterns: a negation makes rsync DELETE the remote copy it was meant to keep',
		rules: '/cache/*\n!/cache/keep.php',
		local: [ '/x.php' ],
		remote: { '/cache/keep.php': 'DELETED', '/cache/junk.txt': 'KEPT' },
		note: 'correct: "!" means the build owns the file, so a copy that exists only on the server is removed like any other extraneous file. Server-only files are protected by excluding them, not by negating them',
	},

	// ---------------------------------------------------------------------------
	// 4. THE *** SUBTREE EXPANSION
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: *** is appended to include-directory rules only',
		rules: '!/cache/',
		filter: '+ /cache/***',
	},
	{
		name: 'patterns: *** is NOT appended to exclude-directory rules',
		rules: '/cache/',
		filter: '- /cache/',
	},
	{
		name: 'patterns: *** is NOT appended to an include without a trailing slash',
		rules: '!/cache/sub',
		filter: '+ /cache/sub',
	},
	{
		name: 'patterns: *** is NOT appended to an include file rule',
		rules: '!/cache/x.php',
		filter: '+ /cache/x.php',
	},
	{
		name: 'patterns: an include already ending in *** is left alone',
		rules: '!/cache/***',
		filter: '+ /cache/***',
	},
	{
		name: 'patterns: *** is appended to an unanchored include directory too',
		rules: '!cache/',
		filter: '+ cache/***',
	},
	{
		name: 'patterns: !dir/ and !dir behave the same once the parent lets rsync descend',
		rules: '/cache/*\n!/cache/sub',
		filter: '+ /cache/sub\n- /cache/*',
		send: { '/cache/sub/a.txt': 'SENT', '/cache/sub/deep/b.txt': 'SENT', '/cache/junk.txt': 'IGNORED' },
	},

	// ---------------------------------------------------------------------------
	// 5. SPECIFICITY / ORDERING
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: rules are re-sorted most-specific-first, not kept in written order',
		rules: '/a\n/b/c',
		filter: '- /b/c\n- /a',
	},
	{
		name: 'patterns: equal-score rules come out in REVERSED input order',
		rules: '/a\n/b\n/c\n/d\n/e',
		filter: '- /e\n- /d\n- /c\n- /b\n- /a',
		note: 'sortRules() breaks specificity ties by REVERSE authoring order, so the last-written rule is emitted first and wins -- git\'s rule too, reached from the opposite direction because rsync is first-match-wins',
	},
	{
		name: 'patterns: the tie reversal makes the LAST written line win a same-pattern conflict',
		rules: '/x.php\n!/x.php',
		filter: '+ /x.php\n- /x.php',
		send: { '/x.php': 'SENT', '/y.php': 'SENT' },
	},
	{
		name: 'patterns: ...and reversing the two lines flips the outcome',
		rules: '!/x.php\n/x.php',
		filter: '- /x.php\n+ /x.php',
		send: { '/x.php': 'IGNORED', '/y.php': 'SENT' },
	},
	{
		name: 'patterns: a leading slash contributes nothing to the score',
		rules: '/a\na',
		filter: '- a\n- /a',
	},
	{
		name: 'patterns: a trailing slash contributes nothing to the score',
		rules: '/a/\n/a',
		filter: '- /a\n- /a/',
	},
	{
		name: 'patterns: a glob-only segment scores 5, a literal segment scores 20',
		rules: '/*\n/z',
		filter: '- /z\n- /*',
	},
	{
		name: 'patterns: a segment with a glob AND characters scores 10',
		rules: '/*.log\n/z',
		filter: '- /z\n- /*.log',
	},
	{
		name: 'patterns: SURPRISE -- **/g (25) outranks the literal /d (20)',
		rules: '/d\n**/g',
		filter: '- **/g\n- /d',
		note: 'segment count beats literalness in the score, but both rules are excludes, so the order changes no outcome',
	},
	{
		name: 'patterns: SURPRISE -- nine glob segments (45) outrank two literal segments (40)',
		rules: '/a/b\n*/*/*/*/*/*/*/*/*',
		filter: '- */*/*/*/*/*/*/*/*\n- /a/b',
		note: 'a deep all-wildcard pattern outranks an exact path, but both rules are excludes, so the order changes no outcome',
	},
	{
		name: 'patterns: a shallow negation LOSES to a deeper exclude',
		rules: '/logs/deep/keep.log\n!/logs/',
		filter: '- /logs/deep/keep.log\n+ /logs/***',
		send: { '/logs/deep/keep.log': 'IGNORED', '/logs/other.log': 'SENT', '/a.php': 'SENT' },
	},
	{
		name: 'patterns: a glob negation LOSES to a literal exclude regardless of intent',
		rules: '/logs/keep.log\n!*.log',
		filter: '- /logs/keep.log\n+ *.log',
		send: { '/logs/keep.log': 'IGNORED', '/other.log': 'SENT', '/a.php': 'SENT' },
	},
	{
		name: 'patterns: SURPRISE -- a deep negation ordered first still loses to a glob dir exclude',
		rules: '/logs/*\n!/logs/deep/keep.log',
		filter: '+ /logs/deep/keep.log\n- /logs/*',
		send: { '/logs/deep/keep.log': 'IGNORED', '/logs/other.log': 'IGNORED', '/a.php': 'SENT' },
		note: 'git agrees: "/logs/*" excludes the directory /logs/deep, and a file under an excluded directory cannot be re-included. rsync prunes the directory before the file rule is reached',
	},
	{
		name: 'patterns: a realistic WordPress list sorts deep-and-literal first, bare globs last',
		rules: '/vendor/\n/plugins/wp-rocket/licence-data.php\n*.log\n.git\n/uploads/',
		filter: '- /plugins/wp-rocket/licence-data.php\n- /uploads/\n- .git\n- /vendor/\n- *.log',
	},

	// ---------------------------------------------------------------------------
	// 6. HYGIENE
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: an empty ignore list produces an empty filter',
		rules: '',
		filter: '',
		send: { '/a.php': 'SENT', '/b/c.php': 'SENT' },
	},
	{
		name: 'patterns: a list that is one newline produces an empty filter',
		rules: '\n',
		filter: '',
		send: { '/a.php': 'SENT' },
	},
	{
		name: 'patterns: blank lines are dropped',
		rules: '\n\n/a\n\n\n/b\n\n',
		filter: '- /b\n- /a',
	},
	{
		name: 'patterns: whitespace-only lines are dropped',
		rules: '/a\n   \n\t\n/b',
		filter: '- /b\n- /a',
	},
	{
		name: 'patterns: leading spaces and tabs are trimmed off a rule',
		rules: '   /a\n\t/b',
		filter: '- /b\n- /a',
	},
	{
		name: 'patterns: trailing spaces and tabs are trimmed off a rule',
		rules: '/a   \n/b\t\t',
		filter: '- /b\n- /a',
	},
	{
		name: 'patterns: CRLF line endings are absorbed by the per-rule trim',
		rules: '/a\r\n/b\r\n',
		filter: '- /b\n- /a',
	},
	{
		name: 'patterns: duplicate rules are collapsed to one',
		rules: '/a\n/a\n/a',
		filter: '- /a',
	},
	{
		name: 'patterns: a # comment line is dropped by the parser',
		rules: '# ignore stuff\n/a.php',
		filter: '- /a.php',
		send: { '/a.php': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a comment line does not exclude a file with that literal name',
		rules: '# ignore stuff',
		filter: '',
		send: { '/# ignore stuff': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a list of nothing but comments yields an empty filter',
		rules: '# one\n# two',
		filter: '',
	},
	{
		name: 'patterns: a # mid-line is part of the pattern, not a trailing comment',
		rules: '/a.php # why',
		filter: '- /a.php # why',
		send: { '/a.php': 'SENT', '/a.php # why': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: an escaped \\# excludes a file whose name starts with #',
		rules: '\\#a.php',
		// A leading backslash makes the rest of the line a literal, as in git.
		filter: '- #a.php',
		send: { '/#a.php': 'IGNORED', '/a.php': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: an escaped \\! excludes a file whose name starts with !',
		rules: '\\!a.php',
		filter: '- !a.php',
		send: { '/!a.php': 'IGNORED', '/a.php': 'SENT', '/x.php': 'SENT' },
	},

	// ---------------------------------------------------------------------------
	// 7. FILENAMES THAT STRESS THE MATCHER
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: spaces inside a directory name work',
		rules: '/my dir/',
		filter: '- /my dir/',
		send: { '/my dir/a.txt': 'IGNORED', '/mydir/a.txt': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: unicode filenames work',
		rules: '/café.php',
		filter: '- /café.php',
		send: { '/café.php': 'IGNORED', '/cafe.php': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: emoji filenames work',
		rules: '/🚀.php',
		filter: '- /🚀.php',
		send: { '/🚀.php': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a # inside a filename works',
		rules: '/foo#bar.php',
		filter: '- /foo#bar.php',
		send: { '/foo#bar.php': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a ! inside a filename protects exactly that remote file',
		rules: '/foo!bar.php',
		local: [ '/x.php' ],
		// Before #22 the rule was retargeted onto /foobar.php and these two were swapped.
		remote: { '/foo!bar.php': 'KEPT', '/foobar.php': 'DELETED' },
	},
	{
		name: 'patterns: [ ] in a filename are read as a character class, not literals',
		rules: '/a[b].php',
		filter: '- /a[b].php',
		send: { '/a[b].php': 'SENT', '/ab.php': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: escaping the brackets matches the literal name',
		rules: '/a\\[b\\].php',
		filter: '- /a\\[b\\].php',
		send: { '/a[b].php': 'IGNORED', '/ab.php': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a literal * in a filename needs escaping to be targeted alone',
		rules: '/star\\*.php',
		filter: '- /star\\*.php',
		send: { '/star*.php': 'IGNORED', '/starry.php': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a filename starting with a dash is fine',
		rules: '/-dash.php',
		filter: '- /-dash.php',
		send: { '/-dash.php': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a file named exactly "-" is fine',
		rules: '/-',
		filter: '- /-',
		send: { '/-': 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a 200-character filename is fine',
		rules: '/' + 'z'.repeat( 200 ) + '.php',
		send: { [ '/' + 'z'.repeat( 200 ) + '.php' ]: 'IGNORED', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: a dotfile at the root and nested both match a bare rule',
		rules: '.env',
		local: [ '/x.php' ],
		remote: { '/.env': 'KEPT', '/sub/.env': 'KEPT', '/a.env': 'DELETED' },
	},
	{
		name: 'patterns: a rooted exclude only protects the remote copy at the root',
		rules: '/*.log',
		local: [ '/x.php' ],
		remote: { '/a.log': 'KEPT', '/sub/b.log': 'DELETED' },
	},
	{
		name: 'patterns: a directory exclude protects the whole remote subtree from --delete',
		rules: '/cache/',
		local: [ '/x.php' ],
		remote: { '/cache/keep.php': 'KEPT', '/cache/junk.txt': 'KEPT' },
	},

	// ---------------------------------------------------------------------------
	// 8. CASE SENSITIVITY
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: matching is case-sensitive',
		rules: '/readme.md',
		filter: '- /readme.md',
		send: { '/README.md': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: character ranges are case-sensitive too',
		rules: '/[a-z].md',
		filter: '- /[a-z].md',
		send: { '/A.md': 'SENT', '/x.php': 'SENT' },
	},
	{
		name: 'patterns: an exactly-cased rule matches',
		rules: '/README.md',
		filter: '- /README.md',
		send: { '/README.md': 'IGNORED', '/x.php': 'SENT' },
	},

	// ---------------------------------------------------------------------------
	// 9. DIVERGENCE FROM GIT, PROVED END TO END
	//
	// check-against-manifest.sh feeds gitignore VIEWS of the parsed rules (toGitignore)
	// to `git check-ignore` to decide which build files rsync was allowed to skip.
	// Whenever rsync's reading of the filter and git's reading of the view disagree about
	// a path, the deploy's own consistency check fails on a deploy that actually did the
	// right thing (or passes one that did not). These cases pin that agreement or
	// disagreement at the reconciler, which is where a user would see it.
	// ---------------------------------------------------------------------------
	{
		name: 'patterns: divergence 1 (closed) -- a negation before its broad rule reconciles with rsync',
		rules: '!/keep.log\n*.log',
		// rsync transfers keep.log (the include sorts first). The gitignore view is emitted
		// in the mirror of the filter order ("*.log" then "!/keep.log"), so git's
		// last-match-wins agrees. Before #22 git got the raw list, ignored keep.log, and
		// this was a MISMATCH.
		manifest: { git: '+ keep.log\n+ other.log\n', rsync: 'keep.log\n', expect: 'MATCH' },
	},
	{
		name: 'patterns: divergence 2 -- an unanchored mid-slash rule breaks the manifest check',
		rules: 'wp-content/uploads/',
		// rsync skipped the nested copy; git, which anchors any slash-bearing pattern,
		// keeps it in the manifest and the reconciler reports a missing file.
		manifest: { git: '+ deep/wp-content/uploads/b.jpg\n', rsync: '', expect: 'MISMATCH' },
	},
	{
		name: 'patterns: divergence 2 -- the same rule reconciles fine at the root',
		rules: 'wp-content/uploads/',
		manifest: { git: '+ wp-content/uploads/a.jpg\n', rsync: '', expect: 'MATCH' },
	},
	{
		name: 'patterns: divergence 3 (closed) -- the pre-#22 [!a] plan is rejected by the manifest check',
		rules: '/[!a].php',
		// The plan the old "- /[a].php" filter produced: b.php sent, a.php skipped. git
		// ignores b.php and keeps a.php, so the check rejects it.
		manifest: { git: '+ a.php\n+ b.php\n', rsync: 'b.php\n', expect: 'MISMATCH' },
	},
	{
		name: 'patterns: divergence 3 (closed) -- the plan the deploy makes today reconciles',
		rules: '/[!a].php',
		// The filter now sends a.php and skips b.php (see "[!a] negated class is kept
		// intact"), which is git's own answer, so the check says MATCH.
		manifest: { git: '+ a.php\n+ b.php\n', rsync: 'a.php\n', expect: 'MATCH' },
	},
	{
		name: 'patterns: divergence 4 (closed) -- the pre-#22 plan for a ! filename is rejected',
		rules: '/foo!bar.php',
		// Before #22 rsync deployed foo!bar.php (its rule became /foobar.php); git ignores
		// it, so that plan is a MISMATCH. Today rsync skips it too -- next case.
		manifest: { git: '+ foo!bar.php\n', rsync: 'foo!bar.php\n', expect: 'MISMATCH' },
	},
	{
		name: 'patterns: divergence 4 (closed) -- a ! filename rsync skips reconciles',
		rules: '/foo!bar.php',
		manifest: { git: '+ foo!bar.php\n', rsync: '', expect: 'MATCH' },
	},
	{
		name: 'patterns: a comment line is dropped by both the filter and the manifest check',
		rules: '# nope\n/a.php',
		manifest: { git: '+ a.php\n+ b.php\n', rsync: 'b.php\n', expect: 'MATCH' },
	},
	{
		name: 'patterns: an empty ignore list skips the git filtering entirely',
		rules: '',
		manifest: { git: '+ a.php\n', rsync: 'a.php\n', expect: 'MATCH' },
	},
	// ------------------------------------------------ the `\` escape added by #22
	{
		name: 'patterns: a leading \\ before a glob character makes the glob REAL',
		bug: 'Regression from #22. Before, and in git, `\\*.log` matches only a file literally named `*.log`. The new escape strips the backslash, so the rule becomes `*.log` and excludes every .log file at any depth. Same for `\\?` and `\\[`. The manifest view is stripped the same way, so the check does not catch it. No live ignore list uses a leading backslash.',
		rules: '\\*.log',
		filter: '- *.log',
		local: [ '/keep.php' ],
		send: { '/a.log': 'IGNORED', '/deep/b.log': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'patterns: an escaped \\# or \\! is lost in the manifest view',
		bug: 'The rsync filter handles `\\#a.php` correctly, but toGitignore() emits `#a.php`, which git reads as a comment (and `\\!a.php` becomes a negation). rsync skips the file while the manifest check keeps it, so a release changing that file is blocked.',
		rules: '\\#a.php',
		manifest: {
			git: '+ #a.php\n+ b.php\n',
			rsync: 'b.php\n',
			expect: 'MISMATCH',
		},
	},

];
