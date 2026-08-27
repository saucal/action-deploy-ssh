#!/usr/bin/env node
// Replays every real SSH_IGNORE_LIST in the fleet through the formatter and reports any
// change against a baseline. Run it before and after touching the ordering logic.
//
//   node tests/fleet-audit.js <path to gh-actions-management/scan-results.json> [--save]
//
// --save writes a baseline; without it, the current output is diffed against that
// baseline. The client lists themselves are never written into this repo -- they carry
// staging hostnames and plugin inventories, and this repo is public.

const fs = require( 'fs' );
const path = require( 'path' );
const formatter = require( '../rsyncRulesFormatter' );

const scan = process.argv[ 2 ];
const save = process.argv.includes( '--save' );
const baselinePath = path.join( __dirname, 'fleet-baseline.json' );

if ( ! scan ) {
	console.error( 'usage: node tests/fleet-audit.js <scan-results.json> [--save]' );
	process.exit( 2 );
}

const DEFAULT = fs.readFileSync( path.join( __dirname, '..', 'default-ignore.txt' ), 'utf8' );
const data = JSON.parse( fs.readFileSync( scan, 'utf8' ) );
const repos = Array.isArray( data.repositories ) ? data.repositories : Object.values( data.repositories );

// Rebuild each repo's effective list exactly as main.js composes it.
const current = {};
for ( const repo of repos ) {
	const vars = {};
	for ( const v of repo.variables || [] ) vars[ v.name ] = v.value;

	const base = vars.SSH_IGNORE_LIST;
	const extra = vars.SSH_IGNORE_LIST_EXTRA;
	if ( ! base && ! extra ) continue;

	let list = base && base !== 'false' ? base : DEFAULT;
	if ( extra && extra !== 'false' ) list += '\n' + extra;

	// Hash only -- never the list contents.
	current[ repo.name ] = require( 'crypto' )
		.createHash( 'sha256' )
		.update( formatter.run( list.replace( /\r/g, '' ) ) )
		.digest( 'hex' )
		.slice( 0, 16 );
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
const changed = Object.keys( current ).filter( ( r ) => baseline[ r ] && baseline[ r ] !== current[ r ] );
const added = Object.keys( current ).filter( ( r ) => ! baseline[ r ] );
const removed = Object.keys( baseline ).filter( ( r ) => ! current[ r ] );

console.log( 'lists checked : ' + Object.keys( current ).length );
console.log( 'unchanged     : ' + ( Object.keys( current ).length - changed.length - added.length ) );
if ( added.length )   console.log( 'new           : ' + added.join( ', ' ) );
if ( removed.length ) console.log( 'gone          : ' + removed.join( ', ' ) );
if ( changed.length ) {
	console.log( '\nFILTER OUTPUT CHANGED for ' + changed.length + ' list(s):' );
	changed.forEach( ( r ) => console.log( '  ' + r ) );
	console.log( '\nEach of these deploys differently than before. Verify before shipping.' );
	process.exit( 1 );
}
console.log( '\nNo change in deploy behaviour.' );
