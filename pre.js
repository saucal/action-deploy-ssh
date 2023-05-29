( async function () {
	const exec = require( '@actions/exec' );
	const core = require( '@actions/core' );
	const fs = require( 'fs' );
	await exec.exec( 'mkdir', ['-p', '/home/runner/.ssh'] );
	await exec.exec( 'touch', ['/home/runner/.ssh/known_hosts'] );

	const remoteHost = core.getInput( 'env-host', { required: true } );
	const remotePort = core.getInput( 'env-port', { required: false } );

	await exec.exec( 'bash', ['-c', 'ssh-keyscan -p "' + remotePort + '" -H "' + remoteHost + '" >> /home/runner/.ssh/known_hosts' ] );

	const remoteKey = core.getInput( 'env-key', { required: false } );
	if( remoteKey != '' ) {
		const sock = '/tmp/ssh_agent.sock';
		if( ! fs.existsSync( sock ) ) {
			core.exportVariable( 'SSH_AUTH_SOCK', sock );
			process.env['SSH_AUTH_SOCK'] = sock;
			await exec.exec( 'ssh-agent', ['-a', sock] );
		}

		var i = 0;
		var keyPath;
		do {
			i++;
			keyPath = '/home/runner/.ssh/github_actions_' + i;
		} while	( fs.existsSync( keyPath ) );

		await exec.exec( 'bash', ['-c', 'echo "' + remoteKey + '" > ' + keyPath ] );
		await exec.exec( 'chmod', ['600', keyPath] );
		await exec.exec( 'ssh-add', [keyPath] );
	}
} )();
