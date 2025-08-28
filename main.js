( async function () {
	const core = require( '@actions/core' );
	const exec = require( '@actions/exec' );
	const fs = require( 'fs' );
	const Rsync = require( 'rsync' );
	const path = require( 'path' );
	const rsyncRulesFormatter = require('./rsyncRulesFormatter');
	// Store now as a timestamp to use in temp files in the format of YYYYMMDDHHMMSS
	const now = new Date();
	const timestamp = now.getFullYear().toString() +
		( now.getMonth() + 1 ).toString().padStart( 2, '0' ) +
		now.getDate().toString().padStart( 2, '0' ) +
		now.getHours().toString().padStart( 2, '0' ) +
		now.getMinutes().toString().padStart( 2, '0' ) +
		now.getSeconds().toString().padStart( 2, '0');

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
	// Remove any empty or commented lines
	ignoreList = ignoreList.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('#')).join('\n');
	// Remove duplicate lines
	ignoreList = ignoreList.split('\n').filter((line, index, self) => self.indexOf(line) === index).join('\n');

	let ignoreListRepoRooted = ignoreList;

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


	// Remove trailing slashes for the time being
	localRoot = localRoot.replace( /\/+$/, '' );
	remoteRoot = remoteRoot.replace( /\/+$/, '' );

	let localRootRepo = localRoot;

	while ( fs.existsSync( path.join( localRootRepo, '.git' ) ) === false ) {
		localRootRepo = path.dirname( localRootRepo );
		if ( localRootRepo === '/' ) {
			core.setFailed( 'Could not find a .git directory in the local root or any parent directories.' );
			return;
		}
	}

	if ( localRoot != localRootRepo ) {
		console.log( 'Local root is a subdirectory adjusting ignore lists and paths' );
		console.log( 'Using local root: ' + localRoot );
		console.log( 'Using local repo root: ' + localRootRepo );
		const relativePath = path.relative( localRootRepo, localRoot );
		ignoreListRepoRooted = ignoreListRepoRooted.split( '\n' ).map( ( line ) => {
			if ( line.startsWith( '/' ) ) {
				return '/' + relativePath + line;
			} else if ( line.startsWith( '!/' ) ) {
				return '!/' + relativePath + line.substring( 2 );
			} else {
				return line;
			}
		} ).join( '\n' );
	}

	// Make sure paths end with a slash.
	localRoot = localRoot + '/';
	localRootRepo = localRootRepo + '/';
	remoteRoot = remoteRoot + '/';

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

	function getDirectoryToWrite() {
		var i = 0, dirPath;
		do {
			i++;
			dirPath = '/tmp/ssh-deploy-' + timestamp + '_' + i;
		} while	( fs.existsSync( dirPath ) );
		fs.mkdirSync( dirPath, { recursive: true } );
		return dirPath;
	}

	function writeBufferToFile( outputBuffer, name = 'rsync_output_buffer' ) {
		var i = 0, bufferPath;
		do {
			i++;
			bufferPath = '/tmp/' + name + '_' + timestamp + '_' + i + '.txt';
		} while	( fs.existsSync( bufferPath ) );
		fs.writeFileSync( bufferPath, outputBuffer );
		return bufferPath;
	}

	async function runCommand( cmd, logToConsole = true, bufferName = 'command_output' ) {
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
					if( logToConsole ) {
						console.log( data.toString() );
					}
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

		let bufferPath = writeBufferToFile( outputBuffer, bufferName );

		return { code, processedFiles, bufferPath };
	}

	// If we are doing just a consistency check, or we have a manifest to check against, run the dry-run command first.
	if ( consistencyCheck || manifest != '' ) {

		rsync.flags('v', false)
			.set( '--info=NAME' )
			.set( '--dry-run' ); // run in dry-run mode

		var dryRunCommand = rsync.command();

		rsync._sources = [];
		rsync.flags('v')
			.unset( 'info' )
			.unset( 'dry-run' )
			.source( remoteTarget + ':' + remoteRoot )
			.destination( localRoot );

		var rsyncDiffCommand = rsync.command();

		async function getRsyncDiff( basename = 'rsync_diff' ) {
			var diffsToDo = [
				{ ref: 'HEAD', name: basename + '_built' },
				{ ref: 'HEAD~1', name: basename + '_base_built' },
			];

			var diff_path = getDirectoryToWrite();

			for( let diffToDo of diffsToDo ) {
				var ref = diffToDo.ref;
				var name = diffToDo.name;
				var outputBuffer = '';
				var { code, processedFiles, bufferPath } = await runCommand( rsyncDiffCommand, core.isDebug() );

				await exec.exec( 'bash', [ __dirname + '/consistency-diff.sh', ref ], {
					env: {
						PATH_DIR: localRootRepo
					},
					listeners: {
						stdline: ( data ) => {
							// do things like parse progress
							outputBuffer += data.toString() + '\n';
						},
					},
					outStream: fs.createWriteStream( '/dev/null' ),
					ignoreReturnCode: true,
				} );

				var this_diff_path = writeBufferToFile( outputBuffer, name );
				fs.renameSync( this_diff_path, path.join( diff_path, path.basename( this_diff_path ) ) );
			}

			return diff_path;
		}

		var { code, processedFiles, bufferPath } = await runCommand( dryRunCommand, core.isDebug() );
		core.setOutput( 'bufferPath', bufferPath );

		// If we have the consistency check to run, check that there's no files changed.
		if ( consistencyCheck ) {
			if( processedFiles > 0 ) {
				console.log( '::error title=Pre-push consistency check failed. Target filesystem does not match build directory.::' );

				var diffPath = await getRsyncDiff();
				core.setOutput( 'diffPath', diffPath );

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
					PATH_DIR: localRootRepo,
					SSH_IGNORE_LIST: ignoreListRepoRooted,
					GIT_MANIFEST: manifest,
					RSYNC_MANIFEST: bufferPath,
					GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
				},
				ignoreReturnCode: true,
			} );
		
			if ( code != 0 ) {
				var diffPath = await getRsyncDiff();
				core.setOutput( 'diffPath', diffPath );

				core.setFailed(
					'Pre-push consistency check failed. Manifest file does not match what Rsync is about to do. Check the diff between the base status and the remote environment.'
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
