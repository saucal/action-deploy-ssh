// A representative wp-content tree, covering every rule shape that appears in the fleet's
// real SSH_IGNORE_LIST values: plain anchored files, directories, unanchored names, globs
// with and without characters, wildcard directory segments, ** patterns and negations.
//
// `local` is what a build produces; `remote` is what is already on the server, including
// files a build never produces (hand-placed, runtime junk) so --delete has something to
// decide about.
//
// Both path spaces are represented. Most repos deploy AT wp-content, so their rules read
// `/plugins/...`; a few deploy at the web root and write `/wp-content/plugins/...`. A tree
// in only one space silently matches nothing for the other half of the fleet.

// Every path is emitted twice: once as authored, and once under /wp-content, so rules
// written in either space find something to match.
function mirror( p ) {
	return p.startsWith( '/wp-content/' ) ? [ p ] : [ p, '/wp-content' + p ];
}

module.exports = {
	local: [
		'/.git/config',
		'/.gitattributes',
		'/wp-config.php',
		'/index.php',
		'/README.md',
		'/.gitignore',
		'/.github/workflows/deploy.yml',
		'/composer.json',
		'/composer.lock',
		'/auth.json',
		'/object-cache.php',
		'/db.php',
		'/advanced-cache.php',
		'/.object-cache.ini',
		'/debug.log',
		'/wp-debug.log',
		'/error_log',
		'/vendor/autoload.php',
		'/vendor/composer/installed.json',
		'/vendor/composer/installers/src/Installer.php',
		'/vendor/monolog/monolog/src/Logger.php',
		'/plugins/index.php',
		'/plugins/woocommerce/woocommerce.php',
		'/plugins/woocommerce/i18n/languages/wc.mo',
		'/plugins/acme/acme.php',
		'/plugins/acme/vendor/autoload.php',
		'/plugins/acme/node_modules/dep/index.js',
		'/plugins/wp-rocket/wp-rocket.php',
		'/plugins/wp-rocket/licence-data.php',
		'/plugins/sfwd-lms/languages/learndash-en_US.po',
		'/plugins/generateblocks/package.json',
		'/plugins/yith-points-modifications/resources/cache/c.php',
		'/themes/index.php',
		'/themes/kadence/style.css',
		'/themes/kadence/functions.php',
		'/themes/kadence-child/style.css',
		'/themes/woodmart/error_log',
		'/mu-plugins/index.php',
		'/mu-plugins/saucal-helper.php',
		'/mu-plugins/cdn-cache-management.php',
		'/mu-plugins/cdn-cache-management/loader.php',
		'/languages/en_US.mo',
	].flatMap( mirror ),
	remote: [
		// Runtime state and things a build never produces. These are what the ignore rules
		// are really for: some must survive, some must be cleaned up.
		'/uploads/2024/01/photo.jpg',
		'/uploads/woocommerce_uploads/invoice.pdf',
		'/upgrade/tmp.php',
		'/upgrade-temp-backup/plugins/x.php',
		'/cache/page/index.html',
		'/updraft/backup.zip',
		'/ai1wm-backups/site.wpress',
		'/wflogs/config.php',
		'/jetpack-waf/rules.php',
		'/aiowps_backups/dump.sql',
		'/wp-rocket-config/site.php',
		'/mc_data/state.json',
		'/saucal_migration_20240101/dump.sql',
		'/mu-plugins/hand-placed-by-host.php',
		'/plugins/hello-dolly/hello.php',
		'/object-cache.php',
		'/debug.log',
		'/error_log',
		'/.object-cache.ini',
		'/plugins/wp-rocket/licence-data.php',
		'/plugins/acme/uploads/user-upload.pdf',
	].flatMap( mirror ),
};
