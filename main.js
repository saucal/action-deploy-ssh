

(async function() {

	const core = require('@actions/core');
	const Rsync = require('rsync');

	const remoteTarget = core.getInput('env-user', { required: true }) + '@' + core.getInput('env-host', { required: true })
	const remotePort = core.getInput('env-port', { required: false })

	var rsync = new Rsync()
	  .shell( 'ssh -oStrictHostKeyChecking=no -i /home/runner/.ssh/github_actions -vv -p ' + remotePort )
	  .flags( core.getInput( 'env-ssh-flags', {require: true }) )
	  .source( core.getInput('env-local-root', { required: true } ) )
	  .destination( remoteTarget + ':' + core.getInput('env-remote-root', { required: true }));
	
	rsync.debug( true ); // core.isDebug()

	console.log( rsync.command() );

	// Execute the command
	rsync.execute(function(error, code, cmd) {
		// we're done
		if ( code != 0 ) {
			console.error( 'rsync error: ' + error );
			console.error( 'rsync code: ' + code );
			core.setFailed( 'rsync failed with code ' + code );
		}
	}, function(data){
        // do things like parse progress
		console.log( data.toString() );
    }, function(data) {
        // do things like parse error output
		console.error( data.toString() );
    }
	);

})()
