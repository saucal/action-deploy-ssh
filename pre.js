( async function () {
	const exec = require( '@actions/exec' );
	const core = require( '@actions/core' );
	const fs = require( 'fs' );
	await exec.exec( 'mkdir', ['-p', '/home/runner/.ssh'] );
	await exec.exec( 'touch', ['/home/runner/.ssh/known_hosts'] );

	const remoteHost = core.getInput( 'env-host', { required: true } );
	const remotePort = core.getInput( 'env-port', { required: false } );

	await exec.exec( 'bash', ['-c', 'ssh-keyscan -p "' + remotePort + '" -H "' + remoteHost + '" >> /home/runner/.ssh/known_hosts' ] );
} )();
