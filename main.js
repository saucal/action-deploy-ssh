( async function () {
	const core = require( '@actions/core' );
	const Rsync = require( 'rsync' );

	const remoteTarget =
		core.getInput( 'env-user', { required: true } ) +
		'@' +
		core.getInput( 'env-host', { required: true } );
	const remotePort = core.getInput( 'env-port', { required: false } );
	const sshKey = core.getInput( 'env-key', { required: false } );
	const sshPass = core.getInput( 'env-pass', { required: false } );
	const consistencyCheck = core.getInput( 'consistency-check', {
		required: false,
	} );

	let ignoreList = core.getInput( 'force-ignore', { required: false } );
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

	if ( remotePort ) {
		shellParams.push( '-p ' + remotePort );
	}

	if ( manifest ) {
		extraOptions.push( '--files-from=' + manifest );
		extraOptions.push( 'delete-missing-args' );
		extraOptions.push( 'delete-after' );
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

	if ( consistencyCheck ) {
		// Remove verbose flag from sshFlags.
		sshFlags = sshFlags.replace( 'v', '' );
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

	if ( consistencyCheck ) {
		rsync.set( 'dry-run' );
		rsync.set( 'info', 'NAME' );
	}

	if ( includes.length > 0 ) {
		rsync.include( includes );
	}

	if ( excludes.length > 0 ) {
		rsync.exclude( excludes );
	}

	console.log( rsync.command() );

	if ( core.isDebug() ) {
		rsync.debug( true );
	}

	let processedFiles = 0;

	// Execute the command
	rsync.execute(
		function ( error, code, cmd ) {
			// we're done
			if ( code != 0 && code != 24 ) {
				// 24 is the code for "some files vanished while we were building the file list" See https://rsync.samba.org/FAQ.html#10
				console.error( 'rsync error: ' + error );
				console.error( 'rsync code: ' + code );
				core.setFailed( 'rsync failed with code ' + code );
			}

			if ( consistencyCheck && processedFiles > 0 ) {
				core.setFailed(
					'Pre-push consistency check failed. Target filesystem does not match build directory.'
				);
			}

			console.log( '::endgroup::' );
		},
		function ( data ) {
			// do things like parse progress
			processedFiles++;
			console.log( data.toString() );
		},
		function ( data ) {
			// do things like parse error output
			console.error( data.toString() );
		}
	);
} )();
