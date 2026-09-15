#!/usr/bin/env node
// Runs every characterisation case against REAL rsync.
//
//   node tests/run.js               everything
//   node tests/run.js anchor        only cases whose name matches "anchor"
//   node tests/run.js --list        list case names and counts per file
//   node tests/run.js --bugs        list only the cases pinning known-wrong behaviour
//
// Case files are tests/cases-*.js, each exporting an array of:
//
//   {
//     name:   'what this pins',
//     rules:  '<ignore list, gitignore-flavoured>',
//     local:  [ '/paths/in/the/build' ],          // optional extra source files
//     send:   { '/p': 'SENT' | 'IGNORED' },       // what the deploy would transfer
//     remote: { '/p': 'KEPT' | 'DELETED' | 'OVERWRITTEN' },  // what survives --delete
//     filter: '<exact rsync filter file>',        // optional, pins the translation
//     manifest: { ignore, git, rsync, expect: 'MATCH' | 'MISMATCH' },  // optional
//     rsyncExit: 1,                                // expected rsync exit code (default 0)
//     check:  function () { ... },                // for scenarios the fields cannot express;
//                                                 // throw to fail, return to pass
//     bug:    'why this result is a DEFECT',      // pins current behaviour anyway
//     note:   'why this is correct but surprising', // by design, configurable, or matches git
//   }

const fs = require( 'fs' );
const path = require( 'path' );
const h = require( './harness' );

const args = process.argv.slice( 2 );
const listOnly = args.includes( '--list' );
const bugsOnly = args.includes( '--bugs' );
const filter = args.filter( ( a ) => ! a.startsWith( '--' ) )[ 0 ];

const files = fs.readdirSync( __dirname )
	.filter( ( f ) => /^cases-.*\.js$/.test( f ) ).sort();

if ( ! files.length ) {
	console.error( 'no tests/cases-*.js files found' );
	process.exit( 2 );
}

let pass = 0;
let skipped = 0;
const failures = [];
const bugs = [];
const notes = [];
const perFile = {};

for ( const file of files ) {
	const cases = require( path.join( __dirname, file ) );
	perFile[ file ] = cases.length;

	for ( const c of cases ) {
		if ( filter && ! c.name.toLowerCase().includes( filter.toLowerCase() ) ) {
			skipped++;
			continue;
		}
		if ( args.includes( '--notes' ) && ! c.note && ! c.bug ) {
			skipped++;
			continue;
		}
		if ( bugsOnly && ! c.bug ) {
			skipped++;
			continue;
		}
		if ( c.bug ) {
			bugs.push( { file, name: c.name, why: c.bug } );
		}
		if ( c.note ) {
			notes.push( { file, name: c.name, why: c.note } );
		}
		if ( listOnly ) {
			console.log( ( c.bug ? '  BUG  ' : '       ' ) + c.name );
			continue;
		}

		const errors = [];

		try {
			// An imperative scenario -- symlinks, mode bits, file/directory collisions --
			// that the declarative fields cannot describe.
			if ( typeof c.check === 'function' ) {
				c.check();
			}

			if ( c.filter !== undefined ) {
				const got = h.filterFor( c.rules );
				if ( got !== c.filter ) {
					errors.push( 'filter:\n        want: ' + JSON.stringify( c.filter ) +
						'\n        got:  ' + JSON.stringify( got ) );
				}
			}

			if ( c.send ) {
				const paths = Object.keys( c.send ).concat( c.local || [] );
				let transferred = new Set();
				try {
					transferred = h.sent( c.rules, paths );
					if ( c.rsyncExit ) {
						errors.push( 'send   expected rsync to exit ' + c.rsyncExit + ', it exited 0' );
					}
				} catch ( e ) {
					if ( e.rsyncExit === undefined || e.rsyncExit !== c.rsyncExit ) {
						throw e;
					}
				}
				for ( const [ p, want ] of Object.entries( c.send ) ) {
					const got = transferred.has( p ) ? 'SENT' : 'IGNORED';
					if ( got !== want ) {
						errors.push( 'send   ' + p + ': want ' + want + ', got ' + got );
					}
				}
			}

			if ( c.remote ) {
				const local = ( c.local || [] ).concat(
					Object.entries( c.send || {} )
						.filter( ( e ) => e[ 1 ] === 'SENT' ).map( ( e ) => e[ 0 ] )
				);
				if ( ! local.length ) {
					// An empty source makes --delete wipe the target, so every DELETED
					// assertion would hold for any filter at all.
					errors.push( 'asserts on `remote` with an empty build dir; add `local: [...]`' );
				} else {
					const res = h.deploy( c.rules, local, Object.keys( c.remote ) );
					const exit = res.code === 24 ? 0 : res.code;
					if ( exit !== ( c.rsyncExit || 0 ) ) {
						errors.push( 'remote rsync exited ' + res.code + ', expected ' + ( c.rsyncExit || 0 ) );
					}
					for ( const [ p, want ] of Object.entries( c.remote ) ) {
						let got = res.alive.has( p ) ? 'KEPT' : 'DELETED';
						if ( got === 'KEPT' && want === 'OVERWRITTEN' ) {
							got = res.content[ p ] === 'from-repo' ? 'OVERWRITTEN' : 'KEPT';
						}
						if ( got !== want ) {
							errors.push( 'remote ' + p + ': want ' + want + ', got ' + got );
						}
					}
				}
			}

			if ( c.manifest ) {
				const m = c.manifest;
				const res = h.reconcile(
					m.ignore === undefined ? c.rules : m.ignore, m.git || '', m.rsync || ''
				);
				const got = res.match ? 'MATCH' : 'MISMATCH';
				if ( got !== m.expect ) {
					errors.push( 'manifest: want ' + m.expect + ', got ' + got +
						'\n' + res.output.split( '\n' ).slice( -12 ).map( ( l ) => '        ' + l ).join( '\n' ) );
				}
			}
		} catch ( e ) {
			errors.push( 'threw: ' + ( e && e.message ? e.message.split( '\n' )[ 0 ] : e ) );
		}

		if ( errors.length ) {
			failures.push( { file, name: c.name, errors, rules: c.rules } );
		} else {
			pass++;
		}
	}
}

if ( listOnly ) {
	console.log( '\n' + Object.entries( perFile ).map( ( e ) => '  ' + e[ 0 ] + ': ' + e[ 1 ] ).join( '\n' ) );
	console.log( '  total: ' + Object.values( perFile ).reduce( ( a, b ) => a + b, 0 ) );
	process.exit( 0 );
}

for ( const f of failures ) {
	console.log( '\x1b[31mFAIL\x1b[0m [' + f.file.replace( /^cases-|\.js$/g, '' ) + '] ' + f.name );
	f.errors.forEach( ( e ) => console.log( '       ' + e ) );
	if ( f.rules !== undefined ) {
		console.log( '       rules: ' + JSON.stringify( String( f.rules ) ) );
		console.log( '       filter:' );
		try {
			console.log( h.filterFor( f.rules ).split( '\n' ).map( ( l ) => '         ' + l ).join( '\n' ) );
		} catch ( e ) {
			console.log( '         <threw>' );
		}
	}
}

if ( notes.length && ! filter ) {
	console.log( '\n\x1b[36m' + notes.length + ' case(s) pin behaviour that is correct but surprising.\x1b[0m' +
		'  (node tests/run.js --notes)' );
}

if ( bugs.length ) {
	console.log( '\n\x1b[33m' + bugs.length + ' case(s) pin behaviour that is a DEFECT:\x1b[0m' );
	if ( args.includes( '--bugs' ) || args.includes( '--notes' ) ) {
		bugs.forEach( ( b ) => console.log( '  - [' + b.file.replace( /^cases-|\.js$/g, '' ) + '] ' + b.name + '\n      ' + b.why ) );
	} else {
		console.log( '  (node tests/run.js --bugs to list them)' );
	}
}

if ( notes.length && args.includes( '--notes' ) ) {
	console.log( '\n\x1b[36mCorrect but surprising:\x1b[0m' );
	notes.forEach( ( b ) => console.log( '  - [' + b.file.replace( /^cases-|\.js$/g, '' ) + '] ' + b.name + '\n      ' + b.why ) );
}

if ( filter && pass + failures.length === 0 && ! listOnly ) {
	console.error( 'no case matched "' + filter + '"' );
	process.exit( 2 );
}

console.log( '\n' + pass + ' passed, ' + failures.length + ' failed' +
	( skipped ? ', ' + skipped + ' skipped' : '' ) +
	' (across ' + files.length + ' case file(s))' );
process.exit( failures.length ? 1 : 0 );
