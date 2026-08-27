// Behavioural fixtures for the ignore-list -> rsync-filter translation.
//
// `send`   : path in the build dir -> SENT (rsync transfers it) | IGNORED (it does not)
// `remote` : path that already exists on the target -> KEPT | DELETED | OVERWRITTEN
// `local`  : extra paths that exist in the build dir. Needed whenever a case asserts on
//            `remote` but sends nothing, because rsync --delete against an EMPTY source
//            wipes the target wholesale and every DELETED assertion would pass for free.
//
// Cases marked `gitDiffers` are places where we knowingly do NOT match `git check-ignore`.
// They are pinned deliberately: real ignore lists in the fleet depend on the current
// behaviour, and "fixing" them would silently change what gets deployed.

module.exports = [
	// ---------------------------------------------------------------- baseline
	{
		name: 'vendor whitelist (the action-bundle-push-to-ssh default)',
		rules: `
			/auth.json
			/vendor/*
			!/vendor/composer
			/vendor/composer/*
			!/vendor/composer/installers
			!/vendor/composer/installed.json
		`,
		send: {
			'/auth.json': 'IGNORED',
			'/vendor/autoload.php': 'IGNORED',
			'/vendor/foo/bar.php': 'IGNORED',
			'/vendor/composer/autoload_real.php': 'IGNORED',
			'/vendor/composer/installed.json': 'SENT',
			'/vendor/composer/installers/src/X.php': 'SENT',
		},
	},
	{
		name: 'unanchored patterns match at any depth (same as git)',
		rules: `
			node_modules/
			*.log
		`,
		send: {
			'/root.log': 'IGNORED',
			'/a/b/node_modules/x.js': 'IGNORED',
			'/deep/nested/debug.log': 'IGNORED',
			'/keep.php': 'SENT',
		},
	},
	{
		name: 'cannot re-include under a fully excluded directory (same as git)',
		rules: `
			/vendor/
			!/vendor/composer/installed.json
		`,
		send: {
			'/vendor/autoload.php': 'IGNORED',
			'/vendor/composer/installed.json': 'IGNORED',
		},
	},

	// ---------------------------------------------- the *** subtree expansion
	{
		name: '"!dir/" re-includes the whole subtree (broader than git, on purpose)',
		rules: `
			/wp-content/*
			!/wp-content/plugins/
		`,
		send: {
			'/wp-content/other.txt': 'IGNORED',
			'/wp-content/plugins/readme.txt': 'SENT',
			'/wp-content/plugins/acme/acme.php': 'SENT',
		},
	},
	{
		name: 'whitelist style: catch-all excludes, then carve back in',
		rules: `
			/*
			/wp-content/*
			!/wp-content/
			!/wp-content/plugins/
			!/wp-content/themes/
			/wp-content/uploads/
			/wp-content/object-cache.php
		`,
		send: {
			'/wp-config.php': 'IGNORED',
			'/wp-content/probe.php': 'IGNORED',
			'/wp-content/object-cache.php': 'IGNORED',
			'/wp-content/uploads/2024/img.jpg': 'IGNORED',
			'/wp-content/plugins/acme/acme.php': 'SENT',
			'/wp-content/themes/kadence/style.css': 'SENT',
		},
	},
	{
		name: '"!dir/" written AFTER the narrow excludes it would otherwise swallow',
		rules: `
			/mu-plugins/helper.php
			/mu-plugins/cache-mgmt/
			/mu-plugins/activity-log.php
			!/mu-plugins/
		`,
		send: {
			'/mu-plugins/helper.php': 'IGNORED',
			'/mu-plugins/cache-mgmt/loader.php': 'IGNORED',
			'/mu-plugins/activity-log.php': 'IGNORED',
			'/mu-plugins/keep-me.php': 'SENT',
		},
	},

	// ------------------------------------------------------- ordering edge cases
	{
		name: 'specificity beats authoring order for a negation written first',
		gitDiffers: 'git is last-match-wins, so git would ignore /config/local.php',
		rules: `
			!/config/local.php
			/config/*.php
		`,
		send: {
			'/config/local.php': 'SENT',
			'/config/db.php': 'IGNORED',
		},
	},
	{
		name: 'equal specificity keeps authoring order (last wins, like git)',
		rules: `
			!/a/b
			/a/b
		`,
		send: { '/a/b': 'IGNORED' },
	},
	{
		name: 'equal specificity keeps authoring order (reversed)',
		rules: `
			/a/b
			!/a/b
		`,
		send: { '/a/b': 'SENT' },
	},
	{
		name: 'a mid-pattern slash is NOT anchored to the root',
		gitDiffers: 'git anchors config/secret.php to the root; rsync matches it at any depth',
		rules: `config/secret.php`,
		send: {
			'/config/secret.php': 'IGNORED',
			'/wp-content/config/secret.php': 'IGNORED',
		},
	},
	{
		name: 'a "!" inside a pattern is literal, not a negation',
		rules: `
			/weird!name.php
		`,
		send: { '/weird!name.php': 'IGNORED' },
	},

	// ------------------------------------------------------- protect (new)
	{
		name: 'protect: overwrite our files, never delete theirs',
		rules: `
			protect /mu-plugins/
		`,
		send: { '/mu-plugins/ours.php': 'SENT' },
		remote: {
			// Their stale copy of a file we DO ship must actually be replaced.
			'/mu-plugins/ours.php': 'OVERWRITTEN',
			'/mu-plugins/hand-placed.php': 'KEPT',
			'/mu-plugins/nested/theirs.php': 'KEPT',
			'/other/stale.php': 'DELETED',
		},
	},
	{
		name: 'risk: carve an exception out of a protect',
		rules: `
			protect /mu-plugins/
			risk /mu-plugins/tmp/
		`,
		send: { '/mu-plugins/ours.php': 'SENT' },
		remote: {
			'/mu-plugins/hand-placed.php': 'KEPT',
			'/mu-plugins/tmp/junk.php': 'DELETED',
		},
	},

	// ---------------------------------------------------------- hide (new)
	{
		name: 'hide: stop sending, and let --delete clean up what we already pushed',
		rules: `
			hide /old-plugin/
		`,
		local: [ '/keep.php' ],
		send: { '/old-plugin/x.php': 'IGNORED' },
		remote: { '/old-plugin/leftover.php': 'DELETED' },
	},
	{
		name: 'exclude protects the remote copy; hide does not (the whole point)',
		rules: `
			/excluded/
			hide /hidden/
		`,
		local: [ '/keep.php' ],
		send: {
			'/excluded/x.php': 'IGNORED',
			'/hidden/x.php': 'IGNORED',
		},
		remote: {
			'/excluded/stale.php': 'KEPT',
			'/hidden/stale.php': 'DELETED',
		},
	},
	{
		name: 'show: carve an exception out of a hide',
		rules: `
			hide /legacy/*
			show /legacy/keep.php
		`,
		send: {
			'/legacy/drop.php': 'IGNORED',
			'/legacy/keep.php': 'SENT',
		},
		remote: { '/legacy/stale.php': 'DELETED' },
	},
	{
		name: 'show cannot reach inside a wholly hidden directory (same rule as git)',
		rules: `
			hide /legacy/
			show /legacy/keep.php
		`,
		send: { '/legacy/keep.php': 'IGNORED' },
	},
	{
		name: 'hide: an extraneous directory is removed whole, contents included',
		rules: `hide /gone/`,
		local: [ '/keep.php' ],
		// Nothing local under /gone, so rsync never descends and never deletes inside it.
		// The directory itself is still removed, because it is extraneous at the root.
		remote: { '/gone/deep/leftover.php': 'DELETED' },
	},

	// ------------------------------------- new rule types inside a real-shaped list
	{
		name: 'protect/hide slot into a whitelist-style list at the right specificity',
		rules: `
			/*
			/wp-content/*
			!/wp-content/
			!/wp-content/plugins/
			!/wp-content/mu-plugins/
			protect /wp-content/mu-plugins/
			hide /wp-content/plugins/dead-plugin/
		`,
		send: {
			'/wp-content/plugins/acme/acme.php': 'SENT',
			'/wp-content/plugins/dead-plugin/x.php': 'IGNORED',
			'/wp-content/mu-plugins/ours.php': 'SENT',
		},
		remote: {
			'/wp-content/mu-plugins/theirs.php': 'KEPT',
			'/wp-content/plugins/dead-plugin/leftover.php': 'DELETED',
		},
	},
	{
		name: 'long-form and short-form prefixes are equivalent',
		rules: `
			P /a/
			H /b/*
			R /a/tmp/
			S /b/keep.php
		`,
		send: {
			'/a/ours.php': 'SENT',
			'/b/drop.php': 'IGNORED',
			'/b/keep.php': 'SENT',
		},
		remote: {
			'/a/theirs.php': 'KEPT',
			'/a/tmp/junk.php': 'DELETED',
			'/b/stale.php': 'DELETED',
		},
	},

	{
		// If `show` emitted "+" instead of "S", keep.php would lose the exclude's
		// delete-protection on the receiver and be removed. S is sender-side only.
		name: 'show is sender-side only, unlike an include',
		rules: `
			/legacy/*
			show /legacy/keep.php
		`,
		local: [ '/keep.php' ],
		send: { '/legacy/other.php': 'IGNORED' },
		remote: { '/legacy/keep.php': 'KEPT' },
	},
	{
		// The hide must reach the CONTENTS for the subtree expansion to matter: "*" does
		// not cross "/", so `hide /legacy/*` would leave keep/a.php unmatched either way.
		name: 'show on a directory brings its contents',
		rules: `
			hide /legacy/**
			show /legacy/keep/
		`,
		send: {
			'/legacy/keep/a.php': 'SENT',
			'/legacy/drop/b.php': 'IGNORED',
		},
	},

	// ------------------------------------- regressions caught in review
	{
		// Written protect-FIRST. Reverse-authoring order alone would put the include
		// first, and an include tells the delete pass the path is fair game -- so this
		// only passes because of the kind precedence in sortRules.
		name: 'protect still wins when written BEFORE the include it is paired with',
		rules: `
			/*
			protect /mu-plugins/
			!/mu-plugins/
		`,
		send: { '/mu-plugins/ours.php': 'SENT' },
		remote: { '/mu-plugins/hand-placed.php': 'KEPT' },
	},
	{
		// The delete pass ignores H rules entirely, so an exclude on the same path still
		// protects it. Adding `hide` next to an existing exclude does NOT start cleaning
		// up -- the exclude has to go. Easy to get wrong, so pin it.
		name: 'an exclude on the same path still protects it, even alongside a hide',
		rules: `
			/uploads/
			hide /uploads/
		`,
		local: [ '/keep.php' ],
		remote: { '/uploads/stale.jpg': 'KEPT' },
	},
	{
		name: 'hide alone (no competing exclude) does clean up',
		rules: `
			hide /uploads/
		`,
		local: [ '/keep.php' ],
		remote: { '/uploads/stale.jpg': 'DELETED' },
	},
	{
		name: 'a mistyped prefix is treated as a literal path, not silently as protect',
		rules: `
			Protect /mu-plugins/
		`,
		// Case-insensitive now, so this really does protect.
		send: { '/mu-plugins/ours.php': 'SENT' },
		remote: { '/mu-plugins/hand-placed.php': 'KEPT' },
	},
	{
		// Distinguishes the asterisks-only score (5) from asterisks-plus-chars (10).
		name: 'a glob with characters is more specific than a bare glob',
		rules: `
			/a/*
			!/a/*.php
		`,
		send: { '/a/keep.php': 'SENT', '/a/drop.txt': 'IGNORED' },
	},

	// ------------------------------------------------------------- hygiene
	{
		name: 'comments, blank lines and duplicates are stripped',
		rules: `
			# a comment
			/a.php

			/a.php
			  /b.php
		`,
		send: { '/a.php': 'IGNORED', '/b.php': 'IGNORED', '/c.php': 'SENT' },
	},
	{
		name: 'CRLF line endings survive (GitHub variables often carry them)',
		rules: "/a.php\r\n/b.php\r\n",
		send: { '/a.php': 'IGNORED', '/b.php': 'IGNORED' },
	},
];
