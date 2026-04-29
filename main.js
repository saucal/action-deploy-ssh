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

	async function runSshPreflight() {
		const token = 'SAUCAL_SSH_PROBE_' + Math.random().toString( 36 ).slice( 2 ) + '_' + Date.now();
		const sshCmd = shell + ' ' + shellParams.join( ' ' ) + ' ' + remoteTarget + ' ' + JSON.stringify( 'printf %s ' + token );

		console.log( '::group::SSH preflight (verify clean stdout for rsync protocol)' );
		console.log( sshCmd );

		let stdout = '';
		let stderr = '';
		const code = await exec.exec( 'bash', [ '-c', sshCmd ], {
			listeners: {
				stdout: ( data ) => { stdout += data.toString(); },
				stderr: ( data ) => { stderr += data.toString(); },
			},
			outStream: fs.createWriteStream( '/dev/null' ),
			errStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );

		if ( code !== 0 ) {
			console.log( '::endgroup::' );
			console.error( 'SSH preflight failed (exit ' + code + ').' );
			if ( stderr ) console.error( 'stderr:\n' + stderr );
			if ( stdout ) console.error( 'stdout:\n' + stdout );
			core.setFailed( 'SSH preflight failed. Cannot connect to remote with provided credentials.' );
			process.exit( code );
		}

		if ( stdout !== token ) {
			console.log( '::endgroup::' );
			console.error( '::error title=SSH stdout pollution detected::Remote shell prints data on stdout. This corrupts the rsync protocol stream and causes "unexpected tag" errors.' );
			console.error( 'Expected stdout: ' + JSON.stringify( token ) );
			console.error( 'Actual stdout (' + Buffer.byteLength( stdout ) + ' bytes):' );
			console.error( JSON.stringify( stdout ) );
			console.error( '\nLikely sources: MOTD, login banner, ~/.bashrc / ~/.profile / ~/.bash_profile echo statements, forced-command wrappers on the remote account.' );
			console.error( 'Fix on remote: silence shell startup output for non-interactive sessions, or remove banner.' );
			core.setFailed( 'SSH preflight detected stdout pollution. rsync protocol cannot work until remote shell is silent.' );
			process.exit( 1 );
		}

		console.log( 'SSH preflight OK. Remote stdout is clean.' );
		console.log( '::endgroup::' );
	}

	async function runRsyncPreflight() {
		const probeDir = fs.mkdtempSync( '/tmp/rsync-probe-' );

		const probeRsync = new Rsync()
			.flags( 'av' )
			.set( 'dry-run' )
			.set( 'list-only' )
			.shell( shell + ' ' + shellParams.join( ' ' ) )
			.source( probeDir + '/' )
			.destination( remoteTarget + ':' + remoteRoot );

		const probeCmd = appendDebugFlags( probeRsync.command() );

		console.log( '::group::Rsync preflight (empty-source dry-run against remote)' );
		console.log( probeCmd );

		let stdout = '';
		let stderr = '';
		const code = await exec.exec( 'bash', [ '-c', probeCmd ], {
			listeners: {
				stdout: ( data ) => { stdout += data.toString(); },
				stderr: ( data ) => { stderr += data.toString(); },
			},
			outStream: fs.createWriteStream( '/dev/null' ),
			errStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );

		try { fs.rmSync( probeDir, { recursive: true, force: true } ); } catch ( e ) {}

		if ( code !== 0 ) {
			console.log( '::endgroup::' );
			console.error( '::error title=Rsync preflight failed::Empty-source dry-run rsync against remote failed. Server-side rsync channel is unusable regardless of changeset content.' );
			console.error( 'Likely causes: server-side rsync wrapper printing to stdout, forced-command shim, server rsync version bug, or permission/quota issue on the remote target path.' );
			if ( stderr ) console.error( 'stderr:\n' + stderr );
			if ( stdout ) console.error( 'stdout:\n' + stdout );
			core.setFailed( 'Rsync preflight failed (exit ' + code + '). Server channel unusable.' );
			process.exit( code );
		}

		console.log( 'Rsync preflight OK. Empty-source dry-run succeeded — server channel works.' );
		console.log( '::endgroup::' );
	}

	await runSshPreflight();
	if ( core.isDebug() ) {
		await runRsyncPreflight();
	}

	function appendDebugFlags( cmd ) {
		if ( ! core.isDebug() ) {
			return cmd;
		}
		return cmd + ' -vv --debug=all --msgs2stderr';
	}

	if ( core.isDebug() ) {
		rsync.debug( true );
	}

	var rsyncCommand = appendDebugFlags( rsync.command() );

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
					if ( core.isDebug() ) {
						process.stderr.write( data.toString() + '\n' );
					}
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
	// In debug mode also force a dry-run for diagnostics, even if neither consistency check nor manifest is requested.
	if ( consistencyCheck || manifest != '' || core.isDebug() ) {

		rsync.flags('v', false)
			.set( '--info=NAME' )
			.set( '--dry-run' ); // run in dry-run mode

		var dryRunCommand = appendDebugFlags( rsync.command() );

		rsync._sources = [];
		rsync.flags('v')
			.unset( 'info' )
			.unset( 'dry-run' )
			.source( remoteTarget + ':' + remoteRoot )
			.destination( localRoot );

		var rsyncDiffCommand = appendDebugFlags( rsync.command() );

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

		var { code, processedFiles, bufferPath: rsyncManifest } = await runCommand( dryRunCommand, core.isDebug() );
		var rsyncManifestRepoRooted = fs.readFileSync( rsyncManifest, 'utf8' ).toString();
		
		if ( localRoot != localRootRepo ) {
			console.log( 'Adjusting rsync manifest to be repo-rooted' );
			var relativeRoot = path.relative( localRootRepo, localRoot ) + '/';
			rsyncManifestRepoRooted = rsyncManifestRepoRooted.split('\n').map( ( line ) => {
				if ( line.startsWith( 'deleting ' ) ) {
					line = line.replace( /^deleting /, '' );
					return 'deleting ' + relativeRoot + line;
				} else if ( line.length > 0 ) {
					return relativeRoot + line;
				} else {
					return line;
				}
			}).join('\n');
		}

		rsyncManifestRepoRooted = writeBufferToFile( rsyncManifestRepoRooted, 'rsync_manifest_repo_rooted' );
		core.setOutput( 'bufferPath', rsyncManifestRepoRooted );

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
					RSYNC_MANIFEST: rsyncManifestRepoRooted,
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

	async function handleHookedActions( hook ) {

		// Find post-push actions in the temp runner and run them.
		const hookScriptsPath = path.join( process.env.RUNNER_TEMP, '.saucal', 'ssh-deploy', hook );

		var files = fs.existsSync( hookScriptsPath ) ? fs.readdirSync( hookScriptsPath ) : [];
		var promises = [];
		for( let actionHook of files ) {
			promises.push( async () => {
				console.log( 'Running '+hook+'-push action/script: ' + actionHook );
			
				const sshCommand = shell + ' ' + remoteTarget + ' ' + shellParams.join( ' ' );
				console.log( 'sshCommand: ' + sshCommand );
		
				var code = await exec.exec( 'bash', [ path.join( hookScriptsPath, actionHook ) ], {
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
						'action'+hook+' script "' + actionHook + '" failed with code ' + code + '. There is likely more information above.'
					);
					process.exit( code );
				}

				console.log( 'Finished '+hook+' action/script: ' + actionHook );
			} );
		}

		// Intentionally process in series, not in parallel (which could be done with soething like Promise.all).
		for (let promise of promises) {
			await promise();
		}
	}

	await handleHookedActions( 'pre' );

	if ( consistencyCheck ) {
		process.exit( 0 );
	}

	var { code, processedFiles, bufferPath } = await runCommand( rsyncCommand );

	await handleHookedActions( 'post' );

	console.log( '::endgroup::' );
} )();
