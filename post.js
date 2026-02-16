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

	// Remove the SSH agent socket if it exists
	const sock = '/tmp/ssh_agent.sock';
	if( fs.existsSync( sock ) ) {
		try {
			await exec.exec( 'ssh-agent', ['-k'] );
		} catch (error) {
			core.warning(error.message);
		}
		await exec.exec( 'rm', ['-f', sock] );
	}
} )();
