( async function () {
	const core = require( '@actions/core' );
	const exec = require( '@actions/exec' );
	const fs = require( 'fs' );
	const Rsync = require( 'rsync' );
	const path = require( 'path' );
	const rsyncRulesFormatter = require('./rsyncRulesFormatter');

	const remoteTarget =
		core.getInput( 'env-user', { required: true } ) +
		'@' +
		core.getInput( 'env-host', { required: true } );
	const remotePort = core.getInput( 'env-port', { required: false } );
	const sshKey = core.getInput( 'env-key', { required: false } );
	const sshPass = core.getInput( 'env-pass', { required: false } );
	const consistencyCheck = core.getInput( 'consistency-check', { required: false } );

	let ignoreList = core.getInput( 'force-ignore', { required: false } );
	if ( ignoreList === 'false' ) {
		ignoreList = fs.readFileSync( path.join( __dirname, 'default-ignore.txt' ), 'utf8' ).toString();
	}
	let ignoreListExtra = core.getInput( 'force-ignore-extra', { required: false } );
	if ( ignoreListExtra !== 'false' ) {
		ignoreList += "\n" + ignoreListExtra
	}
	let ignoreListRaw = ignoreList;
	let shellParams = core.getInput( 'ssh-shell-params', { required: false } );
	let sshFlags = core.getInput( 'ssh-flags', { require: true } );
	let actionPrePush = core.getInput( 'action-pre-push', { require: false } );
	let extraOptions = core.getInput( 'ssh-extra-options', {
		required: false,
	} );
	let handlePerms = core.getInput( 'ssh-handle-perms', { required: false } );
	let localRoot = core.getInput( 'env-local-root', { required: true } );
	let remoteRoot = core.getInput( 'env-remote-root', { required: true } );
	let manifest = core.getInput( 'manifest', { required: false } );

	// Make sure paths end with a slash.
	localRoot = ! localRoot.endsWith( '/' ) ? localRoot + '/' : localRoot;
	remoteRoot = ! remoteRoot.endsWith( '/' ) ? remoteRoot + '/' : remoteRoot;

	if ( '' === sshKey && '' === sshPass ) {
		core.setFailed(
			'You need to provide either an SSH password or an SSH key'
		);
		return;
	}

	if ( consistencyCheck ) {
		console.log( '::group::Running consistency check.' );
	} else {
		console.log( '::group::Running rsync.' );
	}

	// Set defaults.
	sshFlags = '' !== sshFlags ? sshFlags : 'avrcz';
	extraOptions =
		'' !== extraOptions
			? extraOptions
			: 'delete no-inc-recursive size-only ignore-times omit-dir-times no-owner no-group no-dirs';

	if ( handlePerms == 'true' ) {
		extraOptions += ' perms';
	} else {
		extraOptions += ' no-perms';
	}

	shellParams = shellParams.split( ' ' );
	extraOptions = extraOptions.split( ' ' );
	shell = sshPass ? 'sshpass -e ssh' : 'ssh';
	if( sshPass ) {
		process.env['SSHPASS'] = sshPass;
	}

	if ( remotePort ) {
		shellParams.push( '-p ' + remotePort );
	}

	var rsync = new Rsync()
		.flags( sshFlags )
		.source( localRoot )
		.destination( remoteTarget + ':' + remoteRoot );

	if ( shellParams.length > 0 ) {
		rsync.shell( shell + ' ' + shellParams.join( ' ' ) );
	}

	for ( let i = 0; i < extraOptions.length; i++ ) {
		rsync.set( extraOptions[ i ] );
	}

	if ( ignoreList ) {
		const formattedRules = rsyncRulesFormatter.run( ignoreList );

		console.log( 'Applied Ignore rules: ' );
		console.log( formattedRules );

		// Write the rules to a file.
		const rulesFile = '/tmp/rsync_rules_' + Date.now() + '.txt';
		fs.writeFileSync( rulesFile, formattedRules );

		rsync.set( '--filter="merge ' + rulesFile + '"' );
	}

	if ( core.isDebug() ) {
		rsync.debug( true );
	}

	var rsyncCommand = rsync.command();
	var dryRunCommand = rsyncCommand.replace( '-' + sshFlags, '-' + sshFlags.replace( 'v', '' ) ).replace( /^rsync/, 'rsync --dry-run --info=NAME' );

	function writeBufferToFile( outputBuffer ) {
		var i = 0, bufferPath;
		do {
			i++;
			bufferPath = '/tmp/rsync_output_buffer_' + i + '.txt';
		} while	( fs.existsSync( bufferPath ) );
		fs.writeFileSync( bufferPath, outputBuffer );
		return bufferPath;
	}

	async function runCommand( cmd ) {
		let processedFiles = 0;
		let outputBuffer = '';

		console.log( cmd );

		error = '';
		var code = await exec.exec( cmd, [], {
			listeners: {
				stdline: ( data ) => {
					// do things like parse progress
					processedFiles++;
					outputBuffer += data.toString() + '\n';
					console.log( data.toString() );
				},
				errline: ( data ) => {
					error += data.toString() + '\n';
				}
			},
			outStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );

		if ( code != 0 && code != 24 ) {
			// 24 is the code for "some files vanished while we were building the file list" See https://rsync.samba.org/FAQ.html#10
			console.error( 'rsync error: ' + error );
			console.error( 'rsync code: ' + code );
			core.setFailed( 'rsync failed with code ' + code );
			process.exit( code );
		}

		let bufferPath = writeBufferToFile( outputBuffer );

		return { code, processedFiles, bufferPath };
	}

	// If we are doing just a consistency check, or we have a manifest to check against, run the dry-run command first.
	if ( consistencyCheck || manifest != '' ) {
		var { code, processedFiles, bufferPath } = await runCommand( dryRunCommand );

		// If we have the consistency check to run, check that there's no files changed.
		if ( consistencyCheck ) {
			if( processedFiles > 0 ) {
				console.log( '::error title=Pre-push consistency check failed. Target filesystem does not match build directory.::' );
				core.setOutput( 'bufferPath', bufferPath );
				core.setFailed(
					'Pre-push consistency check failed. Target filesystem does not match build directory.'
				);
				process.exit( 1 );
			}
		}

		// If we have a manifest file to check against, run the check-against-manifest.sh script.
		// When we have a manifest, we are not doing a consistency check. We are checking against the manifest, 
		// and if the check passes, we are doing the actual sync (and core version change if needed)
		if ( manifest != '' ) {
			var code = await exec.exec( 'bash', [ __dirname + '/check-against-manifest.sh' ], {
				env: {
					PATH_DIR: localRoot,
					SSH_IGNORE_LIST: ignoreListRaw,
					GIT_MANIFEST: manifest,
					RSYNC_MANIFEST: bufferPath,
					GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
				},
				ignoreReturnCode: true,
			} );
		
			if ( code != 0 ) {
				core.setFailed(
					'Pre-push consistency check failed. Manifest file does not match what Rsync is about to do.'
				);
				process.exit( code );
			}
		}
	}

	// Find pre-push actions in the temp runner and run them.
	const preScriptsPath = path.join( process.env.RUNNER_TEMP, '.saucal', 'ssh-deploy', 'pre' );

	var files = fs.existsSync( preScriptsPath ) ? fs.readdirSync( preScriptsPath ) : [];
	var promises = [];
	for( let actionPrePush of files ) {
		promises.push( async () => {
			console.log( 'Running pre-push action/script: ' + actionPrePush );
		
			const sshCommand = shell + ' ' + remoteTarget + ' ' + shellParams.join( ' ' );
			console.log( 'sshCommand: ' + sshCommand );
	
			var code = await exec.exec( 'bash', [ path.join( preScriptsPath, actionPrePush ) ], {
				env: {
					PATH_DIR: localRoot,
					GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
					SSH_COMMAND: sshCommand,
					REMOTE_ROOT: remoteRoot,
					SSHPASS: sshPass,
					CONSISTENCY_CHECK: ( ( consistencyCheck || manifest != '' ) ? 'true' : 'false' ),
					RUNNER_TEMP: process.env.RUNNER_TEMP,
				},
				ignoreReturnCode: true,
			} );
		
			if ( code != 0 ) {
				core.setFailed(
					'actionPrePush script "' + actionPrePush + '" failed with code ' + code + '. There is likely more information above.'
				);
				process.exit( code );
			}

			console.log( 'Finished pre-push action/script: ' + actionPrePush );
		} );
	}

	// Intentionally process in series, not in parallel (which could be done with soething like Promise.all).
	for (let promise of promises) {
		await promise();
	}

	if ( consistencyCheck ) {
		process.exit( 0 );
	}

	var { code, processedFiles, bufferPath } = await runCommand( rsyncCommand );
	console.log( '::endgroup::' );
} )();
