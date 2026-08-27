#!/usr/bin/env node
// Runs every fixture in cases.js through REAL rsync, so the assertions are about what
// actually gets deployed rather than about the text of the filter file.
//
//   node tests/run.js            all cases
//   node tests/run.js protect    only cases whose name matches "protect"
//
// Sender side  (`send`)   : build a source tree, dry-run, see which paths transfer.
// Receiver side (`remote`): build source + a pre-populated target, run for real with
//                           --delete, see which pre-existing files survive.

const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { execFileSync } = require( 'child_process' );
const formatter = require( '../rsyncRulesFormatter' );
const cases = require( './cases' );

const filter = process.argv[ 2 ];
let pass = 0;
const failures = [];

function tmpdir() {
	return fs.mkdtempSync( path.join( os.tmpdir(), 'rsync-rules-' ) );
}

function writeFile( root, rel, body ) {
	const full = path.join( root, rel );
	fs.mkdirSync( path.dirname( full ), { recursive: true } );
	fs.writeFileSync( full, body );
}

function rsync( args ) {
	return execFileSync( 'rsync', args, { encoding: 'utf8' } );
}

// Which of `paths` does rsync actually transfer?
function sent( rules, paths ) {
	const dir = tmpdir();
	const src = path.join( dir, 'src' );
	fs.mkdirSync( src );
	paths.forEach( ( p ) => writeFile( src, p, 'x' ) );
	fs.writeFileSync( path.join( dir, 'rules' ), rules );

	const out = rsync( [
		'-rn', '--out-format=%n',
		'--filter=merge ' + path.join( dir, 'rules' ),
		src + '/', path.join( dir, 'dst' ) + '/',
	] );

	const transferred = new Set(
		out.split( '\n' ).filter( ( l ) => l && ! l.endsWith( '/' ) ).map( ( l ) => '/' + l )
	);
	fs.rmSync( dir, { recursive: true, force: true } );
	return transferred;
}

// Which pre-existing remote files survive a real --delete run?
function survivors( rules, localPaths, remotePaths ) {
	const dir = tmpdir();
	const src = path.join( dir, 'src' );
	const dst = path.join( dir, 'dst' );
	fs.mkdirSync( src );
	fs.mkdirSync( dst );
	localPaths.forEach( ( p ) => writeFile( src, p, 'from-repo' ) );
	remotePaths.forEach( ( p ) => writeFile( dst, p, 'on-server' ) );
	fs.writeFileSync( path.join( dir, 'rules' ), rules );

	// Mirrors the real deploy, which runs `avrcz` -- the -c matters: without it rsync's
	// size+mtime quick check skips same-size files and an overwrite silently no-ops.
	rsync( [
		'-a', '-c', '--delete',
		'--filter=merge ' + path.join( dir, 'rules' ),
		src + '/', dst + '/',
	] );

	const alive = new Set();
	const content = new Map();
	( function walk( d ) {
		for ( const e of fs.readdirSync( d, { withFileTypes: true } ) ) {
			const full = path.join( d, e.name );
			if ( e.isDirectory() ) walk( full );
			else {
				const rel = '/' + path.relative( dst, full );
				alive.add( rel );
				content.set( rel, fs.readFileSync( full, 'utf8' ).trim() );
			}
		}
	} )( dst );
	fs.rmSync( dir, { recursive: true, force: true } );
	return { alive, content };
}

for ( const c of cases ) {
	if ( filter && ! c.name.toLowerCase().includes( filter.toLowerCase() ) ) continue;

	const errors = [];
	let rules;
	try {
		rules = formatter.run( c.rules );
	} catch ( e ) {
		failures.push( { name: c.name, errors: [ 'threw: ' + e.message ] } );
		continue;
	}

	if ( c.send ) {
		const paths = Object.keys( c.send );
		const transferred = sent( rules, paths );
		for ( const [ p, want ] of Object.entries( c.send ) ) {
			const got = transferred.has( p ) ? 'SENT' : 'IGNORED';
			if ( got !== want ) errors.push( `send  ${ p }: want ${ want }, got ${ got }` );
		}
	}

	if ( c.remote ) {
		// Whatever the case says exists in the build dir. Without this the source tree is
		// empty, rsync --delete wipes the target wholesale, and every DELETED assertion
		// passes no matter what the filter says -- a vacuous test that looks green.
		const local = ( c.local || [] ).concat(
			Object.entries( c.send || {} ).filter( ( [ , v ] ) => v === 'SENT' ).map( ( [ k ] ) => k )
		);

		if ( ! local.length ) {
			errors.push(
				'this case asserts on `remote` but nothing exists locally, so rsync --delete ' +
				'would empty the target and the assertion would hold for any filter. ' +
				'Add `local: [ ... ]` or a `send` entry marked SENT.'
			);
		} else {
			const { alive, content } = survivors( rules, local, Object.keys( c.remote ) );
			for ( const [ p, want ] of Object.entries( c.remote ) ) {
				let got = alive.has( p ) ? 'KEPT' : 'DELETED';
				// OVERWRITTEN distinguishes "we replaced their copy" from "we left it alone",
				// which KEPT on its own cannot.
				if ( got === 'KEPT' && want === 'OVERWRITTEN' ) {
					got = content.get( p ) === 'from-repo' ? 'OVERWRITTEN' : 'KEPT';
				}
				if ( got !== want ) errors.push( `remote ${ p }: want ${ want }, got ${ got }` );
			}
		}
	}

	if ( errors.length ) failures.push( { name: c.name, errors, rules } );
	else pass++;
}

// ---------------------------------------------------------------- unit assertions
// reroot() and toGitignore() feed the manifest reconciliation, not rsync, so they are
// checked directly rather than through a transfer.
function unit( name, got, want ) {
	if ( got === want ) pass++;
	else failures.push( { name, errors: [ 'want ' + JSON.stringify( want ) + ', got ' + JSON.stringify( got ) ] } );
}

const rr = formatter.parse( '/vendor/\n!/vendor/composer\nnode_modules/\n' );

unit(
	'reroot: anchored patterns gain the subdirectory prefix',
	formatter.format( formatter.reroot( rr, 'wp-content' ) ),
	'+ /wp-content/vendor/composer\n- node_modules/\n- /wp-content/vendor/'
);
unit(
	// Regression: reroot used to rescore, which re-ranked anchored rules against
	// unanchored ones. main.js builds the rsync filter from the UN-rerooted rules and the
	// gitignore views from the rerooted ones, so rescoring made the manifest check
	// disagree with what rsync actually did, and failed the deploy.
	'reroot: rule order survives re-rooting',
	formatter.format( formatter.reroot( rr, 'wp-content' ) ).replace( /\/wp-content/g, '' ),
	formatter.format( rr )
);
unit(
	'reroot + toGitignore: the manifest view keeps the filter\'s ordering',
	formatter.toGitignore( formatter.reroot( formatter.parse( '!/plugins/\nnode_modules/\n' ), 'wp-content' ), 'not-sent' ),
	'!/wp-content/plugins/\n!/wp-content/plugins/**\nnode_modules/'
);
unit(
	'reroot: unanchored patterns are left alone',
	formatter.format( formatter.reroot( formatter.parse( 'node_modules/' ), 'wp-content' ) ),
	'- node_modules/'
);
unit(
	'reroot: no relative path is a no-op',
	formatter.format( formatter.reroot( rr, '' ) ),
	formatter.format( rr )
);

const sides = formatter.parse( '/uploads/\nprotect /mu-plugins/\nhide /old/\n!/uploads/keep.txt\n' );

unit(
	'toGitignore not-sent: excludes and hides, negated by includes',
	formatter.toGitignore( sides, 'not-sent' ),
	'/uploads/\n/old/\n!/uploads/keep.txt'
);
unit(
	'toGitignore not-deleted: adds protects, since rsync will not remove those',
	formatter.toGitignore( sides, 'not-deleted' ),
	'/uploads/\n/mu-plugins/\n/old/\n!/uploads/keep.txt'
);
unit(
	'toGitignore hidden: only the hides',
	formatter.toGitignore( sides, 'hidden' ),
	'/old/'
);
unit(
	'toGitignore: a re-included directory brings its contents',
	formatter.toGitignore( formatter.parse( '/wp-content/*\n!/wp-content/plugins/' ), 'not-sent' ),
	'/wp-content/*\n!/wp-content/plugins/\n!/wp-content/plugins/**'
);

for ( const f of failures ) {
	console.log( '\x1b[31mFAIL\x1b[0m ' + f.name );
	f.errors.forEach( ( e ) => console.log( '       ' + e ) );
	if ( f.rules ) console.log( '       filter:\n' + f.rules.split( '\n' ).map( ( l ) => '         ' + l ).join( '\n' ) );
}

console.log( `\n${ pass } passed, ${ failures.length } failed` );
process.exit( failures.length ? 1 : 0 );
