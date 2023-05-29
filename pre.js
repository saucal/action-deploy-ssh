( async function () {
	const exec = require( '@actions/exec' );
	const core = require( '@actions/core' );
	const fs = require( 'fs' );
	await exec.exec( 'mkdir', ['-p', '/home/runner/.ssh'] );
	await exec.exec( 'touch', ['/home/runner/.ssh/known_hosts'] );

	const remoteHost = core.getInput( 'env-host', { required: true } );
	const remotePort = core.getInput( 'env-port', { required: false } );

	let output = '';
	await exec.exec( 'ssh-keyscan', ['-p', remotePort, '-H', remoteHost], {
		listeners: {
			stdout: ( data ) => {
				output += data.toString();
			}
		},
		silent: true
	} );
	
	console.log( 'KeyScan output' );
	console.log( 'type' );
	console.log( typeof output );
	console.log( 'output string' );
	console.log( output.toString() );
	console.log( 'original file' );
	console.log( fs.readFileSync( '/home/runner/.ssh/known_hosts' ).toString() );
	console.log( 'writing file' );
	fs.appendFileSync( '/home/runner/.ssh/known_hosts', output.toString() );
	console.log( 'new file' );
	console.log( fs.readFileSync( '/home/runner/.ssh/known_hosts' ).toString() );
	process.exit( 1 );
} )();
