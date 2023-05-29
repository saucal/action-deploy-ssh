( async function () {
	var i = 1, keyPath;
	keyPath = '/home/runner/.ssh/github_actions_' + i;
	while( fs.existsSync( keyPath ) ) {
		await exec.exec( 'rm', ['-f', keyPath] );
		i++;
		keyPath = '/home/runner/.ssh/github_actions_' + i;
	}
} )();
