// Characterisation of the DEPLOYMENT MECHANICS -- what the real rsync invocation
// (PROD_FLAGS + PROD_OPTIONS, i.e. `-avrcz --delete --no-inc-recursive --size-only
// --ignore-times --omit-dir-times --no-owner --no-group --no-dirs --no-perms`) actually
// does to a target filesystem.
//
// Every expectation here was RECORDED from a real run, not reasoned about. Where the
// recorded result is wrong the case carries `bug:` and still asserts what happens today.
//
// The runner understands filter/send/remote/manifest cases only, and its `remote:` form
// can build nothing but plain files with fixed content ('from-repo' locally, 'on-server'
// on the target -- both nine bytes, so every declarative overwrite case is a same-size
// pair). Scenarios needing anything else -- symlinks, empty directories, mode bits,
// exact sizes, a file where the target has a directory -- are written as fsCase(): a
// function that runs inside the runner's try/catch at assertion time and throws on
// mismatch, which the runner reports as an ordinary failure for that case.

const fs = require( 'fs' );
const path = require( 'path' );
const h = require( './harness' );

// ponytail: RECORD_DEPLOY=1 prints the actual values instead of asserting them --
// that is how the expectations below were captured, and how to re-capture them. Every
// recorded case FAILS, so a recording run can never pass for a real one.
const RECORD = process.env.RECORD_DEPLOY === '1';

function eq( what, got, want ) {
	const g = JSON.stringify( got );
	if ( RECORD ) {
		console.log( 'REC ' + what + ' = ' + g );
		return;
	}
	if ( g !== JSON.stringify( want ) ) {
		throw new Error( what + ' -- want ' + JSON.stringify( want ) + ', got ' + g );
	}
}

// A case the declarative fields cannot express -- symlinks, empty directories, mode bits,
// exact sizes, a file where the target has a directory. `fn` throws on mismatch and the
// runner reports it as an ordinary failure.
function fsCase( name, fn, bug, note ) {
	const c = {
		name,
		check: () => {
			fn();
			if ( RECORD ) {
				throw new Error( 'RECORD_DEPLOY=1: values recorded, nothing asserted' );
			}
		},
	};
	if ( bug ) {
		c.bug = bug;
	}
	if ( note ) {
		c.note = note;
	}
	return c;
}

function mkdir( root, rel ) {
	fs.mkdirSync( path.join( root, rel ), { recursive: true } );
}

function link( root, rel, target ) {
	const full = path.join( root, rel );
	fs.mkdirSync( path.dirname( full ), { recursive: true } );
	fs.symlinkSync( target, full );
}

// One line per entry: '/p = "content"' for files, '/p/' for dirs, '/p -> t' for symlinks.
function snap( root ) {
	const out = [];
	( function walk( d, prefix ) {
		const entries = fs.readdirSync( d, { withFileTypes: true } )
			.sort( ( a, b ) => ( a.name < b.name ? -1 : 1 ) );
		for ( const e of entries ) {
			const full = path.join( d, e.name );
			const rel = prefix + '/' + e.name;
			if ( e.isSymbolicLink() ) {
				out.push( rel + ' -> ' + fs.readlinkSync( full ) );
			} else if ( e.isDirectory() ) {
				out.push( rel + '/' );
				walk( full, rel );
			} else {
				out.push( rel + ' = ' + JSON.stringify( fs.readFileSync( full, 'utf8' ) ) );
			}
		}
	} )( root, '' );
	return out;
}

function mode( root, rel ) {
	return ( fs.lstatSync( path.join( root, rel ) ).mode & 0o7777 ).toString( 8 );
}

// The production deploy, but with the two trees built by a callback.
function run( setup, opts ) {
	opts = opts || {};
	const dir = h.tmpdir( 'fscase' );
	const src = path.join( dir, 'src' );
	const dst = path.join( dir, 'dst' );
	fs.mkdirSync( src );
	fs.mkdirSync( dst );
	setup( src, dst );

	const rulesFile = path.join( dir, 'rules' );
	fs.writeFileSync( rulesFile, h.filterFor( opts.rules === undefined ? '' : opts.rules ) );

	const args = ( opts.flags || h.PROD_FLAGS )
		.concat( opts.options || h.PROD_OPTIONS )
		.concat( [ '--filter=merge ' + rulesFile, src + '/', dst + '/' ] );

	let code = 0;
	try {
		h.rsync( args );
	} catch ( e ) {
		code = e.status;
	}
	return { dir, src, dst, code };
}

// Build the trees, deploy, hand the result to `check`, then clean up.
function scene( setup, check, opts ) {
	const r = run( setup, opts );
	try {
		check( r );
	} finally {
		fs.rmSync( r.dir, { recursive: true, force: true } );
	}
}

const T_OLD = new Date( '2001-01-01T00:00:00Z' );
const T_NEW = new Date( '2030-01-01T00:00:00Z' );

module.exports = [

	// ---------------------------------------------------------------- --delete ---

	{
		name: 'deploy: --delete removes an extraneous file from the target',
		rules: '',
		local: [ '/keep.php' ],
		remote: { '/keep.php': 'OVERWRITTEN', '/junk.txt': 'DELETED' },
	},
	{
		name: 'deploy: --delete removes an extraneous directory tree recursively',
		rules: '',
		local: [ '/keep.php' ],
		remote: {
			'/old/a.txt': 'DELETED',
			'/old/deep/b.txt': 'DELETED',
			'/old/deep/deeper/c.txt': 'DELETED',
		},
	},
	{
		name: 'deploy: --delete removes stale files from a directory that DOES exist locally',
		rules: '',
		local: [ '/plugins/mine.php' ],
		remote: { '/plugins/mine.php': 'OVERWRITTEN', '/plugins/stale.php': 'DELETED' },
	},
	{
		name: 'deploy: --delete removes files inside a directory that does NOT exist locally',
		rules: '',
		local: [ '/plugins/mine.php' ],
		remote: { '/plugins/mine.php': 'OVERWRITTEN', '/themes/old/style.css': 'DELETED' },
	},
	{
		name: 'deploy: an excluded directory is protected from --delete',
		rules: '/uploads/',
		local: [ '/keep.php' ],
		remote: { '/uploads/2024/a.jpg': 'KEPT', '/uploads/nested/deep/b.jpg': 'KEPT' },
	},
	{
		name: 'deploy: an excluded single file is protected from --delete',
		rules: '/wp-config.php',
		local: [ '/keep.php' ],
		remote: { '/wp-config.php': 'KEPT', '/other.php': 'DELETED' },
	},
	{
		name: 'deploy: a rooted exclude protects only the root copy, not a same-named nested one',
		rules: '/object-cache.php',
		local: [ '/keep.php' ],
		remote: { '/object-cache.php': 'KEPT', '/plugins/object-cache.php': 'DELETED' },
	},
	{
		name: 'deploy: an unanchored exclude protects the file at every depth',
		rules: '.gitignore',
		local: [ '/keep.php' ],
		remote: { '/.gitignore': 'KEPT', '/plugins/x/.gitignore': 'KEPT', '/plugins/x/a.php': 'DELETED' },
	},
	{
		name: 'deploy: a re-include under an excluded directory is inert -- nothing sent, nothing deleted',
		rules: '/uploads/\n!/uploads/keep/',
		local: [ '/keep.php' ],
		// The formatter emits `+ /uploads/keep/***` ahead of `- /uploads/`, but nothing
		// re-includes `/uploads` ITSELF, so rsync excludes the directory and never
		// descends -- on the send side or the delete side.
		send: { '/uploads/keep/a.txt': 'IGNORED', '/keep.php': 'SENT' },
		remote: { '/uploads/keep/gone.txt': 'KEPT', '/uploads/other/x.jpg': 'KEPT' },
		note: 'Matches git exactly -- `man gitignore`: "it is not possible to re-include a file if a parent directory of that file is excluded". Surprising, but correct for the gitignore flavour this list advertises. Carve out the CONTENTS (/uploads/*) instead of the directory.',
	},
	{
		name: 'deploy: a re-include only works when the parent is excluded by CONTENTS (/uploads/*)',
		rules: '!/uploads/keep/\n/uploads/*',
		local: [ '/keep.php' ],
		// `- /uploads/*` leaves the directory itself includable, so rsync descends and
		// the `+ /uploads/keep/***` above it takes effect on both sides.
		send: { '/uploads/keep/a.txt': 'SENT', '/uploads/other/x.jpg': 'IGNORED' },
		remote: { '/uploads/keep/gone.txt': 'DELETED', '/uploads/other/x.jpg': 'KEPT' },
	},
	{
		name: 'deploy: re-including the excluded parent itself re-includes EVERYTHING under it',
		rules: '/uploads/\n!/uploads/\n!/uploads/keep/',
		local: [ '/keep.php' ],
		// `!/uploads/` formats to `+ /uploads/***`, which swallows the whole subtree.
		send: { '/uploads/keep/a.txt': 'SENT', '/uploads/other/x.jpg': 'SENT' },
		note: 'git also keeps everything under /uploads/ here: `!/uploads/` re-includes the whole directory. `!dir/` -> `+ dir/***` is deliberate, so re-including the parent un-protects its subtree. Carve out the CONTENTS (/uploads/*) instead.',
	},
	{
		name: 'deploy: re-including the excluded parent also exposes live target files to --delete',
		rules: '/uploads/\n!/uploads/\n!/uploads/keep/',
		local: [ '/uploads/keep/a.txt' ],
		remote: { '/uploads/keep/a.txt': 'OVERWRITTEN', '/uploads/other/live.jpg': 'DELETED' },
		note: 'Same rule shape as above, seen from the delete side. The list re-includes /uploads/, so the build owns it and a server-only file inside it is removed -- consistent with git, which would not ignore it either.',
	},

	// ------------------------------------------------------------- overwriting ---

	{
		name: 'deploy: a target file of the SAME SIZE but different content IS overwritten',
		rules: '',
		local: [ '/a.php' ],
		// 'from-repo' and 'on-server' are both nine bytes. --size-only alone would skip
		// this; -c (from -avrcz) wins, because rsync only consults size_only after
		// always_checksum has already decided. See the sibling fsCase for the proof.
		remote: { '/a.php': 'OVERWRITTEN' },
	},
	fsCase( 'deploy: -c beats --size-only -- same size, different bytes, still transferred', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'AAAAAAAAAA' );
			h.write( dst, '/a.php', 'BBBBBBBBBB' );
		}, ( r ) => eq( 'same-size overwrite', snap( r.dst ), [ '/a.php = "AAAAAAAAAA"' ] ) );

		// Drop the 'c' from -avrcz and --size-only takes over: the same pair is now
		// skipped. That is what makes the production combination surprising -- both
		// flags are passed, and the one that looks like an optimisation loses.
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'AAAAAAAAAA' );
			h.write( dst, '/a.php', 'BBBBBBBBBB' );
		}, ( r ) => eq( 'same size without -c', snap( r.dst ), [ '/a.php = "BBBBBBBBBB"' ] ),
			{ flags: [ '-avrz' ] } );

		// --ignore-times is likewise inert here: -c has already decided.
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'AAAAAAAAAA' );
			h.write( dst, '/a.php', 'BBBBBBBBBB' );
		}, ( r ) => eq( 'same size without --ignore-times', snap( r.dst ), [ '/a.php = "AAAAAAAAAA"' ] ),
			{ options: h.PROD_OPTIONS.filter( ( o ) => o !== '--ignore-times' ) } );
	} ),
	fsCase( 'deploy: a target file of a DIFFERENT size is overwritten', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'short' );
			h.write( dst, '/a.php', 'a much longer body on the server' );
		}, ( r ) => eq( 'different-size overwrite', snap( r.dst ), [ '/a.php = "short"' ] ) );
	} ),
	fsCase( 'deploy: identical content is not re-sent, but its mtime IS synced', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'identical' );
			h.write( dst, '/a.php', 'identical' );
			fs.utimesSync( path.join( src, 'a.php' ), T_OLD, T_OLD );
			fs.utimesSync( path.join( dst, 'a.php' ), T_NEW, T_NEW );
		}, ( r ) => {
			eq( 'content', snap( r.dst ), [ '/a.php = "identical"' ] );
			eq( 'mtime pulled back to the source mtime',
				fs.statSync( path.join( r.dst, 'a.php' ) ).mtime.toISOString(),
				T_OLD.toISOString() );
		} );
	} ),
	fsCase( 'deploy: a target file NEWER than the local one is still overwritten', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'old build' );
			h.write( dst, '/a.php', 'hand-edited on the server, later' );
			fs.utimesSync( path.join( src, 'a.php' ), T_OLD, T_OLD );
			fs.utimesSync( path.join( dst, 'a.php' ), T_NEW, T_NEW );
		}, ( r ) => {
			eq( 'newer target clobbered', snap( r.dst ), [ '/a.php = "old build"' ] );
			eq( 'mtime', fs.statSync( path.join( r.dst, 'a.php' ) ).mtime.toISOString(),
				T_OLD.toISOString() );
		} );
	}, null, 'By design: the build is the source of truth, so a deploy reverts drift on the target. Catching that drift is exactly what the consistency check is for.' ),
	fsCase( 'deploy: a newer target of the same size and same content survives untouched', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'same bytes' );
			h.write( dst, '/a.php', 'same bytes' );
			fs.utimesSync( path.join( src, 'a.php' ), T_OLD, T_OLD );
			fs.utimesSync( path.join( dst, 'a.php' ), T_NEW, T_NEW );
		}, ( r ) => eq( 'content', snap( r.dst ), [ '/a.php = "same bytes"' ] ) );
	} ),

	// ------------------------------------------------------------ directories ---

	fsCase( 'deploy: an empty source directory IS created on the target', () => {
		scene( ( src ) => {
			mkdir( src, '/empty' );
			h.write( src, '/a.php', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/a.php = "x"', '/empty/' ] ) );
	} ),
	fsCase( 'deploy: nested empty source directories are all created', () => {
		scene( ( src ) => {
			mkdir( src, '/a/b/c/d' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/a/', '/a/b/', '/a/b/c/', '/a/b/c/d/' ] ) );
	} ),
	fsCase( 'deploy: a target directory that becomes empty is REMOVED, not left as an empty dir', () => {
		scene( ( src, dst ) => {
			h.write( src, '/keep.php', 'x' );
			h.write( dst, '/gone/a.txt', 'x' );
			h.write( dst, '/gone/b.txt', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/keep.php = "x"' ] ) );
	} ),
	fsCase( 'deploy: a target directory emptied by --delete is KEPT when the source has it empty', () => {
		scene( ( src, dst ) => {
			mkdir( src, '/dir' );
			h.write( dst, '/dir/stale.txt', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/dir/' ] ) );
	} ),
	fsCase( 'deploy: an EXCLUDED file keeps its parent directory alive even though the source dropped it', () => {
		scene( ( src, dst ) => {
			h.write( src, '/keep.php', 'x' );
			h.write( dst, '/cache/index.php', 'x' );
			h.write( dst, '/cache/junk.txt', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ),
			[ '/cache/', '/cache/index.php = "x"', '/keep.php = "x"' ] ),
		{ rules: '/cache/index.php' } );
	} ),

	// --------------------------------------------------------------- symlinks ---

	fsCase( 'deploy: a source symlink is deployed AS A SYMLINK, not as its content', () => {
		scene( ( src ) => {
			h.write( src, '/real.php', 'body' );
			link( src, '/alias.php', 'real.php' );
		}, ( r ) => eq( 'tree', snap( r.dst ),
			[ '/alias.php -> real.php', '/real.php = "body"' ] ) );
	} ),
	fsCase( 'deploy: an extraneous symlink on the target is deleted like any other entry', () => {
		scene( ( src, dst ) => {
			h.write( src, '/keep.php', 'x' );
			h.write( dst, '/real.php', 'x' );
			link( dst, '/alias.php', 'real.php' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/keep.php = "x"' ] ) );
	} ),
	fsCase( 'deploy: a symlink pointing OUTSIDE the tree is deployed verbatim', () => {
		scene( ( src ) => {
			link( src, '/escape', '/etc/passwd' );
			link( src, '/up', '../../outside/secret' );
		}, ( r ) => eq( 'tree', snap( r.dst ),
			[ '/escape -> /etc/passwd', '/up -> ../../outside/secret' ] ) );
	}, null, 'Standard rsync behaviour for -a, which implies -l. Worth hardening with --safe-links if a build could ever carry an untrusted symlink, but not a defect in this action.' ),
	fsCase( 'deploy: a BROKEN source symlink is deployed as a broken symlink', () => {
		scene( ( src ) => {
			link( src, '/dangling', 'nothing-here.php' );
		}, ( r ) => {
			eq( 'tree', snap( r.dst ), [ '/dangling -> nothing-here.php' ] );
			eq( 'still broken', fs.existsSync( path.join( r.dst, 'dangling' ) ), false );
		} );
	} ),
	fsCase( 'deploy: a target symlink is REPLACED by the real file the source has, not written through', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'the build copy' );
			h.write( dst, '/other.php', 'untouched target' );
			link( dst, '/a.php', 'other.php' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/a.php = "the build copy"' ] ) );
	} ),
	fsCase( 'deploy: a target REAL FILE is replaced by the source symlink', () => {
		scene( ( src, dst ) => {
			h.write( src, '/real.php', 'body' );
			link( src, '/a.php', 'real.php' );
			h.write( dst, '/a.php', 'a genuine file on the server' );
		}, ( r ) => eq( 'tree', snap( r.dst ),
			[ '/a.php -> real.php', '/real.php = "body"' ] ) );
	} ),
	fsCase( 'deploy: a symlink to a directory stays a symlink; the directory is copied separately', () => {
		scene( ( src ) => {
			h.write( src, '/dir/a.php', 'x' );
			link( src, '/dirlink', 'dir' );
		}, ( r ) => eq( 'tree', snap( r.dst ),
			[ '/dir/', '/dir/a.php = "x"', '/dirlink -> dir' ] ) );
	} ),

	// -------------------------------------------------- modes and ownership ---

	fsCase( 'deploy: a mode change ALONE does not propagate (--no-perms)', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'identical' );
			h.write( dst, '/a.php', 'identical' );
			fs.chmodSync( path.join( src, 'a.php' ), 0o600 );
			fs.chmodSync( path.join( dst, 'a.php' ), 0o644 );
		}, ( r ) => eq( 'target mode untouched', mode( r.dst, '/a.php' ), '644' ) );
	} ),
	fsCase( 'deploy: content is updated but the target mode is left alone', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'new body' );
			h.write( dst, '/a.php', 'old body on the server' );
			fs.chmodSync( path.join( src, 'a.php' ), 0o644 );
			fs.chmodSync( path.join( dst, 'a.php' ), 0o400 );
		}, ( r ) => {
			eq( 'content', snap( r.dst ), [ '/a.php = "new body"' ] );
			eq( 'mode', mode( r.dst, '/a.php' ), '400' );
		} );
	} ),
	fsCase( 'deploy: an executable bit difference does NOT propagate to an existing file', () => {
		scene( ( src, dst ) => {
			h.write( src, '/deploy.sh', 'identical' );
			h.write( dst, '/deploy.sh', 'identical' );
			fs.chmodSync( path.join( src, 'deploy.sh' ), 0o755 );
			fs.chmodSync( path.join( dst, 'deploy.sh' ), 0o644 );
		}, ( r ) => eq( 'still not executable', mode( r.dst, '/deploy.sh' ), '644' ) );
	}, null, 'The documented default. The `ssh-handle-perms` input (action.yml:52) adds `perms` when true; main.js:108 sends --no-perms otherwise.' ),
	fsCase( 'deploy: a BRAND NEW file does inherit the source mode despite --no-perms', () => {
		scene( ( src ) => {
			h.write( src, '/new.sh', 'x' );
			fs.chmodSync( path.join( src, 'new.sh' ), 0o755 );
		}, ( r ) => eq( 'mode of a newly created file', mode( r.dst, '/new.sh' ), '755' ) );
	} ),

	// ------------------------------------------------------ special filenames ---

	{
		name: 'deploy: a filename with spaces survives the wire',
		rules: '',
		local: [ '/my plugin/some file.php' ],
		send: { '/my plugin/some file.php': 'SENT' },
	},
	{
		name: 'deploy: a unicode filename survives the wire',
		rules: '',
		local: [ '/plugins/café-日本語-🚀.php' ],
		remote: { '/junk.txt': 'DELETED' },
	},
	fsCase( 'deploy: quotes, backslashes, dollars, spaces and unicode all round-trip', () => {
		const names = [
			'/it\'s here.php',
			'/say "hi".php',
			'/back\\slash.php',
			'/dollar$var.php',
			'/semi;colon&amp.php',
			'/dash-lead.php',
			'/-leading-dash.php',
			'/café-日本語-🚀.php',
			'/tab\there.php',
		];
		scene( ( src ) => names.forEach( ( n ) => h.write( src, n, 'x' ) ),
			( r ) => eq( 'all delivered', snap( r.dst ).length, names.length ) );
	} ),
	fsCase( 'deploy: a NEWLINE in a filename round-trips intact', () => {
		scene( ( src ) => {
			h.write( src, '/two\nlines.php', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/two\nlines.php = "x"' ] ) );
	} ),
	fsCase( 'deploy: a newline in a target filename is still deleted correctly', () => {
		scene( ( src, dst ) => {
			h.write( src, '/keep.php', 'x' );
			h.write( dst, '/two\nlines.php', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/keep.php = "x"' ] ) );
	} ),
	fsCase( 'deploy: 30 levels of nesting deploy and delete correctly', () => {
		const deep = '/' + Array.from( { length: 30 }, ( _, i ) => 'lvl' + i ).join( '/' );
		scene( ( src, dst ) => {
			h.write( src, deep + '/leaf.php', 'x' );
			h.write( dst, deep + '/stale.php', 'x' );
		}, ( r ) => {
			eq( 'leaf delivered', fs.existsSync( path.join( r.dst, deep, 'leaf.php' ) ), true );
			eq( 'stale removed', fs.existsSync( path.join( r.dst, deep, 'stale.php' ) ), false );
		} );
	} ),
	fsCase( 'deploy: a 200-character filename at the end of a deep path survives', () => {
		const long = '/' + 'n'.repeat( 200 ) + '.php';
		const deep = '/' + Array.from( { length: 20 }, ( _, i ) => 'd' + i ).join( '/' );
		scene( ( src ) => h.write( src, deep + long, 'x' ),
			( r ) => eq( 'delivered', fs.existsSync( path.join( r.dst, deep + long ) ), true ) );
	} ),

	// -------------------------------- --no-dirs and --no-inc-recursive ---

	fsCase( 'deploy: --no-dirs changes NOTHING about the result', () => {
		const setup = ( src, dst ) => {
			h.write( src, '/a.php', 'from-repo' );
			mkdir( src, '/empty' );
			mkdir( src, '/nested/empty/deeper' );
			h.write( src, '/plugins/x/y.php', 'x' );
			link( src, '/alias.php', 'a.php' );
			h.write( dst, '/a.php', 'on-server' );
			h.write( dst, '/stale/deep/junk.txt', 'x' );
			h.write( dst, '/uploads/keep.jpg', 'x' );
		};
		let withFlag;
		scene( setup, ( r ) => {
			withFlag = snap( r.dst );
		}, { rules: '/uploads/' } );
		scene( setup, ( r ) => eq( 'result with vs without --no-dirs', snap( r.dst ), withFlag ), {
			rules: '/uploads/',
			options: h.PROD_OPTIONS.filter( ( o ) => o !== '--no-dirs' ),
		} );
	} ),
	fsCase( 'deploy: --no-inc-recursive changes NOTHING about the result', () => {
		const setup = ( src, dst ) => {
			h.write( src, '/a.php', 'from-repo' );
			mkdir( src, '/empty' );
			mkdir( src, '/nested/empty/deeper' );
			h.write( src, '/plugins/x/y.php', 'x' );
			link( src, '/alias.php', 'a.php' );
			h.write( dst, '/a.php', 'on-server' );
			h.write( dst, '/stale/deep/junk.txt', 'x' );
			h.write( dst, '/uploads/keep.jpg', 'x' );
		};
		let withFlag;
		scene( setup, ( r ) => {
			withFlag = snap( r.dst );
		}, { rules: '/uploads/' } );
		scene( setup, ( r ) => eq( 'result with vs without --no-inc-recursive', snap( r.dst ), withFlag ), {
			rules: '/uploads/',
			options: h.PROD_OPTIONS.filter( ( o ) => o !== '--no-inc-recursive' ),
		} );
	} ),
	fsCase( 'deploy: dropping BOTH --no-dirs and --no-inc-recursive still changes nothing', () => {
		const setup = ( src, dst ) => {
			mkdir( src, '/a/b/c' );
			h.write( src, '/a/f.php', 'x' );
			h.write( dst, '/a/gone.php', 'x' );
			h.write( dst, '/z/gone.php', 'x' );
		};
		let prod;
		scene( setup, ( r ) => {
			prod = snap( r.dst );
		} );
		scene( setup, ( r ) => eq( 'result without either flag', snap( r.dst ), prod ), {
			options: h.PROD_OPTIONS.filter(
				( o ) => o !== '--no-dirs' && o !== '--no-inc-recursive'
			),
		} );
	} ),
	fsCase( 'deploy: --no-dirs does NOT suppress recursion, because -r is also set', () => {
		scene( ( src ) => {
			h.write( src, '/a/b/c/deep.php', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ),
			[ '/a/', '/a/b/', '/a/b/c/', '/a/b/c/deep.php = "x"' ] ) );
	} ),

	// ------------------------------------------------- file / directory clash ---

	fsCase( 'deploy: local FILE over a target DIRECTORY wipes the directory and its contents', () => {
		scene( ( src, dst ) => {
			h.write( src, '/thing', 'now a file' );
			h.write( dst, '/thing/inside.php', 'x' );
			h.write( dst, '/thing/deep/also.php', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/thing = "now a file"' ] ) );
	} ),
	fsCase( 'deploy: local DIRECTORY over a target FILE replaces the file with the directory', () => {
		scene( ( src, dst ) => {
			h.write( src, '/thing/inside.php', 'x' );
			h.write( dst, '/thing', 'a plain file on the server' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/thing/', '/thing/inside.php = "x"' ] ) );
	} ),
	fsCase( 'deploy: local FILE over a target SYMLINK-to-directory replaces the link', () => {
		scene( ( src, dst ) => {
			h.write( src, '/thing', 'now a file' );
			mkdir( dst, '/elsewhere' );
			h.write( dst, '/elsewhere/x.php', 'x' );
			link( dst, '/thing', 'elsewhere' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/thing = "now a file"' ] ) );
	} ),

	// --------------------------------------------- zero-byte and whitespace ---

	fsCase( 'deploy: a zero-byte source file is created on the target', () => {
		scene( ( src ) => h.write( src, '/empty.php', '' ),
			( r ) => eq( 'tree', snap( r.dst ), [ '/empty.php = ""' ] ) );
	} ),
	fsCase( 'deploy: a zero-byte source file TRUNCATES a non-empty target file', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', '' );
			h.write( dst, '/a.php', 'plenty of content here' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/a.php = ""' ] ) );
	} ),
	fsCase( 'deploy: two zero-byte files match, so nothing is transferred', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', '' );
			h.write( dst, '/a.php', '' );
			fs.utimesSync( path.join( src, 'a.php' ), T_OLD, T_OLD );
			fs.utimesSync( path.join( dst, 'a.php' ), T_NEW, T_NEW );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/a.php = ""' ] ) );
	} ),
	fsCase( 'deploy: a non-empty target is replaced by an empty one even one byte apart', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', '' );
			h.write( dst, '/a.php', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/a.php = ""' ] ) );
	} ),
	fsCase( 'deploy: a whitespace-only file is transferred byte-exactly, not normalised', () => {
		scene( ( src, dst ) => {
			h.write( src, '/ws.php', '   \n\t\n' );
			h.write( dst, '/ws.php', '\t\n   \n' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/ws.php = "   \\n\\t\\n"' ] ) );
	} ),
	fsCase( 'deploy: a whitespace-only file differing only in trailing bytes is still overwritten', () => {
		scene( ( src, dst ) => {
			h.write( src, '/ws.php', ' ' );
			h.write( dst, '/ws.php', '\n' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [ '/ws.php = " "' ] ) );
	} ),

	// ------------------------------------------------------- the ignore list ---

	{
		name: 'deploy: an EMPTY ignore list deploys everything and deletes everything extraneous',
		rules: '',
		local: [ '/a.php' ],
		send: { '/a.php': 'SENT', '/.git/config': 'SENT', '/vendor/autoload.php': 'SENT' },
		remote: { '/a.php': 'OVERWRITTEN', '/anything.txt': 'DELETED', '/uploads/x.jpg': 'DELETED' },
	},
	fsCase( 'deploy: an empty ignore list produces an EMPTY filter file, which rsync accepts', () => {
		eq( 'filter text', h.filterFor( '' ), '' );
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'x' );
			h.write( dst, '/junk.txt', 'x' );
		}, ( r ) => {
			eq( 'exit code', r.code, 0 );
			eq( 'tree', snap( r.dst ), [ '/a.php = "x"' ] );
		} );
	} ),
	{
		name: 'deploy: an ignore list of /* sends nothing and deletes nothing',
		rules: '/*',
		local: [ '/a.php' ],
		send: { '/a.php': 'IGNORED', '/plugins/x.php': 'IGNORED' },
		remote: { '/anything.txt': 'KEPT', '/deep/tree/x.php': 'KEPT' },
	},
	fsCase( 'deploy: /* is a total no-op -- the target is left byte-for-byte alone', () => {
		scene( ( src, dst ) => {
			h.write( src, '/a.php', 'from-repo' );
			h.write( dst, '/a.php', 'on-server' );
			h.write( dst, '/only-here.txt', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ),
			[ '/a.php = "on-server"', '/only-here.txt = "x"' ] ),
		{ rules: '/*' } );
	}, null, 'The filter behaves exactly as written -- `/*` does exclude everything. What is missing is a safety net: main.js tracks processedFiles but never warns when a push moves zero files.' ),
	{
		name: 'deploy: /* does not stop a re-included subtree from deploying',
		rules: '/*\n!/plugins/',
		local: [ '/plugins/mine.php' ],
		send: { '/plugins/mine.php': 'SENT', '/themes/x.php': 'IGNORED' },
	},

	// ------------------------------------------------------------- the deal ---

	fsCase( 'deploy: the default ignore list protects the live uploads directory end to end', () => {
		const rules = fs.readFileSync( path.join( h.ACTION_DIR, 'default-ignore.txt' ), 'utf8' )
			.split( '\n' ).filter( ( l ) => l.trim() && ! l.trim().startsWith( '#' ) ).join( '\n' );
		scene( ( src, dst ) => {
			h.write( src, '/plugins/mine.php', 'from-repo' );
			h.write( dst, '/plugins/mine.php', 'on-server' );
			h.write( dst, '/uploads/2024/photo.jpg', 'x' );
			h.write( dst, '/vendor/autoload.php', 'x' );
			h.write( dst, '/object-cache.php', 'x' );
			h.write( dst, '/debug.log', 'x' );
			h.write( dst, '/random.txt', 'x' );
		}, ( r ) => eq( 'tree', snap( r.dst ), [
			'/debug.log = "x"',
			'/object-cache.php = "x"',
			'/plugins/',
			'/plugins/mine.php = "from-repo"',
			'/uploads/',
			'/uploads/2024/',
			'/uploads/2024/photo.jpg = "x"',
			'/vendor/',
			'/vendor/autoload.php = "x"',
		] ), { rules } );
	} ),
];
