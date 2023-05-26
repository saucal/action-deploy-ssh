( async function () {
	const exec = require( '@actions/exec' );
	const core = require( '@actions/core' );
	const fs = require( 'fs' );
	exec.exec( 'mkdir', ['-p', '/home/runner/.ssh'] );

	const remoteHost = core.getInput( 'env-host', { required: true } );
	const remotePort = core.getInput( 'env-port', { required: false } );

	let output = '';
	await exec.exec( 'ssh-keyscan', ['-p', remotePort, '-H', remoteHost], {
		listeners: {
			stdout: ( data ) => {
				output += data.toString();
			}
		}
	} );
	fs.appendFileSync( '/home/runner/.ssh/known_hosts', output );
} )();
