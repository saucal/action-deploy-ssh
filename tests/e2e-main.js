#!/usr/bin/env node
// End-to-end characterisation of main.js itself.
//
// The case files test the formatter and the manifest script in isolation. This runs the
// REAL main.js -- real @actions/core input parsing, the real `rsync` npm package building
// the command string, the real @actions/exec re-parsing it -- against a local target.
//
// SSH is replaced by a fake `ssh` on PATH that behaves like the real one where it matters:
// it drops its own options and the host, joins the remote command into ONE string, and
// hands it to a shell to re-split. That is exactly how a remote sshd treats it, so remote
// quoting behaviour is preserved. Nothing touches the network.
//
//   node tests/e2e-main.js           all scenarios
//   node tests/e2e-main.js manifest  only scenarios whose name matches

const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { execFileSync, spawnSync } = require( 'child_process' );

const ACTION_DIR = path.join( __dirname, '..' );
const filter = process.argv[ 2 ];

function sh( cwd, cmd ) {
	return execFileSync( 'bash', [ '-c', cmd ], { cwd, encoding: 'utf8' } );
}

function write( root, rel, body ) {
	const full = path.join( root, rel );
	fs.mkdirSync( path.dirname( full ), { recursive: true } );
	fs.writeFileSync( full, body === undefined ? rel + '\n' : body );
}

function tree( root ) {
	const out = [];
	( function walk( d ) {
		for ( const e of fs.readdirSync( d, { withFileTypes: true } ) ) {
			const full = path.join( d, e.name );
			if ( e.isDirectory() ) {
				walk( full );
			} else {
				out.push( '/' + path.relative( root, full ) );
			}
		}
	} )( root );
	return out.sort();
}

// The manifest build-to-git produces for the last commit, using its exact pipeline
// (build-to-git/main.sh, STRICT_PERMS=false branch). Kept verbatim so a test fed by it
// sees the same quoting and whitespace handling production does.
const BUILD_TO_GIT_MANIFEST =
	'git diff-tree HEAD --no-commit-id --no-renames -r | ' +
	"awk '{output=\"\"; for (i = 6; i <= NF; i++) output = output (output == \"\" ? \"\" : OFS) $i; if( $3 != $4 ) print $5 \"\\t\" output; }' | " +
	"sed -E \"s/^[AMH]\\t/+ /\" | sed -E \"s/^[D]\\t/- /\"";

function scenario( opts ) {
	const ws = fs.mkdtempSync( path.join( os.tmpdir(), 'e2e-' ) );
	const built = path.join( ws, 'built' );
	const target = path.join( ws, 'target' + ( opts.remoteSuffix || '' ) );
	const bin = path.join( ws, 'bin' );
	const runnerTemp = path.join( ws, 'runner-temp' );
	fs.mkdirSync( built );
	fs.mkdirSync( target, { recursive: true } );
	fs.mkdirSync( bin );
	fs.mkdirSync( runnerTemp );
	// The runner creates this file before any step runs; @actions/core refuses to write outputs without it.
	fs.writeFileSync( path.join( runnerTemp, 'output' ), '' );

	fs.writeFileSync( path.join( bin, 'ssh' ), [
		'#!/bin/sh',
		'while [ $# -gt 0 ]; do',
		'  case "$1" in -p|-o|-i|-l|-F|-e) shift 2 ;; -*) shift ;; *) break ;; esac',
		'done',
		'shift # the host',
		'exec sh -c "$*"',
	].join( '\n' ) + '\n', { mode: 0o755 } );

	// The built repo: a previous build, then the build being deployed. build-to-git always
	// leaves a root .gitignore in it.
	sh( built, 'git init -q && git config user.email t@t && git config user.name t' );
	write( built, '/.gitignore', '# written by build-to-git\n' );
	( opts.previous || [] ).forEach( ( p ) => write( built, p ) );
	sh( built, 'git add -A && git commit -qm previous --allow-empty' );
	( opts.remove || [] ).forEach( ( p ) => fs.rmSync( path.join( built, p ), { recursive: true, force: true } ) );
	Object.entries( opts.build || {} ).forEach( ( [ p, body ] ) => write( built, p, body ) );
	( opts.symlinks || [] ).forEach( ( [ p, to ] ) => fs.symlinkSync( to, path.join( built, p ) ) );
	( ( opts.chmod || {} ).build || [] ).forEach( ( [ p, m ] ) => fs.chmodSync( path.join( built, p ), m ) );
	sh( built, 'git add -A && git commit -qm build --allow-empty' );

	// What is on the server before this deploy.
	if ( opts.targetFromPrevious ) {
		sh( ws, 'git -C built worktree add -q ../prev HEAD~1 && rsync -a --exclude=.git ' +
			JSON.stringify( 'prev/' + ( opts.localSub || '' ) ) + ' ' +
			JSON.stringify( target + '/' ) + ' && git -C built worktree remove --force ../prev' );
	}
	Object.entries( opts.target || {} ).forEach( ( [ p, body ] ) => write( target, p, body ) );
	( ( opts.chmod || {} ).target || [] ).forEach( ( [ p, m ] ) => fs.chmodSync( path.join( target, p ), m ) );

	let manifestPath = '';
	if ( opts.manifest ) {
		manifestPath = path.join( runnerTemp, 'git-manifest' );
		fs.writeFileSync( manifestPath, sh( built, BUILD_TO_GIT_MANIFEST ) );
	}

	const before = tree( target );
	const inputs = Object.assign( {
		'env-host': 'fakehost',
		'env-user': 'deploy',
		'env-port': '',
		'env-key': 'unused-by-the-fake-ssh',
		'env-pass': '',
		'env-local-root': 'built/' + ( opts.localSub || '' ),
		'env-remote-root': target,
		'force-ignore': 'false',
		'force-ignore-extra': 'false',
		'ssh-flags': '',
		'ssh-shell-params': '',
		'ssh-extra-options': '',
		'ssh-handle-perms': 'false',
		'consistency-check': '',
		manifest: manifestPath,
	}, opts.inputs || {} );

	const env = {
		PATH: bin + path.delimiter + process.env.PATH,
		HOME: ws,
		GITHUB_WORKSPACE: ws,
		RUNNER_TEMP: runnerTemp,
		GITHUB_OUTPUT: path.join( runnerTemp, 'output' ),
	};
	if ( opts.debug ) {
		// main.js only echoes rsync's dry-run lines when the runner is in debug mode.
		env.RUNNER_DEBUG = '1';
	}
	for ( const [ k, v ] of Object.entries( inputs ) ) {
		env[ 'INPUT_' + k.replace( / /g, '_' ).toUpperCase() ] = v;
	}

	const run = spawnSync( process.execPath, [ path.join( ACTION_DIR, 'main.js' ) ], {
		cwd: ws, env, encoding: 'utf8', timeout: 120000,
	} );

	// The drift diff main.js writes when a check fails (the diffPath output), read before cleanup.
	let driftDiff = '';
	const outputs = fs.readFileSync( path.join( runnerTemp, 'output' ), 'utf8' );
	const dm = outputs.match( /^diffPath<<(\S+)\n([\s\S]*?)\n\1$/m );
	if ( dm && fs.existsSync( dm[ 2 ] ) ) {
		for ( const f of fs.readdirSync( dm[ 2 ] ) ) {
			driftDiff += '### ' + f + '\n' + fs.readFileSync( path.join( dm[ 2 ], f ), 'utf8' ) + '\n';
		}
	}

	// Snapshot BEFORE cleanup: a lazy read after the workspace is gone makes every
	// "does not exist" assertion pass for free.
	const after = tree( target );
	const files = {};
	const modes = {};
	after.forEach( ( p ) => {
		files[ p ] = fs.readFileSync( path.join( target, p ), 'utf8' );
		modes[ p ] = ( fs.statSync( path.join( target, p ) ).mode & 0o777 ).toString( 8 );
	} );
	fs.rmSync( ws, { recursive: true, force: true } );
	return {
		code: run.status,
		out: ( run.stdout || '' ) + ( run.stderr || '' ),
		before,
		after,
		modes,
		driftDiff,
		content: ( p ) => {
			if ( ! ( p in files ) ) {
				throw new Error( p + ' is not on the target' );
			}
			return files[ p ];
		},
		exists: ( p ) => p in files,
	};
}

// ---------------------------------------------------------------------------------------

const scenarios = [];
function test( name, fn, meta ) {
	scenarios.push( Object.assign( { name, fn }, meta || {} ) );
}
function assert( cond, msg ) {
	if ( ! cond ) {
		throw new Error( msg );
	}
}
function show( r ) {
	return '\n--- exit ' + r.code + ', target after: ' + JSON.stringify( r.after ) +
		'\n--- output tail:\n' + r.out.split( '\n' ).slice( -15 ).join( '\n' );
}

test( 'deploy: plain push with the default list sends the build and deletes strays', () => {
	const r = scenario( {
		build: { '/plugins/acme/acme.php': 'v2', '/themes/t/style.css': 'css' },
		target: {
			'/plugins/acme/acme.php': 'v1',
			'/plugins/removed/old.php': 'stale',
			'/uploads/2024/photo.jpg': 'user upload',
			'/object-cache.php': 'dropin',
		},
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/plugins/acme/acme.php' ) === 'v2', 'acme.php not overwritten' + show( r ) );
	assert( r.exists( '/themes/t/style.css' ), 'new file not sent' + show( r ) );
	assert( ! r.exists( '/plugins/removed/old.php' ), 'stray not deleted' + show( r ) );
	assert( r.exists( '/uploads/2024/photo.jpg' ), 'default list must protect /uploads/' + show( r ) );
	assert( r.exists( '/object-cache.php' ), 'default list must protect /object-cache.php' + show( r ) );
	assert( ! r.exists( '/.gitignore' ), 'default list excludes /.gitignore' + show( r ) );
} );

test( 'deploy: force-ignore-extra is appended to the defaults, not a replacement', () => {
	const r = scenario( {
		build: { '/plugins/acme/acme.php': 'v2', '/plugins/acme/secret.log': 'x' },
		target: { '/uploads/a.jpg': 'u', '/keepme/data.json': 'server' },
		inputs: { 'force-ignore-extra': '/keepme/\n/plugins/acme/secret.log' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.exists( '/uploads/a.jpg' ), 'defaults dropped when extra was set' + show( r ) );
	assert( r.exists( '/keepme/data.json' ), 'extra rule not applied' + show( r ) );
	assert( ! r.exists( '/plugins/acme/secret.log' ), 'extra exclude sent the file' + show( r ) );
} );

test( 'deploy: force-ignore REPLACES the defaults entirely', () => {
	const r = scenario( {
		build: { '/plugins/acme/acme.php': 'v2' },
		target: { '/uploads/a.jpg': 'user upload' },
		inputs: { 'force-ignore': '/nothing-relevant/' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( ! r.exists( '/uploads/a.jpg' ), 'expected uploads to be deleted once defaults are replaced' + show( r ) );
}, { note: 'Correct but sharp: setting force-ignore drops default-ignore.txt, so /uploads/ is no longer protected.' } );

test( 'deploy: comments, blank lines and duplicate rules in the list are harmless', () => {
	const r = scenario( {
		build: { '/a.php': 'a' },
		target: { '/keep/x': 'server' },
		inputs: { 'force-ignore-extra': '# a comment\n\n/keep/\n/keep/\n   \n' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.exists( '/keep/x' ), 'rule lost among comments/dupes' + show( r ) );
} );

test( 'deploy: ssh-handle-perms=false does not change the mode of an existing file', () => {
	const r = scenario( {
		build: { '/bin/run.sh': 'same content' },
		target: { '/bin/run.sh': 'same content' },
		chmod: { build: [ [ '/bin/run.sh', 0o755 ] ], target: [ [ '/bin/run.sh', 0o644 ] ] },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.modes[ '/bin/run.sh' ] === '644', 'mode propagated: ' + r.modes[ '/bin/run.sh' ] + show( r ) );
} );

test( 'deploy: ssh-handle-perms=true does propagate the mode', () => {
	const r = scenario( {
		build: { '/bin/run.sh': 'same content' },
		target: { '/bin/run.sh': 'same content' },
		chmod: { build: [ [ '/bin/run.sh', 0o755 ] ], target: [ [ '/bin/run.sh', 0o644 ] ] },
		inputs: { 'ssh-handle-perms': 'true' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.modes[ '/bin/run.sh' ] === '755', 'mode not propagated: ' + r.modes[ '/bin/run.sh' ] + show( r ) );
} );

test( 'consistency-check: an in-sync target passes and nothing is written', () => {
	const r = scenario( {
		previous: [ '/plugins/acme/acme.php' ],
		build: { '/plugins/acme/acme.php': '/plugins/acme/acme.php\n' },
		targetFromPrevious: true,
		inputs: { 'consistency-check': 'true' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( JSON.stringify( r.before ) === JSON.stringify( r.after ), 'consistency check wrote to the target' + show( r ) );
} );

test( 'consistency-check: drift on the target fails and writes nothing', () => {
	const r = scenario( {
		previous: [ '/plugins/acme/acme.php' ],
		build: { '/plugins/acme/acme.php': '/plugins/acme/acme.php\n' },
		targetFromPrevious: true,
		target: { '/plugins/acme/hotfix.php': 'edited on the server' },
		inputs: { 'consistency-check': 'true' },
	} );
	assert( r.code === 1, 'expected exit 1, got ' + r.code + show( r ) );
	assert( JSON.stringify( r.before ) === JSON.stringify( r.after ), 'failed check still wrote' + show( r ) );
} );

test( 'manifest: a normal build reconciles and deploys', () => {
	const r = scenario( {
		previous: [ '/plugins/acme/acme.php', '/plugins/gone/gone.php' ],
		targetFromPrevious: true,
		remove: [ '/plugins/gone' ],
		build: { '/plugins/acme/acme.php': 'v2', '/plugins/new/new.php': 'n' },
		manifest: true,
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/plugins/acme/acme.php' ) === 'v2', 'not deployed' + show( r ) );
	assert( ! r.exists( '/plugins/gone/gone.php' ), 'deletion not applied' + show( r ) );
} );

test( 'manifest: drift the build did not declare blocks the deploy and writes nothing', () => {
	const r = scenario( {
		previous: [ '/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		target: { '/plugins/stray/stray.php': 'hand-placed' },
		build: { '/plugins/acme/acme.php': 'v2' },
		manifest: true,
	} );
	assert( r.code !== 0, 'expected a blocked deploy' + show( r ) );
	assert( JSON.stringify( r.before ) === JSON.stringify( r.after ), 'blocked deploy still wrote' + show( r ) );
} );

// ---- real defects, pinned as they behave today --------------------------------------

test( 'manifest: a changed file with a non-ASCII name blocks the deploy', () => {
	const r = scenario( {
		previous: [ '/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		build: { '/plugins/acme/café.php': 'new' },
		manifest: true,
		inputs: {},
	} );
	assert( r.code !== 0, 'expected the deploy to be blocked (today), got 0' + show( r ) );
	assert( /DO NOT MATCH/.test( r.out ), 'blocked, but not by the manifest mismatch' + show( r ) );
	assert( /"plugins\/acme\/caf\\303\\251\.php"/.test( r.out ), 'the mismatch is not the quoted name' + show( r ) );
}, { bug: 'build-to-git\'s git diff-tree quotes the path ("caf\\303\\251.php") while rsync prints it raw, so the two lists never reconcile and the site cannot deploy until the name changes.' } );

test( 'manifest: an added symlink blocks the deploy', () => {
	const r = scenario( {
		previous: [ '/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		build: { '/plugins/acme/base.php': 'b' },
		symlinks: [ [ '/plugins/acme/alias.php', 'base.php' ] ],
		manifest: true,
	} );
	assert( r.code !== 0, 'expected the deploy to be blocked (today), got 0' + show( r ) );
	assert( /DO NOT MATCH/.test( r.out ) && /alias\.php -> base\.php/.test( r.out ), 'blocked, but not by the symlink line' + show( r ) );
}, { bug: 'rsync lists a symlink as "alias.php -> base.php"; the manifest has "alias.php", so they never reconcile.' } );

test( 'consistency-check: a protected file inside a removed directory blocks every future check', () => {
	const base = {
		previous: [ '/plugins/acme/acme.php' ],
		build: { '/plugins/acme/acme.php': '/plugins/acme/acme.php\n' },
		targetFromPrevious: true,
		inputs: { 'consistency-check': 'true' },
		debug: true,
	};
	// Control: the same target without the leftover licence file is in sync.
	const control = scenario( base );
	assert( control.code === 0, 'control run should pass, exit ' + control.code + show( control ) );

	// WP Rocket was removed by an earlier deploy; only the file the default list protects is left.
	const r = scenario( Object.assign( {}, base, {
		target: { '/plugins/wp-rocket/licence-data.php': 'licence written by the plugin' },
	} ) );
	assert( r.code === 1, 'expected exit 1, got ' + r.code + show( r ) );
	assert( /cannot delete non-empty directory: plugins\/wp-rocket/.test( r.out ),
		'failed, but not because of the undeletable directory' + show( r ) );
}, { bug: 'default-ignore.txt protects /plugins/wp-rocket/licence-data.php, so once WP Rocket is removed from a build its directory can never be deleted. rsync prints "cannot delete non-empty directory" on stdout, main.js counts that line as a change, and the check fails on every run until the file is removed by hand.' } );

test( 'deploy: a remote root containing a space is split into two arguments', () => {
	const r = scenario( {
		build: { '/a.php': 'a' },
		remoteSuffix: ' dir',
	} );
	assert( r.code === 1, 'expected rsync to fail (today), exit ' + r.code + show( r ) );
	assert( ! r.exists( '/a.php' ), 'the push reached the target' + show( r ) );
	assert( /Unexpected remote arg: .*target\\\s*$/m.test( r.out ), 'failed, but not because the path was split' + show( r ) );
}, { bug: 'The rsync npm package escapes the space as "my\\ dir", which @actions/exec does not honour, so the path reaches rsync as two arguments.' } );

test( 'manifest: an anchored negation in a subdirectory deploy is re-rooted correctly', () => {
	const r = scenario( {
		previous: [ '/sub/keep.log', '/sub/a.php' ],
		targetFromPrevious: true,
		localSub: 'sub/',
		build: { '/sub/keep.log': 'changed', '/sub/a.php': 'changed' },
		manifest: true,
		inputs: { 'force-ignore': '/*.log\n!/keep.log' },
	} );
	assert( r.code === 0, 'expected the deploy to go through, exit ' + r.code + show( r ) );
	assert( r.content( '/keep.log' ) === 'changed', 'the re-included log was not deployed' + show( r ) );
} );

test( 'manifest: a subdirectory deploy is not blocked by a change outside the deploy root', () => {
	// A composer update changes root files rsync never sees. This used to block the release
	// until someone forced the deploy; the manifest is now scoped to the deploy root.
	const r = scenario( {
		previous: [ '/composer.lock', '/wp-content/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		localSub: 'wp-content/',
		build: { '/composer.lock': 'updated', '/wp-content/plugins/acme/acme.php': 'v2' },
		manifest: true,
	} );
	assert( r.code === 0, 'expected the deploy to go through, exit ' + r.code + show( r ) );
	assert( r.content( '/plugins/acme/acme.php' ) === 'v2', 'the release was not deployed' + show( r ) );
	assert( ! r.exists( '/composer.lock' ), 'a file outside the deploy root reached the server' + show( r ) );
} );

// ---- subdirectory deploys (SSH_LOCAL_ROOT / env-local-root pointing inside the repo) ------
// The rsync filter is built from the rules as written, relative to the deploy root; the
// manifest check gets copies re-rooted under the subdirectory, because the manifest is
// repo-rooted. Two real bugs have lived in that split, so it gets its own scenarios.

test( 'subdirectory: the ignore list still protects files on the server', () => {
	const r = scenario( {
		previous: [ '/composer.json', '/wp-content/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		localSub: 'wp-content/',
		target: { '/uploads/2024/photo.jpg': 'user upload', '/object-cache.php': 'dropin' },
		build: { '/wp-content/plugins/acme/acme.php': 'v2' },
		manifest: true,
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/plugins/acme/acme.php' ) === 'v2', 'not deployed' + show( r ) );
	assert( r.exists( '/uploads/2024/photo.jpg' ), 'default list must protect /uploads/' + show( r ) );
	assert( r.exists( '/object-cache.php' ), 'default list must protect /object-cache.php' + show( r ) );
	assert( ! r.exists( '/composer.json' ), 'a file outside the deploy root reached the server' + show( r ) );
} );

test( 'subdirectory: a normal release with additions and deletions reconciles', () => {
	const r = scenario( {
		previous: [ '/wp-content/plugins/acme/acme.php', '/wp-content/plugins/gone/gone.php' ],
		targetFromPrevious: true,
		localSub: 'wp-content/',
		remove: [ '/wp-content/plugins/gone' ],
		build: { '/wp-content/plugins/acme/acme.php': 'v2', '/wp-content/themes/t/style.css': 'css' },
		manifest: true,
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/plugins/acme/acme.php' ) === 'v2', 'update not deployed' + show( r ) );
	assert( r.exists( '/themes/t/style.css' ), 'addition not deployed' + show( r ) );
	assert( ! r.exists( '/plugins/gone/gone.php' ), 'deletion not applied' + show( r ) );
} );

test( 'subdirectory: the consistency check passes in sync and fails on drift', () => {
	const base = {
		previous: [ '/wp-content/plugins/acme/acme.php' ],
		build: { '/wp-content/plugins/acme/acme.php': '/wp-content/plugins/acme/acme.php\n' },
		targetFromPrevious: true,
		localSub: 'wp-content/',
		inputs: { 'consistency-check': 'true' },
	};
	const clean = scenario( base );
	assert( clean.code === 0, 'in-sync subdirectory target should pass, exit ' + clean.code + show( clean ) );
	const drift = scenario( Object.assign( {}, base, { target: { '/plugins/acme/hotfix.php': 'edited on the server' } } ) );
	assert( drift.code === 1, 'drift should fail the check, exit ' + drift.code + show( drift ) );
	assert( JSON.stringify( drift.before ) === JSON.stringify( drift.after ), 'a failed check wrote to the target' + show( drift ) );
} );

test( 'subdirectory: protect and hide work and the manifest check passes', () => {
	const r = scenario( {
		previous: [ '/wp-content/mu-plugins/ours.php', '/wp-content/plugins/old/old.php', '/wp-content/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		localSub: 'wp-content/',
		target: { '/mu-plugins/host-managed.php': 'placed by the host' },
		remove: [ '/wp-content/plugins/old' ],
		build: { '/wp-content/mu-plugins/ours.php': 'v2' },
		manifest: true,
		inputs: { 'force-ignore-extra': 'protect /mu-plugins/\nhide /plugins/old/' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/mu-plugins/ours.php' ) === 'v2', 'protected path not deployed' + show( r ) );
	assert( r.exists( '/mu-plugins/host-managed.php' ), 'protect let --delete remove a host file' + show( r ) );
	assert( ! r.exists( '/plugins/old/old.php' ), 'hide left the retired path on the server' + show( r ) );
} );

test( 'manifest: a release that changes an ignored file still reconciles', () => {
	const r = scenario( {
		previous: [ '/composer.json', '/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		build: { '/composer.json': '{"changed":true}', '/plugins/acme/acme.php': 'v2' },
		manifest: true,
	} );
	// composer.json is in the manifest but excluded by the default list, so the check has to
	// drop it -- which only works if check-ignore actually runs against the rules.
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/plugins/acme/acme.php' ) === 'v2', 'not deployed' + show( r ) );
	assert( r.content( '/composer.json' ) !== '{"changed":true}', 'an excluded file was overwritten on the server' + show( r ) );
} );

test( 'subdirectory: a release that changes an ignored file still reconciles', () => {
	const r = scenario( {
		previous: [ '/wp-content/vendor/lib/x.php', '/wp-content/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		localSub: 'wp-content/',
		build: { '/wp-content/vendor/lib/x.php': 'changed', '/wp-content/plugins/acme/acme.php': 'v2' },
		manifest: true,
	} );
	// /vendor/ is anchored at the deploy root; the scoped manifest path vendor/lib/x.php must
	// match it as written.
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/plugins/acme/acme.php' ) === 'v2', 'not deployed' + show( r ) );
} );

test( 'subdirectory: the drift diff does not report changes outside the deploy root', () => {
	const r = scenario( {
		// release-notes.txt sits at the repo root, outside the deploy root, and no ignore rule
		// covers it: only scoping to the deploy root keeps it out of the diff.
		previous: [ '/release-notes.txt', '/wp-content/plugins/acme/acme.php' ],
		build: { '/release-notes.txt': 'updated between builds', '/wp-content/plugins/acme/acme.php': '/wp-content/plugins/acme/acme.php\n' },
		targetFromPrevious: true,
		localSub: 'wp-content/',
		target: { '/plugins/acme/hotfix.php': 'edited on the server' },
		inputs: { 'consistency-check': 'true' },
	} );
	assert( r.code === 1, 'drift should fail the check, exit ' + r.code + show( r ) );
	assert( r.driftDiff.length > 0, 'no drift diff was written' + show( r ) );
	assert( /hotfix\.php/.test( r.driftDiff ), 'the real drift is missing from the diff\n' + r.driftDiff );
	assert( ! /release-notes\.txt/.test( r.driftDiff ), 'a change outside the deploy root was reported as drift\n' + r.driftDiff );
} );

// ---- protect / hide through the real main.js ---------------------------------------

test( 'protect: our files are deployed, files already on the server are kept', () => {
	const r = scenario( {
		previous: [ '/mu-plugins/ours.php', '/plugins/acme/acme.php' ],
		targetFromPrevious: true,
		target: { '/mu-plugins/host-managed.php': 'placed by the host' },
		build: { '/mu-plugins/ours.php': 'v2' },
		manifest: true,
		inputs: { 'force-ignore-extra': 'protect /mu-plugins/' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( r.content( '/mu-plugins/ours.php' ) === 'v2', 'our mu-plugin was not updated' + show( r ) );
	assert( r.exists( '/mu-plugins/host-managed.php' ), 'the host file was deleted' + show( r ) );
} );

test( 'hide: a path we stop shipping is removed from the server and the check passes', () => {
	const r = scenario( {
		previous: [ '/plugins/acme/acme.php', '/plugins/old-plugin/old.php' ],
		targetFromPrevious: true,
		remove: [ '/plugins/old-plugin' ],
		build: { '/plugins/acme/acme.php': 'v2' },
		manifest: true,
		inputs: { 'force-ignore-extra': 'hide /plugins/old-plugin/' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( ! r.exists( '/plugins/old-plugin/old.php' ), 'the hidden path was left on the server' + show( r ) );
} );

test( 'protect: switching an exclude to protect blocks the first release that does not touch it', () => {
	const r = scenario( {
		// saucal-helper.php has always been in the build, but the old exclude kept it off the server.
		previous: [ '/mu-plugins/saucal-helper.php', '/plugins/acme/acme.php' ],
		target: { '/plugins/acme/acme.php': '/plugins/acme/acme.php\n' },
		build: { '/plugins/acme/acme.php': 'v2' },
		manifest: true,
		inputs: { 'force-ignore-extra': 'protect /mu-plugins/' },
	} );
	assert( r.code !== 0, 'expected the first release after the switch to be blocked' + show( r ) );
	assert( /^\+mu-plugins\/saucal-helper\.php$/m.test( r.out ), 'blocked, but not by the newly-sent mu-plugin' + show( r ) );
}, { note: 'Expected rollout step: files the old exclude kept off the server start being sent, and the release manifest does not list them. One "Build & Deploy (forced -- no consistency check)" resolves it.' } );

test( 'a mistyped rule prefix is warned about in the job log', () => {
	const r = scenario( {
		build: { '/a.php': 'a' },
		inputs: { 'force-ignore-extra': 'protected /mu-plugins/' },
	} );
	assert( r.code === 0, 'exit ' + r.code + show( r ) );
	assert( /::warning::.*protected \/mu-plugins\//.test( r.out ), 'no warning for the mistyped prefix' + show( r ) );
} );

// ---------------------------------------------------------------------------------------

let pass = 0;
const failures = [];
const selected = scenarios.filter( ( s ) => ! filter || s.name.includes( filter ) );
if ( filter && ! selected.length ) {
	console.error( 'no scenario matched "' + filter + '"' );
	process.exit( 2 );
}
for ( const s of selected ) {
	const t = Date.now();
	try {
		s.fn();
		pass++;
		console.log( 'ok   ' + s.name + ' (' + ( Date.now() - t ) + 'ms)' + ( s.bug ? '  [bug pinned]' : '' ) );
	} catch ( e ) {
		failures.push( s.name );
		console.log( 'FAIL ' + s.name + '\n     ' + e.message.split( '\n' ).join( '\n     ' ) );
	}
}
console.log( '\n' + pass + ' passed, ' + failures.length + ' failed (e2e main.js)' );
process.exit( failures.length ? 1 : 0 );
