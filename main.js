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

		async function getRsyncDiff() {
			var headerCurrent =
				'##################################################################\n' +
				'# CONSISTENCY DIFF — current build vs deploy target\n' +
				'#\n' +
				'# Compares : files on the TARGET server  <->  this build (git HEAD)\n' +
				"# Reading  : '+' = in the BUILD  (would be sent on deploy)\n" +
				"#            '-' = on the TARGET now (differs from build)\n" +
				'# Meaning  : everything below is what deploying THIS build would\n' +
				'#            change on the target. Empty = target already matches.\n' +
				'# NOTE     : git CONTENT diff vs the build commit — NOT rsync\'s\n' +
				'#            transfer decision. rsync uses size-only/ignore-times, so\n' +
				'#            the files it actually sends can differ. For rsync\'s real\n' +
				"#            file list see the 'deploy-rsync-plan' artifact.\n" +
				'##################################################################\n\n';

			var headerDeployed =
				'##################################################################\n' +
				'# CONSISTENCY DIFF — previously deployed build vs deploy target\n' +
				'#\n' +
				'# Compares : files on the TARGET server  <->  previous build (git HEAD~1)\n' +
				"# Reading  : '+' = in the PREVIOUS build\n" +
				"#            '-' = on the TARGET now (differs from previous build)\n" +
				'# Meaning  : how the target has drifted from the last deployed build.\n' +
				'#            Empty  = target is exactly one deploy behind (clean).\n' +
				'#            Output = unexpected manual drift on the server.\n' +
				'# NOTE     : git CONTENT diff vs the build commit — NOT rsync\'s\n' +
				'#            transfer decision. rsync uses size-only/ignore-times, so\n' +
				'#            the files it actually sends can differ. For rsync\'s real\n' +
				"#            file list see the 'deploy-rsync-plan' artifact.\n" +
				'##################################################################\n\n';

			var diffsToDo = [
				{ ref: 'HEAD', name: 'diff_current-build-vs-target', header: headerCurrent },
				{ ref: 'HEAD~1', name: 'diff_deployed-build-vs-target', header: headerDeployed },
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

				var this_diff_path = writeBufferToFile( diffToDo.header + outputBuffer, name );
				fs.renameSync( this_diff_path, path.join( diff_path, path.basename( this_diff_path ) ) );
			}

			var readme =
				'Consistency diffs\n' +
				'\n' +
				'This bundle is produced when a pre-push consistency check finds the deploy\n' +
				'target does not match the build. It contains two diffs, both framed in deploy\n' +
				"direction ('+' = build side, '-' = target side):\n" +
				'\n' +
				'  diff_current-build-vs-target\n' +
				'      What deploying the CURRENT build (git HEAD) would change on the target.\n' +
				'      This is the full set of differences blocking a clean deploy.\n' +
				'\n' +
				'  diff_deployed-build-vs-target\n' +
				'      How the target differs from the PREVIOUSLY deployed build (git HEAD~1).\n' +
				'        - Empty  -> target is exactly one deploy behind. Expected/clean.\n' +
				'        - Output -> unexpected manual drift on the server. Investigate:\n' +
				'                    someone changed files on the target outside the pipeline.\n' +
				'\n' +
				'These diffs are git CONTENT diffs computed against the build commit.\n' +
				'The mismatch itself was first detected by an rsync dry-run, whose file\n' +
				"list lives in the separate 'deploy-rsync-plan' artifact (rsync-sync-plan).\n" +
				'That plan is rsync\'s ACTUAL transfer decision (size-only/ignore-times);\n' +
				'these .diff files may not match it exactly.\n' +
				'\n' +
				'Each diff file has a header explaining exactly what it compares.\n';
			fs.writeFileSync( path.join( diff_path, 'README.txt' ), readme );

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

		var rsyncPlanHeader =
			'##################################################################\n' +
			'# RSYNC SYNC PLAN — rsync\'s ACTUAL transfer decision (build -> target)\n' +
			'#\n' +
			'# Produced by an rsync dry-run (local build, git HEAD  ->  target).\n' +
				'# Each line is a path rsync would upload to the target server.\n' +
			"# A 'deleting ' prefix means rsync would remove that path.\n" +
			'# Decision uses size-only/ignore-times, NOT file content — so this\n' +
				"# can differ from the git content diffs in the 'consistency-diffs'\n" +
				'# artifact. This is a dry-run; nothing has been written to the target.\n' +
			'##################################################################\n\n';

		// Clean copy consumed (and mutated in place) by check-against-manifest.sh.
		var rsyncManifestCheckPath = writeBufferToFile( rsyncManifestRepoRooted, 'rsync-sync-plan-check' );
		// Header copy uploaded as the artifact and used as the Slack data-file.
		var rsyncManifestArtifactPath = writeBufferToFile( rsyncPlanHeader + rsyncManifestRepoRooted, 'rsync-sync-plan' );
		core.setOutput( 'bufferPath', rsyncManifestArtifactPath );

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
			// Capture the git manifest BEFORE check-against-manifest.sh mutates it in place.
			var gitManifestRaw = fs.readFileSync( manifest, 'utf8' ).toString();
			var manifestDiffOut = path.join( process.env.RUNNER_TEMP || '/tmp', 'manifest-mismatch_' + timestamp + '.diff' );
			var code = await exec.exec( 'bash', [ __dirname + '/check-against-manifest.sh' ], {
				env: {
					PATH_DIR: localRootRepo,
					SSH_IGNORE_LIST: ignoreListRepoRooted,
					GIT_MANIFEST: manifest,
					RSYNC_MANIFEST: rsyncManifestCheckPath,
					GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
					MANIFEST_DIFF_OUT: manifestDiffOut,
				},
				ignoreReturnCode: true,
			} );

			if ( fs.existsSync( manifestDiffOut ) && fs.statSync( manifestDiffOut ).size > 0 ) {
				core.setOutput( 'manifestDiffPath', manifestDiffOut );

				// On mismatch, also surface the git manifest (the LEFT side of the diff).
				var gitManifestHeader =
					'##################################################################\n' +
					'# GIT MANIFEST — files the BUILD declared changed (expected deploy set)\n' +
					'#\n' +
					'# Produced by build-to-git: git diff-tree of the build commit vs the\n' +
					"# previous build. Here '+ ' = added/modified, '- ' = deleted\n" +
					'# (change TYPE, not diff direction).\n' +
					'# This is the LEFT side of the manifest-mismatch comparison; the\n' +
					"# rsync dry-run plan ('rsync-sync-plan') is the RIGHT side.\n" +
					'##################################################################\n\n';
				var gitManifestPath = writeBufferToFile( gitManifestHeader + gitManifestRaw, 'git-manifest' );
				core.setOutput( 'gitManifestPath', gitManifestPath );
			}

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
