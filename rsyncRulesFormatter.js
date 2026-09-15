// Translates a gitignore-flavoured ignore list into an rsync filter file.
//
// Beyond gitignore's `pattern` / `!pattern`, four rsync rule types are available as
// line prefixes. They exist because an exclude is symmetric -- it stops us sending a
// path AND stops --delete removing it -- which is often not what a deploy wants:
//
//   protect /mu-plugins/   keep sending ours, but never delete what is already there
//   risk    /mu-plugins/x  an exception to a protect
//   hide    /old-plugin/   stop sending, and DO let --delete clean up what we pushed
//   show    /old-plugin/x  an exception to a hide
//
// Short forms P / R / H / S also work. Prefix a line with `\` to force it to be read
// as a literal path.
//
// ORDERING -- rsync is first-match-wins, gitignore is last-match-wins, and neither is
// what this does. Rules are sorted most-specific-first. That is deliberate and load
// bearing: `!dir/` is expanded to a whole-subtree include (`+ dir/***`), which is far
// broader than git's `!dir/`, and specificity ordering is the only thing keeping
// narrower excludes ahead of it. Real ignore lists in the fleet are written in a
// whitelist style that depends on this -- see tests/cases.js.

// `precedence` breaks specificity ties. Rules that speak to only ONE side of the
// transfer (P/R affect deletion only, H/S affect sending only) outrank the symmetric
// exclude/include, which affect both. Without this, writing `!/mu-plugins/` next to
// `protect /mu-plugins/` would silently lose the protection: the include ties on
// specificity, sorts first, and tells the delete pass the path is fair game.
const KINDS = {
	exclude: { code: '-', subtree: false, precedence: 0 },
	include: { code: '+', subtree: true,  precedence: 0 },
	protect: { code: 'P', subtree: true,  precedence: 1 },
	risk:    { code: 'R', subtree: true,  precedence: 1 },
	hide:    { code: 'H', subtree: false, precedence: 1 },
	show:    { code: 'S', subtree: true,  precedence: 1 },
};

// Looked up case-insensitively: `Protect` used to fall through to an exclude whose
// pattern contained a space, which matches nothing -- so a capitalised keyword silently
// dropped the protection and let --delete remove the files it was meant to keep.
const PREFIXES = {
	protect: 'protect', p: 'protect',
	risk:    'risk',    r: 'risk',
	hide:    'hide',    h: 'hide',
	show:    'show',    s: 'show',
};

// How specific is this pattern? Used to order rules, most specific first.
function getRuleSpecificity( pattern ) {
	let score = 0;

	pattern.split( '/' ).forEach( ( part ) => {
		if ( part.trim() === '' ) {
			return;
		}

		if ( part.includes( '*' ) ) {
			part = part.replace( /\*/g, '' ); // Remove all asterisks
			score += part.trim() === '' ? 5 : 10; // If part was only asterisks, add 5, if there were more chars, add 10
		} else {
			score += 20; // No asterisks
		}
	} );

	return score;
}

function parseRule( line ) {
	let rule = line.trim();
	let kind = 'exclude';
	let suspect = false;

	if ( rule.startsWith( '\\' ) ) {
		// Escaped: everything after the backslash is a literal path. A backslash in front of
		// a glob character stays, because that is how rsync and git spell a literal `*`,
		// `?` or `[`; stripping it would turn `\\*.log` into a real `*.log`.
		rule = /^\\[*?[]/.test( rule ) ? rule : rule.slice( 1 );
	} else {
		const prefix = rule.match( /^([A-Za-z]+)[ \t]+(\S.*)$/ );
		const keyword = prefix && PREFIXES[ prefix[ 1 ].toLowerCase() ];

		if ( keyword ) {
			kind = keyword;
			rule = prefix[ 2 ].trim();
		} else if ( prefix ) {
			// Looks like `keyword pattern` but names no keyword we know. Almost certainly a
			// typo, and the failure is silent and destructive, so flag it for the caller.
			// A genuine path can contain a space, hence a warning rather than an error.
			suspect = true;
		} else if ( rule.startsWith( '!' ) ) {
			// Only a LEADING "!" negates; one inside a pattern is a literal character.
			kind = 'include';
			rule = rule.slice( 1 ).trim();
		}
	}

	return {
		kind,
		pattern: rule,
		isDir: rule.endsWith( '/' ),
		specificity: getRuleSpecificity( rule ),
		suspect,
	};
}

// Drop comments and blanks, collapse duplicates, and parse what is left.
function parse( input ) {
	const seen = new Set();
	const rules = [];

	String( input ).split( '\n' ).forEach( ( line ) => {
		const trimmed = line.trim();

		if ( trimmed === '' || trimmed.startsWith( '#' ) ) {
			return;
		}

		if ( seen.has( trimmed ) ) {
			return;
		}

		seen.add( trimmed );

		const rule = parseRule( trimmed );

		// A lone "!" (or a prefix with nothing after it) leaves no pattern. Emitting it
		// would give rsync a bare "+ ", which it rejects and aborts the whole deploy on.
		if ( rule.pattern === '' ) {
			return;
		}

		rules.push( rule );
	} );

	return rules;
}

// Scope a repo-rooted git manifest ("+ path" / "- path" lines, as build-to-git writes it)
// to a deploy root that is a subdirectory of the repo: drop every path outside it, strip
// the prefix from the rest. rsync only ever sees the deploy root, so this puts the
// manifest in the same coordinates as rsync's plan and lets both sides use the ignore
// rules exactly as written. Converting paths is plain string handling; rewriting the
// rules instead (the old reroot) had to preserve anchoring and ordering semantics, and
// got them wrong twice.
function scopeManifest( text, prefix ) {
	const root = String( prefix || '' ).replace( /^\/+|\/+$/g, '' );
	if ( ! root ) {
		return String( text );
	}

	const inside = root + '/';
	return String( text ).split( '\n' ).reduce( ( out, line ) => {
		const m = line.match( /^([+-] )(")?(.*)$/ );
		if ( ! m ) {
			return out;
		}
		// diff-tree quotes unusual names; the path, prefix included, sits inside the quotes.
		const [ , mark, quote = '', rest ] = m;
		if ( rest.startsWith( inside ) ) {
			out.push( mark + quote + rest.slice( inside.length ) );
		}
		return out;
	}, [] ).join( '\n' ) + ( String( text ).endsWith( '\n' ) ? '\n' : '' );
}

function sortRules( rules ) {
	// Most specific first, then side-specific rules ahead of symmetric ones. Ties are
	// broken by REVERSE authoring order so that -- as in gitignore -- the last rule
	// written wins, since rsync itself is first-match-wins.
	return rules
		.map( ( rule, index ) => ( { rule, index } ) )
		.sort( ( a, b ) =>
			b.rule.specificity - a.rule.specificity ||
			KINDS[ b.rule.kind ].precedence - KINDS[ a.rule.kind ].precedence ||
			b.index - a.index
		)
		.map( ( entry ) => entry.rule );
}

// Render as an rsync filter file.
function format( rules ) {
	return sortRules( rules ).map( ( rule ) => {
		const kind = KINDS[ rule.kind ];
		// A trailing "/***" matches the directory AND everything inside it. Excludes and
		// hides do not need it -- rsync never descends into a directory it is skipping --
		// but the rest do, or only the directory entry itself would be affected.
		const pattern = rule.isDir && kind.subtree ? rule.pattern + '***' : rule.pattern;

		return kind.code + ' ' + pattern;
	} ).join( '\n' );
}

// Render as a gitignore, for reconciling the git manifest against what rsync will do.
//
//   'not-sent'    rsync will not transfer these, so git's additions cannot appear
//   'not-deleted' rsync will not remove these, so git's deletions cannot appear
//   'hidden'      rsync deletes these without git ever asking it to
//
// Hidden paths drop out of BOTH sides: they are, by definition, files git knows
// nothing about, so there is nothing to reconcile them against.
function toGitignore( rules, side ) {
	const SIDES = {
		'not-sent': {
			ignore: [ 'exclude', 'hide' ],
			negate: [ 'include', 'show' ],
		},
		'not-deleted': {
			ignore: [ 'exclude', 'protect', 'hide' ],
			negate: [ 'include', 'risk', 'show' ],
		},
		hidden: {
			ignore: [ 'hide' ],
			negate: [ 'show' ],
		},
	};
	const want = SIDES[ side ];

	if ( ! want ) {
		throw new Error( 'Unknown gitignore side: ' + side );
	}

	// gitignore is last-match-wins, so emit least-specific first -- the mirror of the
	// rsync filter order, which keeps the two in agreement.
	return sortRules( rules ).reverse().reduce( ( lines, rule ) => {
		const negated = want.negate.includes( rule.kind );

		if ( ! negated && ! want.ignore.includes( rule.kind ) ) {
			return lines;
		}

		const mark = negated ? '!' : '';
		// A pattern that starts with # or ! is a literal name here (it came from an escaped
		// rule); unescaped, git would read it as a comment or a negation.
		const pattern = /^[#!]/.test( rule.pattern ) ? '\\' + rule.pattern : rule.pattern;
		lines.push( mark + pattern );

		// Mirror the subtree expansion so a re-included directory brings its contents.
		if ( rule.isDir && negated && KINDS[ rule.kind ].subtree ) {
			lines.push( mark + pattern + '**' );
		}

		return lines;
	}, [] ).join( '\n' );
}

function run( input ) {
	return format( parse( input ) );
}

module.exports = {
	run,
	parse,
	format,
	scopeManifest,
	toGitignore,
};
