( async function () {
	const exec = require( '@actions/exec' );
	const core = require( '@actions/core' );
	const fs = require( 'fs' );

	if ( core.getInput( 'run-post', { required: true } ) == 'false' ) {
		return;
	}

	var i = 1, keyPath;
	keyPath = '/home/runner/.ssh/github_actions_' + i;
	while( fs.existsSync( keyPath ) ) {
		await exec.exec( 'rm', ['-f', keyPath] );
		i++;
		keyPath = '/home/runner/.ssh/github_actions_' + i;
	}
} )();
