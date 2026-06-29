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
		core.startGroup( 'Validating SSH connection and remote path.' );

		// Build the ssh invocation as an explicit argv array and call exec.exec in
		// its array form (tool + args). The string form runs each argument through
		// @actions/exec's tokenizer, which only honours double quotes and treats
		// single quotes as literal characters - that would mangle the remote script
		// below. Array form passes every argument verbatim, so the script reaches
		// ssh as a single intact argument.
		//
		// Note: we deliberately pass the script as one ssh argument rather than
		// piping it over stdin. sshpass drives ssh through a pty to inject the
		// password and does not forward our stdin to the remote command, so a
		// stdin-fed script would break password auth. A single argv element works
		// for both key and password auth.
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

		// Single-line remote check: every statement separated by ';', never by
		// newlines. Some SSH gateways (e.g. WP Engine's Go gateway) flatten the
		// exec command - collapsing all whitespace and stripping quotes before
		// running it through bash -c - so a newline-separated script fuses into
		// one broken line. A ';'-joined one-liner survives that and still runs on
		// a normal shell. Connecting at all already proves auth + connectivity;
		// this checks the remote root is deployable: an existing writable
		// directory, or (for a first deploy) a writable parent so rsync can
		// create it. Paths are assumed free of spaces (true for hosting roots),
		// since the gateway strips the quotes that would otherwise protect them.
		const script =
			"root='" + remoteRoot.replace( /'/g, "'\\''" ) + "'; " +
			'if [ -z "$root" ] || ' +
			'{ [ -d "$root" ] && [ -w "$root" ]; } || ' +
			'{ [ ! -e "$root" ] && [ -d "$(dirname "$root")" ] && [ -w "$(dirname "$root")" ]; }; ' +
			'then echo PREFLIGHT_OK; ' +
			'else echo "PREFLIGHT_FAIL:remote path not deployable - need an existing writable directory, or a writable parent for a first deploy"; exit 11; fi';

		const args = baseArgs.concat( [ script ] );
		console.log( [ tool ].concat( baseArgs ).join( ' ' ) + ' <remote preflight script>' );

		let output = '';
		const code = await exec.exec( tool, args, {
			ignoreReturnCode: true,
			listeners: {
				stdout: ( data ) => { output += data.toString(); },
				stderr: ( data ) => { output += data.toString(); },
			},
		} );

		if ( code != 0 ) {
			core.endGroup();
			const failMatch = output.match( /PREFLIGHT_FAIL:(.*)/ );
			if ( failMatch ) {
				// Reached the remote shell, so auth/connectivity was fine: a check failed.
				core.setFailed(
					'SSH preflight failed: ' + failMatch[ 1 ].trim() +
						' (remote path "' + remoteRoot + '"). Check the path and the ' +
						'deploy user\'s permissions.'
				);
			} else {
				// Never reached the script: connection or authentication problem.
				core.setFailed(
					'SSH preflight failed: could not connect or authenticate to ' + target +
						' (exit code ' + code + '). The ' +
						( remotePass != '' ? 'password' : 'SSH key' ) +
						' was rejected, or the host/port is unreachable.'
				);
			}
			process.exit( code );
		}

		console.log( 'SSH connection and remote path validated.' );
		core.endGroup();
	}
} )();
