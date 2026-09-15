// The formatter API that main.js builds the rsync filter and the manifest views from.
// These feed the manifest reconciliation, not rsync directly, so they are asserted on their
// output rather than through a transfer.

const formatter = require( '../rsyncRulesFormatter' );

const cases = [];
function api( name, got, want ) {
	cases.push( {
		name: 'api: ' + name,
		check() {
			const value = got();
			if ( value !== want ) {
				throw new Error( 'want ' + JSON.stringify( want ) + ', got ' + JSON.stringify( value ) );
			}
		},
	} );
}

const sides = formatter.parse( '/uploads/\nprotect /mu-plugins/\nhide /old/\n!/uploads/keep.txt\n' );

api(
	'toGitignore not-sent: excludes and hides, negated by includes',
	() => formatter.toGitignore( sides, 'not-sent' ),
	'/uploads/\n/old/\n!/uploads/keep.txt'
);
api(
	'toGitignore not-deleted: adds protects, since rsync will not remove those',
	() => formatter.toGitignore( sides, 'not-deleted' ),
	'/uploads/\n/mu-plugins/\n/old/\n!/uploads/keep.txt'
);
api(
	'toGitignore hidden: only the hides',
	() => formatter.toGitignore( sides, 'hidden' ),
	'/old/'
);
api(
	'toGitignore: a re-included directory brings its contents',
	() => formatter.toGitignore( formatter.parse( '/wp-content/*\n!/wp-content/plugins/' ), 'not-sent' ),
	'/wp-content/*\n!/wp-content/plugins/\n!/wp-content/plugins/**'
);

api(
	'toGitignore: a literal leading # stays literal, not a git comment',
	() => formatter.toGitignore( formatter.parse( '\\#a.php' ), 'not-sent' ),
	'\\#a.php'
);
api(
	'toGitignore: a literal leading ! stays literal, not a git negation',
	() => formatter.toGitignore( formatter.parse( '\\!a.php' ), 'not-sent' ),
	'\\!a.php'
);
api(
	'reroot no longer exists: subdirectory deploys scope paths, not rules',
	() => typeof formatter.reroot,
	'undefined'
);

module.exports = cases;
