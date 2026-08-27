#!/usr/bin/env node
// Replays every real SSH_IGNORE_LIST in the fleet and reports any change in DEPLOY
// BEHAVIOUR. Run it before and after touching the formatter or the ordering logic.
//
//   node tests/fleet-audit.js <path to gh-actions-management/scan-results.json> [--save]
//
// For each repo's effective list this runs REAL rsync against a representative
// wp-content tree (tests/wp-tree.js) and records:
//
//   - which files the deploy would send
//   - which pre-existing files on the target survive --delete
//   - the three gitignore views the manifest check reconciles against
//
// Comparing behaviour rather than the text of the filter file is the point: a reordering
// that changes no outcome is not a regression, and one that changes an outcome is, even
// if the filter file looks similar. Only hashes and counts are stored -- the client lists
// carry staging hostnames and plugin inventories, and this repo is public.

const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const crypto = require( 'crypto' );
const { execFileSync } = require( 'child_process' );
const formatter = require( '../rsyncRulesFormatter' );
const tree = require( './wp-tree' );

const scan = process.argv[ 2 ];
const save = process.argv.includes( '--save' );
const baselinePath = path.join( __dirname, 'fleet-baseline.json' );

if ( ! scan ) {
	console.error( 'usage: node tests/fleet-audit.js <scan-results.json> [--save]' );
	process.exit( 2 );
}

const DEFAULT = fs.readFileSync( path.join( __dirname, '..', 'default-ignore.txt' ), 'utf8' );

function write( root, rel, body ) {
	const full = path.join( root, rel );
	fs.mkdirSync( path.dirname( full ), { recursive: true } );
	fs.writeFileSync( full, body );
}

function digest( value ) {
	return crypto.createHash( 'sha256' ).update( value ).digest( 'hex' ).slice( 0, 16 );
}

// What the deploy actually does to a target, for one filter file.
function behaviour( filter ) {
	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'fleet-' ) );
	const src = path.join( dir, 'src' );
	const dst = path.join( dir, 'dst' );
	const rules = path.join( dir, 'rules' );

	fs.writeFileSync( rules, filter );
	tree.local.forEach( ( p ) => write( src, p, 'from-repo' ) );
	tree.local.concat( tree.remote ).forEach( ( p ) => write( dst, p, 'on-server' ) );

	// Sender view: what would transfer, against an empty target.
	const sent = execFileSync( 'rsync', [
		'-rn', '--out-format=%n', '--filter=merge ' + rules,
		src + '/', path.join( dir, 'empty' ) + '/',
	], { encoding: 'utf8' } )
		.split( '\n' ).filter( ( l ) => l && ! l.endsWith( '/' ) ).sort();

	// Receiver view: what survives a real --delete against a populated target.
	// -c matches the production `avrcz`; without it same-size files are skipped.
	execFileSync( 'rsync', [
		'-a', '-c', '--delete', '--filter=merge ' + rules, src + '/', dst + '/',
	], { encoding: 'utf8' } );

	const survivors = [];
	( function walk( d ) {
		for ( const e of fs.readdirSync( d, { withFileTypes: true } ) ) {
			const full = path.join( d, e.name );
			if ( e.isDirectory() ) walk( full );
			else survivors.push( '/' + path.relative( dst, full ) );
		}
	} )( dst );
	survivors.sort();

	fs.rmSync( dir, { recursive: true, force: true } );

	return {
		sent: sent.length,
		kept: survivors.length,
		hash: digest( sent.join( '\n' ) + ' ' + survivors.join( '\n' ) ),
	};
}

const data = JSON.parse( fs.readFileSync( scan, 'utf8' ) );
const repos = Array.isArray( data.repositories ) ? data.repositories : Object.values( data.repositories );

const current = {};
for ( const repo of repos ) {
	const vars = {};
	for ( const v of repo.variables || [] ) vars[ v.name ] = v.value;

	const base = vars.SSH_IGNORE_LIST;
	const extra = vars.SSH_IGNORE_LIST_EXTRA;
	if ( ! base && ! extra ) continue;

	let list = base && base !== 'false' ? base : DEFAULT;
	if ( extra && extra !== 'false' ) list += '\n' + extra;

	const rules = formatter.parse( list.replace( /\r/g, '' ) );
	const entry = behaviour( formatter.format( rules ) );

	// The manifest check runs on EVERY deploy, driven by three gitignore views of the same
	// rules. rsync is forgiving about things git is not (stray whitespace in a pattern,
	// for one), so a change can be invisible to the transfer and still break the
	// reconciliation. Hash the views for every repo, not just the re-rooted ones.
	const localRoot = vars.SSH_LOCAL_ROOT && vars.SSH_LOCAL_ROOT !== 'false' ? vars.SSH_LOCAL_ROOT : '';
	const scoped = localRoot ? formatter.reroot( rules, localRoot ) : rules;
	entry.manifest = digest( [ 'not-sent', 'not-deleted', 'hidden' ]
		.map( ( side ) => formatter.toGitignore( scoped, side ) )
		.join( ' ' ) );
	if ( localRoot ) {
		entry.localRoot = localRoot;
	}

	const suspect = rules.filter( ( r ) => r.suspect );
	if ( suspect.length ) {
		entry.suspect = suspect.length;
	}

	current[ repo.name ] = entry;
}

if ( save ) {
	fs.writeFileSync( baselinePath, JSON.stringify( current, null, '\t' ) + '\n' );
	console.log( 'baseline written for ' + Object.keys( current ).length + ' lists' );
	process.exit( 0 );
}

if ( ! fs.existsSync( baselinePath ) ) {
	console.error( 'no baseline yet -- run with --save first' );
	process.exit( 2 );
}

const baseline = JSON.parse( fs.readFileSync( baselinePath, 'utf8' ) );
const changed = [];

for ( const [ name, entry ] of Object.entries( current ) ) {
	const was = baseline[ name ];
	if ( ! was ) continue;
	if ( was.hash !== entry.hash || was.manifest !== entry.manifest ) {
		changed.push( { name, was, entry } );
	}
}

const added = Object.keys( current ).filter( ( r ) => ! baseline[ r ] );
const removed = Object.keys( baseline ).filter( ( r ) => ! current[ r ] );
const suspect = Object.entries( current ).filter( ( entry ) => entry[ 1 ].suspect );

console.log( 'lists checked : ' + Object.keys( current ).length );
console.log( 'unchanged     : ' + ( Object.keys( current ).length - changed.length - added.length ) );
if ( added.length ) {
	console.log( 'new           : ' + added.join( ', ' ) );
}
if ( removed.length ) {
	console.log( 'gone          : ' + removed.join( ', ' ) );
}

if ( suspect.length ) {
	console.log( '\nLists containing a rule that looks like a mistyped prefix:' );
	suspect.forEach( ( entry ) => console.log( '  ' + entry[ 0 ] + ' (' + entry[ 1 ].suspect + ')' ) );
}

if ( changed.length ) {
	console.log( '\nDEPLOY BEHAVIOUR CHANGED for ' + changed.length + ' list(s):' );
	changed.forEach( ( c ) => console.log(
		'  ' + c.name +
		'  sent ' + c.was.sent + ' => ' + c.entry.sent +
		', kept ' + c.was.kept + ' => ' + c.entry.kept +
		( c.was.manifest !== c.entry.manifest
			? ', manifest view differs' + ( c.entry.localRoot ? ' (re-rooted)' : '' ) : '' )
	) );
	console.log( '\nEach of these deploys differently than before. Verify before shipping.' );
	process.exit( 1 );
}

console.log( '\nNo change in deploy behaviour.' );
