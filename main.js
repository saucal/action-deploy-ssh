

(async function() {

	const core = require('@actions/core');
	const Rsync = require('rsync');

	const remoteTarget = core.getInput('env-user', { required: true }) + '@' + core.getInput('env-host', { required: true })
	const remotePort = core.getInput('env-port', { required: false })

	var rsync = new Rsync()
	  .shell( 'ssh -p ' + remotePort )
	  .flags( core.getInput( 'env-ssh-flags', {require: true }) )
	  .source( core.getInput('env-local-root', { required: true } ) )
	  .destination( remoteTarget + ':' + core.getInput('env-remote-root', { required: true }));
	
	rsync.debug( true ); // core.isDebug()

	console.log( rsync.command() );

	// if ( remotePort && remotePort != 22 ) {
		// rsync.set('shell', '"ssh -p ' + remotePort + '"' );
	// }

	// Execute the command
	rsync.execute(function(error, code, cmd) {
		// we're done
		console.log( 'rsync error: ' + error );
		console.log( 'rsync code: ' + code );

		if ( code != 0 ) {
			core.setFailed( 'rsync failed with code ' + code );
		}
	});

})()
