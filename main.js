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

	async function runRsyncProbe( label, probeRsync ) {
		const probeCmd = appendDebugFlags( probeRsync.command() );

		console.log( '::group::Rsync probe — ' + label );
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

		console.log( '::endgroup::' );
		return { code, stdout, stderr };
	}

	async function runRsyncReceiverProbe() {
		const probeDir = fs.mkdtempSync( '/tmp/rsync-probe-' );
		const probeRsync = new Rsync()
			.flags( 'av' )
			.set( 'dry-run' )
			.set( 'list-only' )
			.shell( shell + ' ' + shellParams.join( ' ' ) )
			.source( probeDir + '/' )
			.destination( remoteTarget + ':' + remoteRoot );

		const result = await runRsyncProbe( 'server as RECEIVER (empty-source push, dry-run)', probeRsync );
		try { fs.rmSync( probeDir, { recursive: true, force: true } ); } catch ( e ) {}

		if ( result.code !== 0 ) {
			console.error( '::error title=Rsync receiver probe failed::Server cannot accept rsync pushes. Channel unusable regardless of changeset content.' );
			console.error( 'Likely causes: server-side rsync wrapper printing to stdout, forced-command shim, server rsync version bug, or permission/quota issue on the remote target path.' );
			if ( result.stderr ) console.error( 'stderr:\n' + result.stderr );
			if ( result.stdout ) console.error( 'stdout:\n' + result.stdout );
		} else {
			console.log( 'Receiver probe OK. Server accepts pushes.' );
		}
		return result.code;
	}

	async function runRsyncSenderProbe() {
		const probeRsync = new Rsync()
			.flags( 'a' )
			.set( 'list-only' )
			.shell( shell + ' ' + shellParams.join( ' ' ) )
			.source( remoteTarget + ':' + remoteRoot );

		const result = await runRsyncProbe( 'server as SENDER (list remote dir)', probeRsync );

		if ( result.code !== 0 ) {
			console.error( '::error title=Rsync sender probe failed::Server cannot list its own remote dir. Channel/path/permissions issue on remote.' );
			if ( result.stderr ) console.error( 'stderr:\n' + result.stderr );
			if ( result.stdout ) console.error( 'stdout:\n' + result.stdout );
			return result.code;
		}

		const lines = result.stdout.split( '\n' );
		const flagged = lines.filter( ( l ) => /^[lspcbD]/.test( l ) );
		console.log( 'Listed ' + lines.filter( ( l ) => l.length > 0 ).length + ' remote entries.' );
		if ( flagged.length ) {
			console.log( 'Non-regular entries on remote (symlinks/sockets/pipes/devices) — these can break rsync receiver:' );
			flagged.slice( 0, 100 ).forEach( ( l ) => console.log( '  ' + l ) );
			if ( flagged.length > 100 ) console.log( '  ... +' + ( flagged.length - 100 ) + ' more' );
		} else {
			console.log( 'No non-regular entries detected on remote.' );
		}
		return 0;
	}

	async function runRemoteSshCommand( label, remoteCmd, opts = {} ) {
		const cmd = shell + ' ' + shellParams.join( ' ' ) + ' ' + remoteTarget + ' ' + JSON.stringify( remoteCmd ) + ( opts.stdinFromDevNull ? ' < /dev/null' : '' ) + ( opts.pipe ? ' ' + opts.pipe : '' );

		console.log( '::group::' + label );
		console.log( cmd );

		let stdout = '';
		let stderr = '';
		const code = await exec.exec( 'bash', [ '-c', cmd ], {
			listeners: {
				stdout: ( data ) => { stdout += data.toString(); },
				stderr: ( data ) => { stderr += data.toString(); },
			},
			outStream: fs.createWriteStream( '/dev/null' ),
			errStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );

		console.log( 'exit: ' + code );
		if ( stdout ) {
			console.log( '--- stdout ---' );
			console.log( stdout );
		}
		if ( stderr ) {
			console.log( '--- stderr ---' );
			console.log( stderr );
		}
		console.log( '::endgroup::' );
		return { code, stdout, stderr };
	}

	await runSshPreflight();
	if ( core.isDebug() ) {
		const senderCode = await runRsyncSenderProbe();
		const receiverCode = await runRsyncReceiverProbe();

		// Inspect remote rsync binary directly via ssh (channel known clean).
		await runRemoteSshCommand( 'Remote rsync --version', 'rsync --version' );

		// Run rsync --server directly with empty stdin in both directions, hexdump first 2KB of stdout.
		// Mirrors the exact commands rsync issues during sender-mode (list remote) and receiver-mode (push) sessions.
		await runRemoteSshCommand(
			'Remote rsync --server --sender raw bytes (sender mode, hexdump first 2KB)',
			'rsync --server --sender -vvlogDtpre.iLsfxCIvu --list-only --msgs2stderr . ' + remoteRoot,
			{ stdinFromDevNull: true, pipe: '| head -c 2048 | xxd' }
		);
		await runRemoteSshCommand(
			'Remote rsync --server raw bytes (receiver mode, hexdump first 2KB)',
			'rsync --server -vvnlogDtpre.iLsfxCIvu --list-only --msgs2stderr . ' + remoteRoot,
			{ stdinFromDevNull: true, pipe: '| head -c 2048 | xxd' }
		);

		if ( receiverCode !== 0 ) {
			await runRemoteSshCommand(
				'Remote top-level entries with type/perms (find -maxdepth 1 -ls)',
				'find ' + remoteRoot + ' -maxdepth 1 -mindepth 1 -printf \'%y %M %u:%g %s %p -> %l\\n\' 2>&1'
			);
			await bisectRemoteReceiver( remoteRoot, 0 );
			await bisectRemoteTopLevelByExclusion( remoteRoot );
			await runFullRemoteDiagnostics();
			await runRsyncFlagVariantProbes();
		}

		if ( senderCode !== 0 || receiverCode !== 0 ) {
			core.setFailed( 'Rsync preflight probes failed. See diagnostics above.' );
			process.exit( 1 );
		}
	}

	async function probeReceiverPath( destPath ) {
		const probeDir = fs.mkdtempSync( '/tmp/rsync-bisect-' );
		const probe = new Rsync()
			.flags( 'av' )
			.set( 'dry-run' )
			.set( 'list-only' )
			.shell( shell + ' ' + shellParams.join( ' ' ) )
			.source( probeDir + '/' )
			.destination( remoteTarget + ':' + destPath );

		let stdout = '';
		let stderr = '';
		const code = await exec.exec( 'bash', [ '-c', probe.command() ], {
			listeners: {
				stdout: ( data ) => { stdout += data.toString(); },
				stderr: ( data ) => { stderr += data.toString(); },
			},
			outStream: fs.createWriteStream( '/dev/null' ),
			errStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );
		try { fs.rmSync( probeDir, { recursive: true, force: true } ); } catch ( e ) {}
		return { code, stdout, stderr };
	}

	async function listRemoteSubdirs( path ) {
		const remoteCmd = 'find ' + path + ' -maxdepth 1 -mindepth 1 -type d -printf \'%f\\n\' 2>&1';
		const cmd = shell + ' ' + shellParams.join( ' ' ) + ' ' + remoteTarget + ' ' + JSON.stringify( remoteCmd );
		let stdout = '';
		await exec.exec( 'bash', [ '-c', cmd ], {
			listeners: { stdout: ( data ) => { stdout += data.toString(); } },
			outStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );
		return stdout.split( '\n' ).map( ( s ) => s.trim() ).filter( Boolean );
	}

	async function listRemoteEntries( path ) {
		const remoteCmd = 'find ' + path + ' -maxdepth 1 -mindepth 1 -printf \'%y\\t%f\\n\' 2>&1';
		const cmd = shell + ' ' + shellParams.join( ' ' ) + ' ' + remoteTarget + ' ' + JSON.stringify( remoteCmd );
		let stdout = '';
		await exec.exec( 'bash', [ '-c', cmd ], {
			listeners: { stdout: ( data ) => { stdout += data.toString(); } },
			outStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );
		return stdout.split( '\n' ).map( ( s ) => s.trim() ).filter( Boolean ).map( ( line ) => {
			const [ type, name ] = line.split( '\t' );
			return { type, name };
		} );
	}

	async function probeReceiverPathExcluding( destPath, excludeName ) {
		const probeDir = fs.mkdtempSync( '/tmp/rsync-bisect-' );
		const probe = new Rsync()
			.flags( 'av' )
			.set( 'dry-run' )
			.set( 'list-only' )
			.set( 'exclude', '/' + excludeName )
			.shell( shell + ' ' + shellParams.join( ' ' ) )
			.source( probeDir + '/' )
			.destination( remoteTarget + ':' + destPath );

		const code = await exec.exec( 'bash', [ '-c', probe.command() ], {
			listeners: {},
			outStream: fs.createWriteStream( '/dev/null' ),
			errStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );
		try { fs.rmSync( probeDir, { recursive: true, force: true } ); } catch ( e ) {}
		return code;
	}

	async function probeReceiverPathIncluding( destPath, entries ) {
		const probeDir = fs.mkdtempSync( '/tmp/rsync-bisect-' );
		const patterns = [];
		for ( const e of entries ) {
			if ( e.type === 'd' ) {
				patterns.push( '+/' + e.name + '/' );
				patterns.push( '+/' + e.name + '/**' );
			} else {
				patterns.push( '+/' + e.name );
			}
		}
		patterns.push( '-*' );

		const probe = new Rsync()
			.flags( 'av' )
			.set( 'dry-run' )
			.set( 'list-only' )
			.shell( shell + ' ' + shellParams.join( ' ' ) )
			.patterns( patterns )
			.source( probeDir + '/' )
			.destination( remoteTarget + ':' + destPath );

		const code = await exec.exec( 'bash', [ '-c', probe.command() ], {
			listeners: {},
			outStream: fs.createWriteStream( '/dev/null' ),
			errStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );
		try { fs.rmSync( probeDir, { recursive: true, force: true } ); } catch ( e ) {}
		return code;
	}

	async function bisectMinimalFailingSet( basePath, entries ) {
		console.log( '::group::Bisect minimal failing set (progressive inclusion) at ' + basePath );

		// Step 1: progressive inclusion to find the smallest prefix that fails.
		const accumulated = [];
		let triggerIndex = -1;
		for ( let i = 0; i < entries.length; i++ ) {
			accumulated.push( entries[ i ] );
			const code = await probeReceiverPathIncluding( basePath, accumulated );
			const label = accumulated.map( ( e ) => '/' + e.name ).join( ' ' );
			if ( code !== 0 ) {
				console.log( 'FAIL  including: ' + label );
				triggerIndex = i;
				break;
			} else {
				console.log( 'ok    including: ' + label );
			}
		}

		if ( triggerIndex === -1 ) {
			console.log( 'All entries together still pass when explicitly included. Failure may depend on default scan path, not entry contents.' );
			console.log( '::endgroup::' );
			return;
		}

		// Step 2: shrink. Try removing each entry from the accumulated set; if probe still fails, keep it removed.
		let minimal = accumulated.slice();
		for ( let i = minimal.length - 2; i >= 0; i-- ) {
			const trial = minimal.slice( 0, i ).concat( minimal.slice( i + 1 ) );
			const code = await probeReceiverPathIncluding( basePath, trial );
			const removed = minimal[ i ].name;
			if ( code !== 0 ) {
				console.log( 'still fails without /' + removed + ' — drop' );
				minimal = trial;
			} else {
				console.log( 'requires /' + removed + ' — keep' );
			}
		}

		console.log( 'Minimal failing set (' + minimal.length + '): ' + minimal.map( ( e ) => '/' + e.name ).join( ', ' ) );
		console.log( '::endgroup::' );
	}

	async function bisectRemoteTopLevelByExclusion( basePath ) {
		const entries = await listRemoteEntries( basePath );
		if ( ! entries.length ) {
			return;
		}
		console.log( '::group::Bisect top-level entries by exclusion at ' + basePath + ' (' + entries.length + ' entries)' );
		const passers = [];
		for ( const { type, name } of entries ) {
			const code = await probeReceiverPathExcluding( basePath, name );
			if ( code === 0 ) {
				console.log( 'PASSES when excluding [' + type + '] /' + name + '  <-- contributes to failure' );
				passers.push( name );
			} else {
				console.log( 'still fails excluding [' + type + '] /' + name );
			}
		}
		if ( passers.length === 0 ) {
			console.log( 'No single exclusion makes root probe pass. Failure requires combined scan — running progressive inclusion to find minimal failing set.' );
		} else if ( passers.length === 1 ) {
			console.log( 'Single offender confirmed: /' + passers[ 0 ] );
		} else {
			console.log( 'Multiple entries individually trigger pass when excluded. Passers: ' + passers.join( ', ' ) );
		}
		console.log( '::endgroup::' );

		await bisectMinimalFailingSet( basePath, entries );
	}

	async function runFullRemoteDiagnostics() {
		console.log( '::group::Full remote diagnostics suite' );

		await runRemoteSshCommand( 'uname -a', 'uname -a 2>&1' );
		await runRemoteSshCommand( 'whoami / id', 'whoami; id 2>&1' );
		await runRemoteSshCommand( 'rsync path & version', 'which rsync; rsync --version | head -3 2>&1' );

		await runRemoteSshCommand(
			'stat of remote root',
			'stat ' + remoteRoot + ' 2>&1'
		);
		await runRemoteSshCommand(
			'ls -la of remote root',
			'ls -la ' + remoteRoot + ' 2>&1'
		);
		await runRemoteSshCommand(
			'getfacl of remote root',
			'getfacl ' + remoteRoot + ' 2>&1 || true'
		);
		await runRemoteSshCommand(
			'extended attrs on remote root',
			'getfattr -d ' + remoteRoot + ' 2>&1 || true'
		);

		await runRemoteSshCommand(
			'disk free (df -h)',
			'df -h ' + remoteRoot + ' 2>&1'
		);
		await runRemoteSshCommand(
			'inode usage (df -i)',
			'df -i ' + remoteRoot + ' 2>&1'
		);
		await runRemoteSshCommand(
			'quota (if available)',
			'quota -s 2>&1 || true'
		);
		await runRemoteSshCommand(
			'ulimit',
			'ulimit -a 2>&1'
		);

		await runRemoteSshCommand(
			'file count per top-level subdir',
			'for d in ' + remoteRoot + '*/; do printf \'%s\\t\' "$d"; find "$d" -type f 2>/dev/null | wc -l; done 2>&1'
		);
		await runRemoteSshCommand(
			'disk usage per top-level subdir (du -sh)',
			'du -sh ' + remoteRoot + '*/ 2>&1 | sort -h'
		);
		await runRemoteSshCommand(
			'total file/dir/symlink/special counts under remote root',
			'find ' + remoteRoot + ' -type f 2>/dev/null | wc -l; ' +
				'find ' + remoteRoot + ' -type d 2>/dev/null | wc -l; ' +
				'find ' + remoteRoot + ' -type l 2>/dev/null | wc -l; ' +
				'find ' + remoteRoot + ' \\( -type s -o -type p -o -type b -o -type c \\) 2>/dev/null | wc -l'
		);

		await runRemoteSshCommand(
			'all symlinks under remote root (path -> target)',
			'find ' + remoteRoot + ' -type l -printf \'%p -> %l\\n\' 2>&1 | head -200'
		);
		await runRemoteSshCommand(
			'broken symlinks under remote root',
			'find ' + remoteRoot + ' -xtype l -printf \'%p -> %l\\n\' 2>&1 | head -200'
		);
		await runRemoteSshCommand(
			'non-regular files (sockets, pipes, devices)',
			'find ' + remoteRoot + ' \\( -type s -o -type p -o -type b -o -type c \\) -ls 2>&1 | head -200'
		);

		await runRemoteSshCommand(
			'foreign-owned entries (not owned by current user)',
			'find ' + remoteRoot + ' ! -user "$(whoami)" -printf \'%y %M %u:%g %p\\n\' 2>&1 | head -100'
		);
		await runRemoteSshCommand(
			'world-writable files',
			'find ' + remoteRoot + ' -type f -perm -o+w -printf \'%M %u:%g %p\\n\' 2>&1 | head -100'
		);
		await runRemoteSshCommand(
			'unreadable files (permission denied)',
			'find ' + remoteRoot + ' -type f ! -readable -printf \'%M %u:%g %p\\n\' 2>&1 | head -100'
		);
		await runRemoteSshCommand(
			'files with setuid/setgid/sticky bits',
			'find ' + remoteRoot + ' -type f \\( -perm -4000 -o -perm -2000 -o -perm -1000 \\) -printf \'%M %u:%g %p\\n\' 2>&1 | head -100'
		);

		await runRemoteSshCommand(
			'paths longer than 200 chars',
			'find ' + remoteRoot + ' -printf \'%p\\n\' 2>&1 | awk \'length > 200\' | head -50'
		);
		await runRemoteSshCommand(
			'files with non-ASCII names',
			'find ' + remoteRoot + ' -name \'*\' -printf \'%p\\n\' 2>&1 | LC_ALL=C grep -P \'[^\\x00-\\x7F]\' | head -50'
		);
		await runRemoteSshCommand(
			'files with backslash, newline, or tab in name',
			'find ' + remoteRoot + ' -name \'*\' -printf \'%p\\n\' 2>&1 | grep -E "[\\\\\\\\]" | head -50'
		);
		await runRemoteSshCommand(
			'empty directories under remote root (count)',
			'find ' + remoteRoot + ' -type d -empty 2>/dev/null | wc -l'
		);
		await runRemoteSshCommand(
			'largest 20 files',
			'find ' + remoteRoot + ' -type f -printf \'%s\\t%p\\n\' 2>&1 | sort -rn | head -20'
		);
		await runRemoteSshCommand(
			'sample of files with extended attrs',
			'find ' + remoteRoot + ' -type f 2>/dev/null | head -2000 | xargs -I {} getfattr --absolute-names -d "{}" 2>/dev/null | grep -v \'^$\' | head -50 || true'
		);

		console.log( '::endgroup::' );
	}

	async function runReceiverProbeWithExtraFlags( label, extraArgs ) {
		const probeDir = fs.mkdtempSync( '/tmp/rsync-variant-' );
		const probe = new Rsync()
			.flags( 'av' )
			.set( 'dry-run' )
			.set( 'list-only' )
			.shell( shell + ' ' + shellParams.join( ' ' ) )
			.source( probeDir + '/' )
			.destination( remoteTarget + ':' + remoteRoot );

		const cmd = probe.command() + ' ' + extraArgs;
		console.log( '::group::Variant probe — ' + label );
		console.log( cmd );

		let stdout = '';
		let stderr = '';
		const code = await exec.exec( 'bash', [ '-c', cmd ], {
			listeners: {
				stdout: ( data ) => { stdout += data.toString(); },
				stderr: ( data ) => { stderr += data.toString(); },
			},
			outStream: fs.createWriteStream( '/dev/null' ),
			errStream: fs.createWriteStream( '/dev/null' ),
			ignoreReturnCode: true,
		} );
		try { fs.rmSync( probeDir, { recursive: true, force: true } ); } catch ( e ) {}

		console.log( ( code === 0 ? 'PASS' : 'FAIL' ) + ' (exit ' + code + ')' );
		if ( stderr ) console.log( '--- stderr (head) ---\n' + stderr.split( '\n' ).slice( 0, 30 ).join( '\n' ) );
		console.log( '::endgroup::' );
		return code;
	}

	async function runRsyncFlagVariantProbes() {
		console.log( '::group::Rsync flag variant probes (find a working flag set)' );

		await runReceiverProbeWithExtraFlags( "include '*' (no-op filter)", "--include='*'" );
		await runReceiverProbeWithExtraFlags( "exclude only ('-*' catch-all)", "--exclude='*'" );
		await runReceiverProbeWithExtraFlags( "--protocol=30 (legacy)", "--protocol=30" );
		await runReceiverProbeWithExtraFlags( "--protocol=29", "--protocol=29" );
		await runReceiverProbeWithExtraFlags( "--no-inc-recursive", "--no-inc-recursive" );
		await runReceiverProbeWithExtraFlags( "--no-perms --no-owner --no-group", "--no-perms --no-owner --no-group" );
		await runReceiverProbeWithExtraFlags( "no -l (skip symlinks)", "--no-l" );
		await runReceiverProbeWithExtraFlags( "skip-msgs2stderr (default mux)", "" );
		await runReceiverProbeWithExtraFlags( "--block-size=4096", "--block-size=4096" );
		await runReceiverProbeWithExtraFlags( "no-D (no devices/specials)", "--no-D" );
		await runReceiverProbeWithExtraFlags( "follow symlinks (-L)", "-L" );
		await runReceiverProbeWithExtraFlags( "--safe-links", "--safe-links" );
		await runReceiverProbeWithExtraFlags( "--copy-unsafe-links", "--copy-unsafe-links" );

		console.log( '::endgroup::' );
	}

	async function bisectRemoteReceiver( basePath, depth ) {
		const MAX_DEPTH = 3;
		const MAX_ENTRIES_PER_LEVEL = 200;

		const subdirs = await listRemoteSubdirs( basePath );
		console.log( '::group::Bisect ' + basePath + ' (' + subdirs.length + ' subdirs, depth ' + depth + ')' );

		const failed = [];
		for ( const sub of subdirs.slice( 0, MAX_ENTRIES_PER_LEVEL ) ) {
			const subPath = basePath.replace( /\/$/, '' ) + '/' + sub + '/';
			const result = await probeReceiverPath( subPath );
			if ( result.code !== 0 ) {
				console.log( 'FAIL  ' + subPath );
				failed.push( subPath );
			} else {
				console.log( 'ok    ' + subPath );
			}
		}
		if ( subdirs.length > MAX_ENTRIES_PER_LEVEL ) {
			console.log( '... +' + ( subdirs.length - MAX_ENTRIES_PER_LEVEL ) + ' more entries skipped' );
		}
		console.log( '::endgroup::' );

		if ( depth + 1 > MAX_DEPTH ) {
			return;
		}
		for ( const failedPath of failed ) {
			await bisectRemoteReceiver( failedPath, depth + 1 );
		}
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
