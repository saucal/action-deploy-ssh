// Shared harness for the deployment characterisation suite.
//
// These tests CHARACTERISE the deployment as it exists today. They do not assert what it
// ought to do -- they pin what it does, so that any future change has to declare itself.
// Where today's behaviour is wrong, the case is marked `bug:` with an explanation; it
// still asserts the CURRENT result, so the suite stays green until someone deliberately
// changes it.
//
// Everything runs against real rsync. Nothing is mocked.

const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { execFileSync } = require( 'child_process' );

const ACTION_DIR = path.join( __dirname, '..' );

// The production defaults, from action.yml / main.js. Tests that care about fidelity to
// the real deploy use these; tests isolating the filter use the lighter dry-run form.
const PROD_FLAGS = [ '-avrcz' ];
const PROD_OPTIONS = [
	'--delete', '--no-inc-recursive', '--size-only', '--ignore-times',
	'--omit-dir-times', '--no-owner', '--no-group', '--no-dirs', '--no-perms',
];

function tmpdir( tag ) {
	return fs.mkdtempSync( path.join( os.tmpdir(), 'deploy-' + ( tag || 'test' ) + '-' ) );
}

function write( root, rel, body ) {
	const full = path.join( root, rel );
	fs.mkdirSync( path.dirname( full ), { recursive: true } );
	fs.writeFileSync( full, body === undefined ? 'x' : body );
}

function tree( root ) {
	const out = [];
	if ( ! fs.existsSync( root ) ) {
		return out;
	}
	( function walk( d ) {
		for ( const e of fs.readdirSync( d, { withFileTypes: true } ) ) {
			const full = path.join( d, e.name );
			if ( e.isDirectory() && ! e.isSymbolicLink() ) {
				walk( full );
			} else {
				out.push( '/' + path.relative( root, full ) );
			}
		}
	} )( root );
	return out.sort();
}

function rsync( args ) {
	return execFileSync( 'rsync', args, { encoding: 'utf8' } );
}

// Build the rsync filter file the action would build for this ignore list, using the
// action's own formatter.
function filterFor( rules ) {
	// Required fresh so a test can swap the formatter out if it needs to.
	const formatter = require( path.join( ACTION_DIR, 'rsyncRulesFormatter' ) );
	return formatter.run( String( rules ) );
}

// Which of the given local paths would the deploy transfer?
// Uses a dry run against an empty target, so the filter is the only variable.
function sent( rules, localPaths ) {
	const dir = tmpdir( 'sent' );
	const src = path.join( dir, 'src' );
	fs.mkdirSync( src );
	localPaths.forEach( ( p ) => write( src, p ) );
	const rulesFile = path.join( dir, 'rules' );
	fs.writeFileSync( rulesFile, filterFor( rules ) );

	try {
		const out = rsync( [
			'-rn', '--out-format=%n', '--filter=merge ' + rulesFile,
			src + '/', path.join( dir, 'dst' ) + '/',
		] );
		return new Set(
			out.split( '\n' ).filter( ( l ) => l && ! l.endsWith( '/' ) ).map( ( l ) => '/' + l )
		);
	} catch ( e ) {
		const err = new Error( 'rsync exited ' + e.status + ': ' + String( e.stderr || '' ).split( '\n' )[ 0 ] );
		err.rsyncExit = e.status;
		throw err;
	} finally {
		fs.rmSync( dir, { recursive: true, force: true } );
	}
}

// Run a real deploy (with --delete) from a local tree onto a pre-populated target, and
// report what is left and what it contains.
function deploy( rules, localPaths, remotePaths, opts ) {
	opts = opts || {};
	const dir = tmpdir( 'deploy' );
	const src = path.join( dir, 'src' );
	const dst = path.join( dir, 'dst' );
	fs.mkdirSync( src );
	fs.mkdirSync( dst );

	( Array.isArray( localPaths ) ? localPaths : Object.keys( localPaths || {} ) )
		.forEach( ( p ) => write( src, p, Array.isArray( localPaths ) ? 'from-repo' : localPaths[ p ] ) );
	( Array.isArray( remotePaths ) ? remotePaths : Object.keys( remotePaths || {} ) )
		.forEach( ( p ) => write( dst, p, Array.isArray( remotePaths ) ? 'on-server' : remotePaths[ p ] ) );

	const rulesFile = path.join( dir, 'rules' );
	fs.writeFileSync( rulesFile, filterFor( rules ) );

	const args = ( opts.flags || PROD_FLAGS )
		.concat( opts.options || PROD_OPTIONS )
		.concat( [ '--filter=merge ' + rulesFile, src + '/', dst + '/' ] );

	// main.js fails the deploy on any exit code other than 0 or 24 ("some files vanished").
	let error = null;
	let code = 0;
	try {
		rsync( args );
	} catch ( e ) {
		error = e;
		code = e.status;
	}

	const alive = tree( dst );
	const content = {};
	alive.forEach( ( p ) => {
		content[ p ] = fs.readFileSync( path.join( dst, p ), 'utf8' ).trim();
	} );
	fs.rmSync( dir, { recursive: true, force: true } );
	return { alive: new Set( alive ), content, error, code };
}

// main.js hands check-against-manifest.sh three gitignore views of the rules, not the raw list.
function views( ignoreList, side ) {
	const formatter = require( path.join( ACTION_DIR, 'rsyncRulesFormatter' ) );
	return formatter.toGitignore( formatter.parse( String( ignoreList ) ), side );
}

// Run check-against-manifest.sh the way main.js runs it.
function reconcile( ignoreList, gitManifest, rsyncManifest ) {
	const work = tmpdir( 'manifest' );
	execFileSync( 'git', [ '-C', work, 'init', '-q' ] );
	fs.writeFileSync( path.join( work, '.gitignore' ), '# written by build-to-git\n' );
	String( gitManifest ).split( '\n' ).forEach( ( line ) => {
		const m = line.match( /^\+ (.+)$/ );
		if ( m && ! m[ 1 ].endsWith( '/' ) ) {
			try {
				write( work, '/' + m[ 1 ] );
			} catch ( e ) {
				// A name the filesystem refuses stays untracked; the manifest line still exists.
			}
		}
	} );
	execFileSync( 'git', [ '-C', work, 'add', '-A' ] );
	execFileSync( 'git', [ '-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'built', '--allow-empty' ] );
	// Manifests live in $RUNNER_TEMP in production, outside the checkout.
	const meta = tmpdir( 'manifest-meta' );
	fs.writeFileSync( path.join( meta, 'git-manifest' ), gitManifest );
	fs.writeFileSync( path.join( meta, 'rsync-manifest' ), rsyncManifest );

	let code = 0;
	let output = '';
	try {
		output = execFileSync( 'bash', [ path.join( ACTION_DIR, 'check-against-manifest.sh' ) ], {
			encoding: 'utf8',
			// Only what main.js passes -- no HOME, no user git config, no GIT_* leaking in.
			env: {
				GITHUB_WORKSPACE: work,
				PATH_DIR: '',
				GIT_MANIFEST: path.join( meta, 'git-manifest' ),
				RSYNC_MANIFEST: path.join( meta, 'rsync-manifest' ),
				// The same three views main.js derives from the ignore list.
				SSH_IGNORE_LIST: views( ignoreList, 'not-sent' ),
				SSH_NOT_DELETED_LIST: views( ignoreList, 'not-deleted' ),
				SSH_HIDDEN_LIST: views( ignoreList, 'hidden' ),
			},
		} );
	} catch ( e ) {
		code = e.status;
		output = String( e.stdout || '' ) + String( e.stderr || '' );
	}
	fs.rmSync( work, { recursive: true, force: true } );
	fs.rmSync( meta, { recursive: true, force: true } );
	return { match: code === 0, code, output };
}

module.exports = {
	ACTION_DIR, PROD_FLAGS, PROD_OPTIONS,
	tmpdir, write, tree, rsync, filterFor, sent, deploy, reconcile,
};
