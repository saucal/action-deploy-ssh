( async function () {
	const core = require( '@actions/core' );
	const exec = require( '@actions/exec' );
	const fs = require( 'fs' );
	const Rsync = require( 'rsync' );

	const remoteTarget =
		core.getInput( 'env-user', { required: true } ) +
		'@' +
		core.getInput( 'env-host', { required: true } );
	const remotePort = core.getInput( 'env-port', { required: false } );
	const sshKey = core.getInput( 'env-key', { required: false } );
	const sshPass = core.getInput( 'env-pass', { required: false } );
	const consistencyCheck = core.getInput( 'consistency-check', { required: false } );

	let ignoreList = core.getInput( 'force-ignore', { required: false } );
	let ignoreListRaw = ignoreList;
	let shellParams = core.getInput( 'ssh-shell-params', { required: false } );
	let sshFlags = core.getInput( 'ssh-flags', { require: true } );
	let extraOptions = core.getInput( 'ssh-extra-options', {
		required: false,
	} );
	let localRoot = core.getInput( 'env-local-root', { required: true } );
	let remoteRoot = core.getInput( 'env-remote-root', { required: true } );
	let manifest = core.getInput( 'manifest', { required: false } );

	// Make sure paths end with a slash.
	localRoot = ! localRoot.endsWith( '/' ) ? localRoot + '/' : localRoot;
	remoteRoot = ! remoteRoot.endsWith( '/' ) ? remoteRoot + '/' : remoteRoot;

	let includes = [],
		excludes = [];

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
			: 'delete no-inc-recursive size-only ignore-times omit-dir-times no-perms no-owner no-group no-dirs';

	shellParams = shellParams.split( ' ' );
	extraOptions = extraOptions.split( ' ' );
	shell = sshPass ? 'sshpass -e ssh' : 'ssh';
	if( sshPass ) {
		process.env['SSHPASS'] = sshPass;
	}

	if ( remotePort ) {
		shellParams.push( '-p ' + remotePort );
	}

	if ( ignoreList ) {
		// Split ignore list by newlines
		ignoreList = ignoreList.split( '\n' );

		for ( let i = 0; i < ignoreList.length; i++ ) {
			ignoreList[ i ] = ignoreList[ i ].trim();

			// Skip empty lines
			if ( ignoreList[ i ].length === 0 ) {
				continue;
			}

			if ( ignoreList[ i ].startsWith( '#' ) ) {
				continue; // Its a comment.
			}

			// If starts with a !, include
			if ( ignoreList[ i ].startsWith( '!' ) ) {
				includes.push( ignoreList[ i ].substring( 1 ) );
				continue;
			}

			// Otherwise, exclude
			excludes.push( ignoreList[ i ] );
		}
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

	if ( includes.length > 0 ) {
		rsync.include( includes );
	}

	if ( excludes.length > 0 ) {
		rsync.exclude( excludes );
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
			bufferPath = '/tmp/rsync_output_buffer_' + i;
		} while	( fs.existsSync( bufferPath ) );
		fs.writeFileSync( bufferPath, outputBuffer );
		return bufferPath;
	}

	async function runCommand( cmd ) {
		let processedFiles = 0;
		let outputBuffer = '';

		console.log( cmd );

		var code = await exec.exec( cmd, [], {
			listeners: {
				stdline: ( data ) => {
					// do things like parse progress
					processedFiles++;
					outputBuffer += data.toString() + '\n';
					console.log( data.toString() + '\n' );
				},
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
			var actionExitCode = 0
			if( processedFiles > 0 ) {
				core.setOutput( 'bufferPath', bufferPath );
				core.setFailed(
					'Pre-push consistency check failed. Target filesystem does not match build directory.'
				);
				actionExitCode = 1;
			}
			process.exit( actionExitCode );
		}

		// If we have a manifest file to check against, run the check-against-manifest.sh script.
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
				process.exit( code );
			}
		}
	}

	var { code, processedFiles, bufferPath } = await runCommand( rsyncCommand );
	console.log( '::endgroup::' );
} )();
