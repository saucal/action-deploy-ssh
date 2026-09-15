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

const rr = formatter.parse( '/vendor/\n!/vendor/composer\nnode_modules/\n' );

api(
	'reroot: anchored patterns gain the subdirectory prefix',
	() => formatter.format( formatter.reroot( rr, 'wp-content' ) ),
	'+ /wp-content/vendor/composer\n- node_modules/\n- /wp-content/vendor/'
);
api(
	// Regression: reroot used to rescore, which re-ranked anchored rules against
	// unanchored ones. main.js builds the rsync filter from the UN-rerooted rules and the
	// gitignore views from the rerooted ones, so rescoring made the manifest check
	// disagree with what rsync actually did, and failed the deploy.
	'reroot: rule order survives re-rooting',
	() => formatter.format( formatter.reroot( rr, 'wp-content' ) ).replace( /\/wp-content/g, '' ),
	formatter.format( rr )
);
api(
	'reroot + toGitignore: the manifest view keeps the filter\'s ordering',
	() => formatter.toGitignore( formatter.reroot( formatter.parse( '!/plugins/\nnode_modules/\n' ), 'wp-content' ), 'not-sent' ),
	'!/wp-content/plugins/\n!/wp-content/plugins/**\nnode_modules/'
);
api(
	'reroot: unanchored patterns are left alone',
	() => formatter.format( formatter.reroot( formatter.parse( 'node_modules/' ), 'wp-content' ) ),
	'- node_modules/'
);
api(
	'reroot: no relative path is a no-op',
	() => formatter.format( formatter.reroot( rr, '' ) ),
	formatter.format( rr )
);

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

module.exports = cases;
