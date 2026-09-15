// Seed cases proving the harness works against the unmodified action.
module.exports = [
	{
		name: 'smoke: a plain exclude is not sent',
		rules: '/uploads/',
		local: [ '/keep.php' ],
		send: { '/uploads/a.jpg': 'IGNORED', '/keep.php': 'SENT' },
	},
	{
		name: 'smoke: an exclude also protects the target copy from --delete',
		rules: '/uploads/',
		local: [ '/keep.php' ],
		remote: { '/uploads/stale.jpg': 'KEPT', '/junk.txt': 'DELETED' },
	},
	{
		name: 'smoke: the manifest check forgives an excluded path',
		rules: '/vendor/',
		manifest: {
			git: '+ plugins/a.php\n+ vendor/autoload.php\n',
			rsync: 'plugins/a.php\n',
			expect: 'MATCH',
		},
	},
	{
		name: 'smoke: the manifest check still fails on real drift',
		rules: '/vendor/',
		manifest: {
			git: '+ plugins/a.php\n',
			rsync: 'plugins/a.php\ndeleting themes/x.css\n',
			expect: 'MISMATCH',
		},
	},
];
