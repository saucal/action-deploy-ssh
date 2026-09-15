// Characterisation cases for the ignore-list shapes that are ACTUALLY in production,
// plus the hostile inputs a human could plausibly paste into an SSH_IGNORE_LIST.
//
// PART A covers the rule shapes found in effective ignore lists (composed the way main.js
// composes them: default-ignore.txt when SSH_IGNORE_LIST is absent or the literal string
// "false", then SSH_IGNORE_LIST_EXTRA appended unless it is absent or "false"). Names
// are generic stand-ins.
//
// PART B is adversarial: degenerate, enormous and malformed rules. Before #22 a rule of
// only "!" made rsync exit non-zero and killed the deploy; the parser now drops it.
//
// Everything here pins CURRENT behaviour. Cases carrying `bug:` pin a result that is
// wrong; they still assert what happens today, so the suite stays green until someone
// deliberately changes the action.

const fs = require( 'fs' );
const path = require( 'path' );

const BEL = '\u0007';
const ESC = '\u001b';
const ZWSP = '\u200b';
const RLO = '\u202e';

// A pattern of 1024 characters or more: rsync prints "discarding over-long filter"
// and drops the rule. 1023 is the last length that still works.
const OVERLONG = '/' + 'a'.repeat( 1023 );

const DEEP_DIRS = Array.from( { length: 60 }, ( _, i ) => 'd' + i ).join( '/' );

const MANY_RULES = Array.from( { length: 20000 }, ( _, i ) => '/plugin-' + i + '/' ).join( '\n' );

// A whitelist-style list: an unanchored name, a `/*` catch-all, a directory negation,
// narrow excludes underneath it, two more directory negations written AFTER those
// narrow excludes, a `**` rule, and plain anchored files.
const WHITELIST = [
	'.git',
	'/*',
	'!/wp-content/',
	'/wp-content/uploads/',
	'/wp-content/upgrade',
	'/wp-content/cache/',
	'/wp-content/advanced-cache.php',
	'/wp-content/*.log',
	'!/wp-content/mu-plugins/',
	'!/wp-content/plugins/',
	'!/wp-content/themes/',
	'/vendor/**',
	'/auth.json',
	'/composer.json',
	'/composer.lock',
	'/wp-content/object-cache.php',
	'/wp-content/db.php',
].join( '\n' );

// The list a site inherits when SSH_IGNORE_LIST is unset or "false", read from the
// action. Blank and `#` lines are stripped here only to keep the fixture short; main.js
// passes the file as-is and parse() drops them the same way.
const DEFAULT_LIST = fs.readFileSync( path.join( __dirname, '..', 'default-ignore.txt' ), 'utf8' )
	.split( '\n' ).filter( ( l ) => l.trim() !== '' && ! l.trim().startsWith( '#' ) ).join( '\n' );

module.exports = [

	// ------------------------------------------------------------------
	// PART A -- the shapes that are actually deployed today
	// ------------------------------------------------------------------

	{
		name: 'fleet: an unanchored bare name matches at every depth',
		rules: '.git\n.gitignore\n.gitattributes\n.github',
		local: [ '/keep.php' ],
		send: {
			'/.git/config': 'IGNORED',
			'/.gitignore': 'IGNORED',
			'/plugins/example-plugin/.git/HEAD': 'IGNORED',
			'/plugins/example-plugin/.gitattributes': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: an anchored file matches only at the transfer root',
		rules: '/plugins/index.php\n/composer.json',
		local: [ '/keep.php' ],
		filter: '- /plugins/index.php\n- /composer.json',
		send: {
			'/plugins/index.php': 'IGNORED',
			'/composer.json': 'IGNORED',
			'/plugins/example-plugin/index.php': 'SENT',
			'/plugins/example-plugin/composer.json': 'SENT',
		},
	},
	{
		name: 'fleet: an anchored directory is excluded and its remote copy is protected',
		rules: '/uploads/\n/cache/',
		local: [ '/keep.php' ],
		send: { '/uploads/2024/a.jpg': 'IGNORED', '/keep.php': 'SENT' },
		remote: {
			'/uploads/legacy.jpg': 'KEPT',
			'/cache/page.html': 'KEPT',
			'/orphan.php': 'DELETED',
		},
	},
	{
		name: 'fleet: an unanchored directory matches at every depth',
		rules: 'uploads/',
		local: [ '/keep.php' ],
		send: {
			'/uploads/a.jpg': 'IGNORED',
			'/plugins/example-plugin/uploads/a.jpg': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: a multi-segment anchored path',
		rules: '/plugins/example-plugin/storage/\n/plugins/example-plugin/licence-data.php',
		local: [ '/keep.php' ],
		send: {
			'/plugins/example-plugin/storage/backup.zip': 'IGNORED',
			'/plugins/example-plugin/licence-data.php': 'IGNORED',
			'/plugins/example-plugin/main.php': 'SENT',
		},
	},
	{
		// The default list ships `/*.log`.
		name: 'fleet: a root-anchored glob does not reach into subdirectories',
		rules: '/*.log',
		local: [ '/keep.php' ],
		send: {
			'/debug.log': 'IGNORED',
			'/plugins/example-plugin/debug.log': 'SENT',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: an unanchored glob matches at every depth',
		rules: '*.log',
		local: [ '/keep.php' ],
		send: {
			'/debug.log': 'IGNORED',
			'/plugins/example-plugin/debug.log': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		// The default list ships `/saucal_migration_*/`.
		name: 'fleet: a wildcard directory segment excludes every matching directory',
		rules: '/saucal_migration_*/',
		local: [ '/keep.php' ],
		send: {
			'/saucal_migration_2024/dump.sql': 'IGNORED',
			'/saucal_migration_staging/dump.sql': 'IGNORED',
			'/keep.php': 'SENT',
		},
		remote: {
			'/saucal_migration_2024/dump.sql': 'KEPT',
			'/orphan.php': 'DELETED',
		},
	},
	{
		name: 'fleet: a wildcard directory segment still needs its literal prefix',
		rules: '/saucal_migration_*/',
		local: [ '/keep.php' ],
		send: {
			'/saucal_migration/dump.sql': 'SENT',
			'/migration_2024/dump.sql': 'SENT',
		},
	},
	{
		// `/mu-plugins/*`, `/plugins/*`, `/themes/*`, `/*`.
		name: 'fleet: a glob-only segment prunes the whole subtree, not just one level',
		rules: '/mu-plugins/*',
		local: [ '/keep.php' ],
		send: {
			'/mu-plugins/loader.php': 'IGNORED',
			'/mu-plugins/nested/deep.php': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: a double-star rule excludes the whole subtree and protects it remotely',
		rules: '/vendor/**',
		local: [ '/keep.php' ],
		send: {
			'/vendor/autoload.php': 'IGNORED',
			'/vendor/acme/lib/src/Thing.php': 'IGNORED',
			'/keep.php': 'SENT',
		},
		remote: {
			'/vendor/autoload.php': 'KEPT',
			'/vendor/acme/lib/src/Thing.php': 'KEPT',
			'/orphan.php': 'DELETED',
		},
	},
	{
		name: 'fleet: a mid-path double star spans any number of segments',
		rules: '/plugins/example-plugin/vendor/**/README.md',
		local: [ '/keep.php' ],
		send: {
			'/plugins/example-plugin/vendor/acme/README.md': 'IGNORED',
			'/plugins/example-plugin/vendor/acme/lib/README.md': 'IGNORED',
			'/plugins/example-plugin/vendor/acme/Thing.php': 'SENT',
		},
	},
	{
		name: 'fleet: a character class behaves like a shell glob',
		rules: '/debug.log.[0-9]*',
		local: [ '/keep.php' ],
		send: {
			'/debug.log.1': 'IGNORED',
			'/debug.log.12': 'IGNORED',
			'/debug.log.old': 'SENT',
		},
	},
	{
		name: 'fleet: a negated file is re-included out of a starred directory',
		rules: '/mu-plugins/*\n!/mu-plugins/z-client-loader.php',
		local: [ '/keep.php' ],
		filter: '+ /mu-plugins/z-client-loader.php\n- /mu-plugins/*',
		send: {
			'/mu-plugins/z-client-loader.php': 'SENT',
			'/mu-plugins/vendor-thing.php': 'IGNORED',
			'/keep.php': 'SENT',
		},
		remote: {
			'/mu-plugins/z-client-loader.php': 'OVERWRITTEN',
			'/mu-plugins/vendor-thing.php': 'KEPT',
			'/orphan.php': 'DELETED',
		},
	},
	{
		// `!dir/` gains a `***` suffix so the subtree returns.
		name: 'fleet: a negated directory gets *** so its entire subtree comes back',
		rules: '/mu-plugins/*\n!/mu-plugins/http-concat/',
		local: [ '/keep.php' ],
		filter: '+ /mu-plugins/http-concat/***\n- /mu-plugins/*',
		send: {
			'/mu-plugins/http-concat/loader.php': 'SENT',
			'/mu-plugins/http-concat/nested/deep.php': 'SENT',
			'/mu-plugins/other.php': 'IGNORED',
		},
	},
	{
		// The fleet writes `!dir/` AFTER the narrow excludes it has to beat. The formatter
		// re-sorts by specificity, so source order does not matter -- this is what makes
		// those lists work at all.
		name: 'fleet: a negation written after its exclude is re-sorted ahead of it',
		rules: '/mu-plugins/*\n!/mu-plugins/z-client-loader.php',
		local: [ '/keep.php' ],
		send: { '/mu-plugins/z-client-loader.php': 'SENT' },
	},
	{
		name: 'fleet: the same pair written in the opposite order gives the same result',
		rules: '!/mu-plugins/z-client-loader.php\n/mu-plugins/*',
		local: [ '/keep.php' ],
		filter: '+ /mu-plugins/z-client-loader.php\n- /mu-plugins/*',
		send: { '/mu-plugins/z-client-loader.php': 'SENT' },
	},
	{
		// The whitelist shape: `/*` catch-all, carve a directory back in, re-exclude inside
		// it, then carve deeper directories back in.
		name: 'fleet: the whitelist shape -- catch-all, carve back in, re-exclude',
		rules: WHITELIST,
		local: [ '/wp-content/plugins/example-plugin/main.php' ],
		send: {
			'/wp-content/plugins/example-plugin/main.php': 'SENT',
			'/wp-content/themes/acme/style.css': 'SENT',
			'/wp-content/mu-plugins/loader.php': 'SENT',
			'/wp-content/uploads/2024/a.jpg': 'IGNORED',
			'/wp-content/cache/page.html': 'IGNORED',
			'/wp-content/advanced-cache.php': 'IGNORED',
			'/wp-content/debug.log': 'IGNORED',
			'/wp-content/object-cache.php': 'IGNORED',
			'/vendor/autoload.php': 'IGNORED',
			'/composer.json': 'IGNORED',
			'/wp-admin/index.php': 'IGNORED',
			'/index.php': 'IGNORED',
			'/.git/config': 'IGNORED',
		},
	},
	{
		name: 'fleet: the whitelist shape protects the entire remote outside its carve-out',
		rules: WHITELIST,
		local: [ '/wp-content/plugins/example-plugin/main.php' ],
		remote: {
			'/wp-admin/index.php': 'KEPT',
			'/wp-includes/version.php': 'KEPT',
			'/wp-content/uploads/legacy.jpg': 'KEPT',
			'/wp-content/plugins/example-plugin/main.php': 'OVERWRITTEN',
			'/wp-content/plugins/removed-plugin/main.php': 'DELETED',
		},
	},
	{
		// sortRules() breaks equal-specificity ties by reverse source order.
		name: 'fleet: equal-specificity rules come out in reverse source order',
		rules: '/plugins/example-plugin/\n!/plugins/example-plugin/',
		local: [ '/keep.php' ],
		filter: '+ /plugins/example-plugin/***\n- /plugins/example-plugin/',
		send: { '/plugins/example-plugin/main.php': 'SENT' },
		note: 'The tie-break is explicit (reverse authoring order) and puts the last-written of ' +
			'two equally specific rules first, so the last line wins -- which is git\'s rule too.',
	},
	{
		name: 'fleet: swapping two equal-specificity rules flips the outcome',
		rules: '!/plugins/example-plugin/\n/plugins/example-plugin/',
		local: [ '/keep.php' ],
		filter: '- /plugins/example-plugin/\n+ /plugins/example-plugin/***',
		send: { '/plugins/example-plugin/main.php': 'IGNORED' },
		note: 'Same tie, other order: the last-written rule wins again, exactly as it would ' +
			'in git.',
	},
	{
		// A repeated line, usually because the extra list restates a default.
		name: 'fleet: a duplicated rule is harmless',
		rules: '/uploads/\n/vendor/\n/uploads/',
		local: [ '/keep.php' ],
		send: { '/uploads/a.jpg': 'IGNORED', '/vendor/x.php': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		// A directory named without a trailing slash still excludes the directory.
		name: 'fleet: a directory written without a trailing slash still excludes it',
		rules: '/logs\n/webp-express',
		local: [ '/keep.php' ],
		send: {
			'/logs/today.log': 'IGNORED',
			'/webp-express/cache/a.webp': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		// The negation form without a trailing slash gets no `***`, yet the subtree still
		// arrives, because the catch-all it is fighting only matches one level down.
		name: 'fleet: a negation without a trailing slash still lets the subtree through',
		rules: '/themes/*\n!/themes/acme',
		local: [ '/keep.php' ],
		filter: '+ /themes/acme\n- /themes/*',
		send: {
			'/themes/acme/style.css': 'SENT',
			'/themes/twentytwenty/style.css': 'IGNORED',
		},
		note: 'Correct for what was written: `!/themes/acme` has no trailing slash, so it ' +
			'becomes a bare `+ /themes/acme` with no `***`. It works because `- /themes/*` ' +
			'cannot match anything deeper than one segment; against a `**` catch-all the same ' +
			'rule would re-include the directory entry and nothing inside it.',
	},
	{
		name: 'fleet: the shipped default ignore list',
		rules: DEFAULT_LIST,
		local: [ '/keep.php' ],
		send: {
			'/.git/config': 'IGNORED',
			// Anchored since PR #23: a vendored .gitignore inside a plugin is deployed.
			'/plugins/example-plugin/.gitignore': 'SENT',
			'/README.md': 'IGNORED',
			'/index.php': 'IGNORED',
			'/plugins/index.php': 'IGNORED',
			'/uploads/2024/a.jpg': 'IGNORED',
			'/debug.log': 'IGNORED',
			'/vendor/autoload.php': 'IGNORED',
			'/composer.lock': 'IGNORED',
			'/object-cache.php': 'IGNORED',
			'/plugins/wp-rocket/licence-data.php': 'IGNORED',
			'/saucal_migration_2024/dump.sql': 'IGNORED',
			'/plugins/example-plugin/main.php': 'SENT',
			'/themes/acme/style.css': 'SENT',
			'/plugins/example-plugin/vendor/autoload.php': 'SENT',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: an appended extra list layers on top of the default list',
		rules: DEFAULT_LIST + '\n' + [
			'/languages/',
			'/plugins-off/',
			'/mu-plugins/*',
			'!/mu-plugins/z-client-loader.php',
			'/debug.log*',
		].join( '\n' ),
		local: [ '/keep.php' ],
		send: {
			'/languages/en.mo': 'IGNORED',
			'/mu-plugins/vendor-thing.php': 'IGNORED',
			'/mu-plugins/z-client-loader.php': 'SENT',
			'/debug.log.1': 'IGNORED',
			'/uploads/a.jpg': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		// parse() drops `#` lines itself, so every caller -- not only main.js -- gets the
		// comment stripped. Before #22 the formatter emitted "- # ..." for it.
		name: 'fleet: the formatter drops a comment line',
		rules: '# WordPress core directories\n/uploads/',
		local: [ '/keep.php' ],
		filter: '- /uploads/',
		send: { '/uploads/a.jpg': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: the manifest check forgives a wildcard-directory-segment path',
		rules: '/saucal_migration_*/\n/uploads/',
		manifest: {
			git: '+ plugins/example-plugin/main.php\n+ saucal_migration_2024/dump.sql\n+ uploads/a.jpg\n',
			rsync: 'plugins/example-plugin/main.php\n',
			expect: 'MATCH',
		},
	},

	// ------------------------------------------------------------------
	// PART B -- hostile and degenerate input
	// ------------------------------------------------------------------

	{
		name: 'fleet: hostile -- a rule that is only "!" is dropped and the deploy runs',
		rules: '/uploads/\n!\n/vendor/',
		local: [ '/keep.php' ],
		// Before #22 this emitted a bare "+ ", rsync refused the filter file and exited 1.
		// The remote pass asserts exit 0: the orphan is deleted, the excludes still protect.
		filter: '- /vendor/\n- /uploads/',
		remote: { '/orphan.php': 'DELETED', '/uploads/legacy.jpg': 'KEPT', '/vendor/x.php': 'KEPT' },
	},
	{
		name: 'fleet: hostile -- "!" followed by whitespace is dropped the same way',
		rules: '! ',
		local: [ '/keep.php' ],
		filter: '',
		remote: { '/orphan.php': 'DELETED' },
	},
	{
		name: 'fleet: hostile -- a lone "!/" re-includes everything and voids the rest of the list',
		rules: '!/\n/uploads/\n/vendor/',
		local: [ '/keep.php' ],
		filter: '- /vendor/\n- /uploads/\n+ /***',
		send: { '/keep.php': 'SENT', '/uploads/a.jpg': 'IGNORED', '/vendor/x.php': 'IGNORED' },
		note: '"!/" scores 0 and expands to "+ /***", but it sorts last, so it only matches ' +
			'what no other rule already decided -- and unmatched paths are sent anyway. The ' +
			'dry run is identical with and without it; the name overstates the effect.',
	},
	{
		name: 'fleet: hostile -- a lone "*" excludes everything and deletes nothing',
		rules: '*',
		local: [ '/keep.php' ],
		send: { '/keep.php': 'IGNORED', '/plugins/example-plugin/main.php': 'IGNORED' },
		remote: { '/orphan.php': 'KEPT' },
	},
	{
		name: 'fleet: hostile -- "***" and "**/*" also swallow the whole transfer',
		rules: '***',
		local: [ '/keep.php' ],
		send: { '/keep.php': 'IGNORED' },
		remote: { '/orphan.php': 'KEPT' },
	},
	{
		// "#" is a comment and a lone "\" escapes nothing, so both are dropped.
		name: 'fleet: hostile -- punctuation-only rules are inert, "#" and "\\" are dropped',
		rules: '/\n-\n+\n#\n\\',
		local: [ '/keep.php' ],
		filter: '- +\n- -\n- /',
		send: {
			'/keep.php': 'SENT',
			'/plugins/example-plugin/main.php': 'SENT',
		},
	},
	{
		name: 'fleet: hostile -- whitespace-only and empty lists produce an empty filter',
		rules: ' \n\t\n\n   \n',
		local: [ '/keep.php' ],
		filter: '',
		send: { '/keep.php': 'SENT', '/uploads/a.jpg': 'SENT' },
	},
	{
		name: 'fleet: hostile -- a list of nothing but newlines produces an empty filter',
		rules: '\n\n\n\n',
		local: [ '/keep.php' ],
		filter: '',
		send: { '/keep.php': 'SENT' },
		remote: { '/orphan.php': 'DELETED' },
	},
	{
		name: 'fleet: hostile -- rsync filter syntax "- /foo" pasted into a gitignore list',
		rules: '- /uploads/',
		local: [ '/keep.php' ],
		filter: '- - /uploads/',
		send: { '/uploads/a.jpg': 'SENT', '/keep.php': 'SENT' },
		remote: { '/uploads/legacy.jpg': 'DELETED' },
		note: 'The list is gitignore-flavoured, and git reads "- /uploads/" literally too: a ' +
			'pattern for a file named "- /uploads/". The uploads are only exposed to ' +
			'--delete when a force-ignore list replaces the default list, which already ' +
			'excludes /uploads/.',
	},
	{
		name: 'fleet: hostile -- rsync filter syntax "+ /foo" is not a negation',
		rules: '/uploads/\n+ /uploads/keep-me.jpg',
		local: [ '/keep.php' ],
		send: { '/uploads/keep-me.jpg': 'IGNORED', '/keep.php': 'SENT' },
		note: 'A "+ " line does not start with "!", so it is an exclude for a file literally ' +
			'named "+ /uploads/keep-me.jpg" -- the same reading git gives it.',
	},
	{
		name: 'fleet: hostile -- a "!" inside a rule is literal, only a leading one negates',
		rules: '/plugins/we!rd-plugin/',
		local: [ '/keep.php' ],
		// Before #22 the first bang anywhere was deleted and this became /plugins/werd-plugin/.
		filter: '- /plugins/we!rd-plugin/',
		send: {
			'/plugins/we!rd-plugin/main.php': 'IGNORED',
			'/plugins/werd-plugin/main.php': 'SENT',
		},
	},
	{
		name: 'fleet: hostile -- "!!" leaves a literal bang as an include pattern',
		rules: '!!important/',
		local: [ '/keep.php' ],
		filter: '+ !important/***',
		send: { '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- a rule of 1024 characters is silently discarded by rsync',
		rules: OVERLONG + '\n/uploads/',
		local: [ '/keep.php' ],
		send: { '/uploads/a.jpg': 'IGNORED', '/keep.php': 'SENT' },
		remote: { '/orphan.php': 'DELETED' },
		bug: 'rsync caps a filter pattern at 1023 characters; anything longer is dropped ' +
			'with a "discarding over-long filter" line on stderr and an exit status of 0. ' +
			'The action never reads that stderr, so an over-long rule just stops applying.',
	},
	{
		name: 'fleet: hostile -- an over-long negation collapses a whitelist to nothing',
		rules: '/*\n!' + OVERLONG + '/',
		local: [ '/keep.php' ],
		send: { '/keep.php': 'IGNORED' },
		note: 'The same 1023-character cap applies on the include side, but this case does ' +
			'not show harm: /keep.php is excluded by "/*" with or without the carve-out, and ' +
			'a real path that long is implausible. The over-long exclude case covers the defect.',
	},
	{
		name: 'fleet: hostile -- the same whitelist with a short negation still works',
		rules: '/*\n!/wp-content/',
		local: [ '/keep.php' ],
		send: { '/wp-content/plugins/example-plugin/main.php': 'SENT', '/keep.php': 'IGNORED' },
	},
	{
		name: 'fleet: hostile -- 20000 rules still complete',
		rules: MANY_RULES,
		local: [ '/keep.php' ],
		send: { '/plugin-7/main.php': 'IGNORED', '/plugin-19999/main.php': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- a pathological glob',
		rules: '/a*/b*/c*/d*/e*',
		local: [ '/keep.php' ],
		send: {
			'/alpha/bravo/charlie/delta/echo.php': 'IGNORED',
			'/alpha/bravo/charlie/echo.php': 'SENT',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: hostile -- a 60-segment nested path rule',
		rules: '/' + DEEP_DIRS + '/',
		local: [ '/keep.php' ],
		send: {
			[ '/' + DEEP_DIRS + '/buried.php' ]: 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: hostile -- a literal backslash-n is not a newline',
		rules: '/uploads\\nvendor/',
		local: [ '/keep.php' ],
		filter: '- /uploads\\nvendor/',
		send: { '/uploads/a.jpg': 'SENT', '/vendor/x.php': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- BEL and ESC pass through untouched',
		rules: '/uploads' + BEL + '/\n/vendor' + ESC + '/',
		local: [ '/keep.php' ],
		filter: '- /vendor' + ESC + '/\n- /uploads' + BEL + '/',
		send: { '/uploads/a.jpg': 'SENT', '/vendor/x.php': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- CRLF line endings are trimmed away',
		rules: '/uploads/\r\n/vendor/\r\n',
		local: [ '/keep.php' ],
		filter: '- /vendor/\n- /uploads/',
		send: { '/uploads/a.jpg': 'IGNORED', '/vendor/x.php': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- a list with no trailing newline is fine',
		rules: '/uploads/\n/vendor/',
		local: [ '/keep.php' ],
		filter: '- /vendor/\n- /uploads/',
		send: { '/uploads/a.jpg': 'IGNORED', '/vendor/x.php': 'IGNORED' },
	},
	{
		name: 'fleet: hostile -- trailing whitespace on a rule is trimmed',
		rules: '/uploads/   \n\t/vendor/\t',
		local: [ '/keep.php' ],
		filter: '- /vendor/\n- /uploads/',
		send: { '/uploads/a.jpg': 'IGNORED', '/vendor/x.php': 'IGNORED' },
	},
	{
		name: 'fleet: hostile -- an interior space is preserved and matches',
		rules: '/my uploads/',
		local: [ '/keep.php' ],
		filter: '- /my uploads/',
		send: { '/my uploads/a.jpg': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- emoji in a pattern match an emoji directory',
		rules: '/\u{1F680}-deploy/',
		local: [ '/keep.php' ],
		send: { '/\u{1F680}-deploy/a.php': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- an RTL override is just another character in the pattern',
		rules: '/' + RLO + 'uploads/',
		local: [ '/keep.php' ],
		send: { '/uploads/a.jpg': 'SENT', [ '/' + RLO + 'uploads/a.jpg' ]: 'IGNORED' },
		note: 'Byte-exact matching, the same as git. The rule may render as if it excluded ' +
			'/uploads/, but the ignore list is trusted workflow config, not user input.',
	},
	{
		name: 'fleet: hostile -- a Cyrillic homoglyph silently matches nothing',
		rules: '/vend\u043er/',
		local: [ '/keep.php' ],
		send: { '/vendor/autoload.php': 'SENT', '/keep.php': 'SENT' },
		note: 'Byte-exact matching, the same as git: a lookalike character is a different ' +
			'pattern. The ignore list is trusted workflow config.',
	},
	{
		name: 'fleet: hostile -- a zero-width space silently disables a rule',
		rules: '/uplo' + ZWSP + 'ads/',
		local: [ '/keep.php' ],
		send: { '/uploads/a.jpg': 'SENT', '/keep.php': 'SENT' },
		remote: { '/uploads/legacy.jpg': 'DELETED' },
		note: 'Byte-exact matching, the same as git: an invisible character makes a different ' +
			'pattern, so the exclude matches nothing and --delete reaches /uploads/. The ' +
			'ignore list is trusted workflow config.',
	},
	{
		name: 'fleet: hostile -- a rule naming the filter file cannot reach it',
		rules: 'rules',
		local: [ '/keep.php' ],
		send: { '/rules': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- re-including .git ships repository metadata to the server',
		rules: '/*\n!.git',
		local: [ '/keep.php' ],
		filter: '+ .git\n- /*',
		send: { '/.git/config': 'SENT', '/.git/refs/heads/main': 'SENT', '/keep.php': 'IGNORED' },
		note: 'git also un-ignores .git for this list; the author has to write `!.git` on ' +
			'purpose. The include has no "***" (no trailing slash), but "- /*" cannot match ' +
			'below the root, so every file inside .git follows the directory.',
	},
	{
		name: 'fleet: hostile -- doubled slashes never match',
		rules: '//uploads//',
		local: [ '/keep.php' ],
		send: { '/uploads/a.jpg': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- ".." segments are not resolved',
		rules: '/plugins/../uploads/',
		local: [ '/keep.php' ],
		send: { '/uploads/a.jpg': 'SENT', '/keep.php': 'SENT' },
	},
	{
		name: 'fleet: hostile -- an unclosed character class and brace expansion are inert',
		rules: '/debug.log.[0-9\n/plugins/{a,b}/',
		local: [ '/keep.php' ],
		send: {
			'/debug.log.1': 'SENT',
			'/plugins/a/main.php': 'SENT',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'fleet: hostile -- "?" matches exactly one character',
		rules: '/debug.log.?',
		local: [ '/keep.php' ],
		send: { '/debug.log.1': 'IGNORED', '/debug.log.12': 'SENT' },
	},
];
