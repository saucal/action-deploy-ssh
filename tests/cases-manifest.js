// Characterisation of the MANIFEST RECONCILIATION step.
//
// The step: build-to-git emits a git manifest of '+ path' (added/modified) and
// '- path' (deleted) lines. The rsync dry-run emits plain paths (will transfer) and
// 'deleting path' lines. check-against-manifest.sh strips those markers, filters git's
// additions and deletions through two gitignore views of the rules (not-sent,
// not-deleted) and rsync's deletions through a third (hidden) with one
// `git check-ignore --stdin` per view, sorts both sides, and diffs. Any difference fails
// the deploy. rsync's transfers are never filtered.
//
// Every case below was RUN first and asserts the result that actually came back.
// Where that result is wrong, the case carries a `bug:` note and still asserts the
// current behaviour, so the suite stays green until someone changes the code on
// purpose.

const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { execFileSync } = require( 'child_process' );

const ACTION_DIR = path.join( __dirname, '..' );

// ---------------------------------------------------------------------------
// pinEqual: assert an arbitrary value that is not a MATCH/MISMATCH -- what the script
// leaves on disk, or a path rewrite main.js does before the script is called.
// `actual` is a function, so any scripts it runs execute per case, not at load time.
function pinEqual( name, actual, expected, extra ) {
	return Object.assign( {
		name: name,
		check: function () {
			const got = JSON.stringify( actual() );
			if ( got !== JSON.stringify( expected ) ) {
				throw new Error( 'want ' + JSON.stringify( expected ) + ', got ' + got );
			}
		},
	}, extra || {} );
}

// ---------------------------------------------------------------------------
// Run check-against-manifest.sh in a git repo we seed and then INSPECT afterwards.
// harness.reconcile() deletes its work dir, so it cannot answer "what did the script
// leave behind". Before #22 the script moved .gitignore aside and restored it; these
// cases pin that it now leaves both files alone. The raw list is passed as the not-sent
// view -- it is already valid gitignore, and only the files on disk are inspected.
function gitignoreAfter( seed, ignoreList ) {
	const work = fs.mkdtempSync( path.join( os.tmpdir(), 'deploy-gitignore-' ) );
	execFileSync( 'git', [ '-C', work, 'init', '-q' ] );
	Object.entries( seed ).forEach( ( e ) => fs.writeFileSync( path.join( work, e[ 0 ] ), e[ 1 ] ) );
	fs.writeFileSync( path.join( work, 'git-manifest' ), '+ a.php\n' );
	fs.writeFileSync( path.join( work, 'rsync-manifest' ), 'a.php\n' );

	try {
		execFileSync( 'bash', [ path.join( ACTION_DIR, 'check-against-manifest.sh' ) ], {
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
			env: Object.assign( {}, process.env, {
				GITHUB_WORKSPACE: work,
				PATH_DIR: '',
				GIT_MANIFEST: path.join( work, 'git-manifest' ),
				RSYNC_MANIFEST: path.join( work, 'rsync-manifest' ),
				SSH_IGNORE_LIST: String( ignoreList ),
			} ),
		} );
	} catch ( e ) {
		// A mismatch exits 1; irrelevant here, we only want the filesystem after.
	}

	const after = {};
	[ '.gitignore', '.gitignore.bak' ].forEach( ( f ) => {
		const full = path.join( work, f );
		after[ f ] = fs.existsSync( full ) ? fs.readFileSync( full, 'utf8' ) : null;
	} );
	fs.rmSync( work, { recursive: true, force: true } );
	return after;
}

// ---------------------------------------------------------------------------
// Subdirectory deploys: main.js scopes the repo-rooted git manifest to the deploy root
// (drops paths outside it, strips the prefix from the rest), and the script compares it
// with rsync's plan using the ignore rules exactly as written. No rule is rewritten.
const formatter = require( path.join( ACTION_DIR, 'rsyncRulesFormatter' ) );
const h = require( './harness' );
const scope = ( text, prefix ) => formatter.scopeManifest( text, prefix );

// Scale fixtures.
function bigManifest( n ) {
	let git = '';
	let rsync = '';
	for ( let i = 0; i < n; i++ ) {
		git += '+ plugins/p' + i + '/file.php\n';
		rsync += 'plugins/p' + i + '/file.php\n';
	}
	return { git: git, rsync: rsync };
}
const BIG_FILTERED = bigManifest( 100 );
const BIG_PLAIN = bigManifest( 3000 );

module.exports = [

	// -----------------------------------------------------------------------
	// 1. The happy paths.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: identical sides match',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a pure addition matches',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n+ plugins/b.php\n',
			rsync: 'plugins/a.php\nplugins/b.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a pure modification is indistinguishable from an addition',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a pure deletion matches its rsync deleting line',
		manifest: {
			ignore: '/vendor/',
			git: '- plugins/gone.php\n',
			rsync: 'deleting plugins/gone.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a mix of add, modify and delete matches',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n+ themes/t/style.css\n- plugins/gone.php\n',
			rsync: 'plugins/a.php\nthemes/t/style.css\ndeleting plugins/gone.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: rsync touching a file the build never declared fails the deploy',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\nthemes/surprise.css\n',
			expect: 'MISMATCH',
		},
	},
	{
		name: 'manifest: a declared file rsync would not send fails the deploy',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n',
			rsync: '',
			expect: 'MISMATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 2. Direction blindness. The markers are stripped before comparison, so the
	//    script compares path SETS, never the change type.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: git says DELETED, rsync says UPLOAD -- still a match',
		manifest: {
			ignore: '/vendor/',
			git: '- plugins/a.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
		note: 'A latent weakness, not a live defect: sed strips "+ "/"- " and "deleting " ' +
			'before the diff, so only the path set is compared. It cannot bite, because ' +
			'rsync cannot upload a path the build removed -- it is absent from the source.',
	},
	{
		name: 'manifest: git says ADDED, rsync says DELETING -- still a match',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n',
			rsync: 'deleting plugins/a.php\n',
			expect: 'MATCH',
		},
		note: 'Mirror of the case above, equally latent: rsync only deletes a path that is ' +
			'absent from the source, and a path the build added is present in it.',
	},
	{
		name: 'manifest: a path both sent and deleted by rsync matches a two-line git manifest',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n- plugins/a.php\n',
			rsync: 'plugins/a.php\ndeleting plugins/a.php\n',
			expect: 'MATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 3. The ignore list -- applied to git's side, and to rsync's DELETIONS only via
	//    the hidden view. rsync's transfers are never filtered.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: an excluded path on the git side is forgiven',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n+ vendor/autoload.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: an excluded path on the RSYNC side is NOT forgiven',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\nvendor/autoload.php\n',
			expect: 'MISMATCH',
		},
		note: 'Correct: rsync already applied the same list as its --filter, so its plan is ' +
			'ground truth and needs no second filtering. A vendor path in it means rsync ' +
			'really would touch it.',
	},
	{
		name: 'manifest: an empty ignore list forgives nothing',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\n+ vendor/autoload.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MISMATCH',
		},
	},
	{
		name: 'manifest: an empty ignore list on otherwise-equal sides still matches',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: the literal string "false" is a PATTERN, not a sentinel',
		manifest: {
			ignore: 'false',
			git: '+ plugins/a.php\n+ false\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
		note: 'Correct division of labour: main.js resolves the `false` sentinel to ' +
			'default-ignore.txt before the script runs, and the script itself treats "false" ' +
			'as a literal pattern. Pinned so the sentinel handling is known to live only in ' +
			'main.js.',
	},
	{
		name: 'manifest: an ignore list of only comments filters nothing',
		manifest: {
			ignore: '# just a comment\n# and another',
			git: '+ plugins/a.php\n+ vendor/autoload.php\n',
			rsync: 'plugins/a.php\nvendor/autoload.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: an ignore list of only comments does NOT forgive vendor',
		manifest: {
			ignore: '# vendor is handled elsewhere\n',
			git: '+ vendor/autoload.php\n',
			rsync: '',
			expect: 'MISMATCH',
		},
	},
	{
		name: 'manifest: a bare newline ignore list filters nothing',
		manifest: {
			ignore: '\n',
			git: '+ vendor/autoload.php\n',
			rsync: 'vendor/autoload.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a whitespace-only ignore line matches nothing',
		manifest: {
			ignore: ' \n',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: an ignore pattern that matches nothing leaves both sides alone',
		manifest: {
			ignore: 'zzz-matches-nothing\n',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 4. Negation.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: a negation NOT under an excluded directory re-includes correctly',
		manifest: {
			ignore: '/*.log\n!/keep.log\n',
			git: '+ keep.log\n+ drop.log\n',
			rsync: 'keep.log\n',
			expect: 'MATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 5. Directory lines in the rsync output.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: rsync directory lines are dropped',
		manifest: {
			ignore: '',
			git: '+ plugins/deep/a.php\n',
			rsync: 'plugins/\nplugins/deep/\nplugins/deep/a.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a DIRECTORY named like a file is dropped too',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\nthemes/styles.css/\n',
			expect: 'MATCH',
		},
		note: 'Correct outcome by a textual rule: `grep -v \'/$\'` just means "ends in a ' +
			'slash". Safe because rsync always emits a trailing slash for directories and ' +
			'never for files. Pinned because the check is textual, not semantic.',
	},
	{
		name: 'manifest: a git-side line ending in a slash is NOT dropped',
		manifest: {
			ignore: '',
			git: '+ somedir/\n',
			rsync: '',
			expect: 'MISMATCH',
		},
		note: 'Asymmetry pinned for the record: the directory strip runs on the rsync file ' +
			'only, so a git-side directory line would fail the deploy. build-to-git does not ' +
			'emit directory lines, so this is latent.',
	},
	{
		name: 'manifest: the git-side slash line survives the ignore filter too',
		manifest: {
			ignore: 'vendor\n',
			git: '+ somedir/\n',
			rsync: '',
			expect: 'MISMATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 6. 'deleting' lines.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: a deleting line with a matching git deletion matches',
		manifest: {
			ignore: '',
			git: '- plugins/gone.php\n',
			rsync: 'deleting plugins/gone.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a deleting line with no git-side counterpart fails the deploy',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\ndeleting themes/orphan.css\n',
			expect: 'MISMATCH',
		},
	},
	{
		name: 'manifest: a file literally named "deleting a.php" being UPLOADED fails',
		manifest: {
			ignore: '',
			git: '+ deleting a.php\n',
			rsync: 'deleting a.php\n',
			expect: 'MISMATCH',
		},
		bug: 'rsync prints the upload of a file named "deleting a.php" as exactly ' +
			'"deleting a.php", which the script then reads as the deletion of "a.php". The prefix strip ' +
			'is unanchored to any notion of quoting, so the transfer of that file is ' +
			'read as the deletion of a different one.',
	},

	// -----------------------------------------------------------------------
	// 7. Hostile filenames. The marker strip removes a leading "+ " or "- ", so a
	//    filename beginning with the marker characters is the interesting family. Paths
	//    reach `git check-ignore` on stdin, never in the option position.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: a path with spaces round-trips',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/my plugin/main file.php\n',
			rsync: 'plugins/my plugin/main file.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a path with single and double quotes round-trips',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/we"ird\'s.php\n',
			rsync: 'plugins/we"ird\'s.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a path with a backslash round-trips',
		manifest: {
			ignore: '/vendor/',
			git: '+ plugins/back\\slash.php\n',
			rsync: 'plugins/back\\slash.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a unicode path round-trips',
		manifest: {
			ignore: '/vendor/',
			git: '+ café/über-日本.php\n',
			rsync: 'café/über-日本.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a file named -weird.php survives the marker strip (added)',
		manifest: {
			ignore: '',
			git: '+ -weird.php\n',
			rsync: '-weird.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a file named -weird.php survives the marker strip (deleted)',
		manifest: {
			ignore: '',
			git: '- -weird.php\n',
			rsync: 'deleting -weird.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a file named +plus.php survives the marker strip',
		manifest: {
			ignore: '',
			git: '+ +plus.php\n',
			rsync: '+plus.php\n',
			expect: 'MATCH',
		},
	},
	{
		// Before #22 the path was passed as an argument, git read "-weird.php" as an unknown
		// switch, and the crash counted as "not ignored" -- this was a MISMATCH.
		name: 'manifest: an ignore rule can exclude -weird.php',
		manifest: {
			ignore: '-weird.php\n',
			git: '+ -weird.php\n',
			rsync: '',
			expect: 'MATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 8. Structural edge cases in the manifest files themselves.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: a path listed TWICE on the git side fails the deploy',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\n+ plugins/a.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MISMATCH',
		},
		note: 'Latent: the comparison is `sort` without `-u`, so multiplicity matters, but ' +
			'build-to-git produces the manifest with `git diff-tree --no-renames -r`, which ' +
			'lists each path once.',
	},
	{
		name: 'manifest: a path listed TWICE on the rsync side fails the deploy',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\nplugins/a.php\n',
			expect: 'MISMATCH',
		},
	},
	{
		name: 'manifest: both manifests empty is a match',
		manifest: { ignore: '', git: '', rsync: '', expect: 'MATCH' },
	},
	{
		name: 'manifest: both manifests empty with an ignore list is a match',
		manifest: { ignore: '/vendor/\n', git: '', rsync: '', expect: 'MATCH' },
	},
	{
		name: 'manifest: an empty git manifest against a non-empty rsync plan fails',
		manifest: { ignore: '', git: '', rsync: 'plugins/a.php\n', expect: 'MISMATCH' },
	},
	{
		name: 'manifest: no trailing newline is harmless when the ignore list is empty',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\n+ plugins/b.php',
			rsync: 'plugins/a.php\nplugins/b.php\n',
			expect: 'MATCH',
		},
	},
	{
		// Before #22 a `while read` loop skipped the unterminated last line and this was a
		// MISMATCH.
		name: 'manifest: no trailing newline is harmless when an ignore list is set',
		manifest: {
			ignore: 'vendor\n',
			git: '+ plugins/a.php\n+ plugins/b.php',
			rsync: 'plugins/a.php\nplugins/b.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: CRLF on the git side alone fails the deploy',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\r\n',
			rsync: 'plugins/a.php\n',
			expect: 'MISMATCH',
		},
	},
	{
		name: 'manifest: CRLF on BOTH sides matches, carriage returns and all',
		manifest: {
			ignore: '',
			git: '+ plugins/a.php\r\n',
			rsync: 'plugins/a.php\r\n',
			expect: 'MATCH',
		},
		note: 'Passes because the \\r is carried identically into both sorted lists. Pinned ' +
			'because normalising line endings on one side only would turn a clean deploy ' +
			'into a total mismatch.',
	},
	{
		name: 'manifest: CRLF with an ignore list still fails',
		manifest: {
			ignore: 'vendor\n',
			git: '+ plugins/a.php\r\n',
			rsync: 'plugins/a.php\n',
			expect: 'MISMATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 9. Prefix siblings -- does filtering one path take its neighbour with it?
	//    It does not: check-ignore matches whole path components, not prefixes.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: an unanchored rule drops only the exact path, not its prefix sibling',
		manifest: {
			ignore: 'vendor/autoload.php\n',
			git: '+ vendor/autoload.php\n+ vendor/autoload.php.bak\n',
			rsync: 'vendor/autoload.php.bak\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: an anchored rule drops only the exact path, not its prefix sibling',
		manifest: {
			ignore: '/vendor/autoload.php\n',
			git: '+ vendor/autoload.php\n+ vendor/autoload.php.bak\n',
			rsync: 'vendor/autoload.php.bak\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: dropping the sibling instead would fail -- the filter really is exact',
		manifest: {
			ignore: '/vendor/autoload.php\n',
			git: '+ vendor/autoload.php\n+ vendor/autoload.php.bak\n',
			rsync: '',
			expect: 'MISMATCH',
		},
	},

	// -----------------------------------------------------------------------
	// 10. The checkout is not mutated. Before #22 the script did a
	//     `mv .gitignore .gitignore.bak` dance; it now uses core.excludesFile. These pin
	//     the state of the CHECKOUT after the script runs -- the deploy root is the same
	//     directory rsync pushes from moments later, so anything left behind ships.
	// -----------------------------------------------------------------------
	pinEqual(
		'manifest: with no .gitignore and an ignore list, the script creates none',
		() => gitignoreAfter( {}, '/vendor/\n/uploads/\n' ),
		{ '.gitignore': null, '.gitignore.bak': null }
	),
	pinEqual(
		'manifest: with a real .gitignore, its content is left untouched',
		() => gitignoreAfter( { '.gitignore': 'node_modules\n' }, '/vendor/\n' ),
		{ '.gitignore': 'node_modules\n', '.gitignore.bak': null }
	),
	pinEqual(
		'manifest: an existing .gitignore.bak is left untouched',
		() => gitignoreAfter(
			{ '.gitignore': 'node_modules\n', '.gitignore.bak': 'PRECIOUS ORIGINAL\n' },
			'/vendor/\n'
		),
		{ '.gitignore': 'node_modules\n', '.gitignore.bak': 'PRECIOUS ORIGINAL\n' }
	),
	pinEqual(
		'manifest: an empty ignore list leaves a real .gitignore completely untouched',
		() => gitignoreAfter( { '.gitignore': 'node_modules\n' }, '' ),
		{ '.gitignore': 'node_modules\n', '.gitignore.bak': null }
	),
	pinEqual(
		'manifest: an empty ignore list creates no .gitignore where there was none',
		() => gitignoreAfter( {}, '' ),
		{ '.gitignore': null, '.gitignore.bak': null }
	),

	// -----------------------------------------------------------------------
	// 11. Subdirectory deploys. The manifest is repo-rooted; rsync only ever sees the
	//     deploy root. main.js converts the manifest's PATHS once, instead of rewriting
	//     the rules, so the check and rsync use one set of rules in one coordinate system.
	// -----------------------------------------------------------------------
	pinEqual(
		'manifest: scoping keeps paths inside the deploy root and strips the prefix',
		() => scope( '+ wp-content/plugins/a.php\n- wp-content/themes/t/old.css\n', 'wp-content' ),
		'+ plugins/a.php\n- themes/t/old.css\n'
	),
	pinEqual(
		// The subdirectory-deploy bug: a composer update changes root files rsync never sees,
		// and the release used to be blocked until someone forced the deploy.
		'manifest: scoping drops paths outside the deploy root',
		() => scope( '+ composer.lock\n+ vendor/composer/installed.json\n+ wp-content/plugins/a.php\n', 'wp-content' ),
		'+ plugins/a.php\n'
	),
	pinEqual(
		'manifest: scoping matches the prefix by whole path segment',
		() => scope( '+ wp-content-old/x.php\n+ wp-content/x.php\n', 'wp-content' ),
		'+ x.php\n'
	),
	pinEqual(
		// build-to-git's diff-tree quotes non-ASCII names; the prefix sits inside the quotes.
		'manifest: scoping handles git-quoted paths',
		() => scope( '+ "wp-content/caf\\303\\251.php"\n+ "root-caf\\303\\251.txt"\n', 'wp-content' ),
		'+ "caf\\303\\251.php"\n'
	),
	pinEqual(
		'manifest: scoping handles a nested deploy root',
		() => scope( '+ site/wp-content/a.php\n+ site/other.php\n', 'site/wp-content' ),
		'+ a.php\n'
	),
	pinEqual(
		'manifest: scoping with no subdirectory changes nothing',
		() => scope( '+ composer.lock\n- plugins/a.php\n', '' ),
		'+ composer.lock\n- plugins/a.php\n'
	),
	{
		// End to end, env-local-root=<repo>/wp-content with "/*.log" plus "!/keep.log": the
		// scoped manifest and rsync's plan are both deploy-root relative, and the rules are
		// used as written.
		name: 'manifest: a scoped subdirectory manifest reconciles with the rules as written',
		check() {
			const res = h.reconcile(
				'/*.log\n!/keep.log\n',
				scope( '+ wp-content/keep.log\n+ wp-content/drop.log\n+ composer.lock\n', 'wp-content' ),
				'keep.log\n'
			);
			if ( ! res.match ) {
				throw new Error( 'expected MATCH\n' + res.output.split( '\n' ).slice( -10 ).join( '\n' ) );
			}
		},
	},

	// -----------------------------------------------------------------------
	// 12. Scale. Each view is one `git check-ignore --stdin` for the whole list.
	// -----------------------------------------------------------------------
	{
		name: 'manifest: a large manifest with an ignore list completes',
		manifest: {
			ignore: '/vendor/\n',
			git: BIG_FILTERED.git,
			rsync: BIG_FILTERED.rsync,
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: a large manifest with no ignore list completes',
		manifest: {
			ignore: '',
			git: BIG_PLAIN.git,
			rsync: BIG_PLAIN.rsync,
			expect: 'MATCH',
		},
	},
	{
		name: 'manifest: one bad line in a large manifest is still caught',
		manifest: {
			ignore: '',
			git: BIG_PLAIN.git,
			rsync: BIG_PLAIN.rsync + 'themes/surprise.css\n',
			expect: 'MISMATCH',
		},
	},
];
