( async function () {
	const exec = require( '@actions/exec' );
	const core = require( '@actions/core' );
	const fs = require( 'fs' );

	const remoteHost = core.getInput( 'env-host', { required: false } );
	const remotePort = core.getInput( 'env-port', { required: false } );
	const remoteUser = core.getInput( 'env-user', { required: false } );
	const remoteKey = core.getInput( 'env-key', { required: false } );
	const remotePass = core.getInput( 'env-pass', { required: false } );
	const shellParams = core.getInput( 'ssh-shell-params', { required: false } );
	// Strip trailing slashes to match how main.js normalises the remote root.
	const remoteRoot = core.getInput( 'env-remote-root', { required: false } ).replace( /\/+$/, '' );
	const sock = '/tmp/ssh_agent.sock';

	// Credential setup is gated by run-pre: when deploy-ssh is invoked multiple
	// times in a flow (e.g. consistency-check then push), later invocations pass
	// run-pre=false to reuse the agent / known_hosts / sshpass left on the runner.
	if ( core.getInput( 'run-pre', { required: true } ) != 'false' ) {
		await exec.exec( 'mkdir', ['-p', '/home/runner/.ssh'] );
		await exec.exec( 'touch', ['/home/runner/.ssh/known_hosts'] );

		if( remoteHost != '' ) {
			await exec.exec( 'bash', ['-c', 'ssh-keyscan -p "' + remotePort + '" -H "' + remoteHost + '" >> /home/runner/.ssh/known_hosts' ] );
		}

		if( remoteKey != '' ) {
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
			await exec.exec( 'bash', ['-c', 'ssh-add ' + keyPath ] );
		}

		if( remotePass != '' ) {
			await exec.exec( 'sudo', ['apt-get', 'install', '-y', 'sshpass'] );
		}
	}

	// Preflight: validate the provided credentials with a cheap test connection.
	// This runs on EVERY invocation (independent of run-pre) so auth/connectivity
	// failures surface here with a clear message instead of a confusing rsync
	// error mid-deploy. When run-pre=false the setup above was done by an earlier
	// invocation and persists on the runner, so the test still works.
	if (
		core.getInput( 'preflight', { required: false } ) != 'false' &&
		remoteHost != '' &&
		( remoteKey != '' || remotePass != '' )
	) {
		core.startGroup( 'Validating SSH credentials.' );

		// Build the ssh invocation as an explicit argv array and call exec.exec in
		// its array form (tool + args). The string form runs each argument through
		// @actions/exec's tokenizer, which only honours double quotes and treats
		// single quotes as literal characters - that mangles the remote-side test
		// command below. Array form passes every argument verbatim, so the remote
		// command reaches ssh as a single intact argument.
		var tool;
		const baseArgs = [];

		if ( remotePass != '' ) {
			// Password auth: feed the password via the SSHPASS env, never the CLI.
			tool = 'sshpass';
			baseArgs.push( '-e', 'ssh' );
			process.env['SSHPASS'] = remotePass;
		} else {
			tool = 'ssh';
			// Make sure we point at the agent the setup step started, even when
			// run-pre=false skipped exporting it into this process.
			if ( ! process.env['SSH_AUTH_SOCK'] && fs.existsSync( sock ) ) {
				process.env['SSH_AUTH_SOCK'] = sock;
			}
		}

		// User-supplied ssh shell params (e.g. ProxyJump), each as its own token.
		shellParams.split( ' ' ).filter( ( p ) => p !== '' ).forEach( ( p ) => baseArgs.push( p ) );
		if ( remotePort != '' ) {
			baseArgs.push( '-p', remotePort );
		}
		// Fail fast on connection issues and auto-trust the host key (known_hosts
		// may not have been populated yet when run-pre=false on a first call).
		baseArgs.push( '-o', 'ConnectTimeout=15' );
		baseArgs.push( '-o', 'StrictHostKeyChecking=accept-new' );
		if ( remotePass == '' ) {
			// Key auth: never fall back to an interactive prompt (would hang).
			baseArgs.push( '-o', 'BatchMode=yes' );
		}

		const target = ( remoteUser != '' ? remoteUser + '@' : '' ) + remoteHost;
		baseArgs.push( target );

		const authArgs = baseArgs.concat( [ 'true' ] );
		console.log( [ tool ].concat( authArgs ).join( ' ' ) );

		const code = await exec.exec( tool, authArgs, { ignoreReturnCode: true } );

		if ( code != 0 ) {
			core.endGroup();
			core.setFailed(
				'SSH preflight failed: the provided ' +
					( remotePass != '' ? 'password' : 'SSH key' ) +
					' was rejected or the host is unreachable (exit code ' +
					code +
					'). Verify the credentials, host, port and that the key is authorized on the target.'
			);
			process.exit( code );
		}

		console.log( 'SSH credentials validated.' );

		// Validate that the remote root is deployable: either an existing writable
		// directory, or (for a first deploy) a path whose parent exists and is
		// writable so rsync can create the final directory. Catches missing-path /
		// wrong-permission misconfig here instead of as a confusing rsync error.
		if ( remoteRoot != '' ) {
			// Passed as a single argv element, so it reaches the remote shell intact;
			// the double quotes and dirname are evaluated on the target.
			const remoteTest =
				'test -d "' + remoteRoot + '" && test -w "' + remoteRoot + '" || ' +
				'{ test ! -e "' + remoteRoot + '" && ' +
				'test -d "$(dirname "' + remoteRoot + '")" && ' +
				'test -w "$(dirname "' + remoteRoot + '")"; }';

			const pathArgs = baseArgs.concat( [ remoteTest ] );
			console.log( [ tool ].concat( pathArgs ).join( ' ' ) );

			const pathCode = await exec.exec( tool, pathArgs, { ignoreReturnCode: true } );

			if ( pathCode != 0 ) {
				core.endGroup();
				core.setFailed(
					'SSH preflight failed: remote path "' +
						remoteRoot +
						'" is not deployable. It must be an existing writable directory, ' +
						'or (for a first deploy) its parent must exist and be writable so ' +
						'rsync can create it. Check the path and the deploy user\'s permissions.'
				);
				process.exit( pathCode );
			}

			console.log( 'Remote path validated.' );
		}

		core.endGroup();
	}
} )();
