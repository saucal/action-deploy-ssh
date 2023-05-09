(async function () {
  const core = require('@actions/core');
  const Rsync = require('rsync');

  const remoteTarget =
	core.getInput('env-user', { required: true }) +
	'@' +
	core.getInput('env-host', { required: true });
  const remotePort = core.getInput('env-port', { required: false });
  const consistencyCheck = core.getInput('consistency-check', { required: false });

  let ignoreList = core.getInput('force-ignore', { required: false });
  let shellParams = core.getInput('ssh-shell-params', { required: false });
  let sshFlags = core.getInput('ssh-flags', { require: true });
  let extraOptions = core.getInput('ssh-extra-options', { required: false });
  console.log( 'extraOptions: ' + extraOptions );
  let localRoot = core.getInput('env-local-root', { required: true });
  let remoteRoot = core.getInput('env-remote-root', { required: true });
  let manifest = core.getInput('manifest', { required: false });

  // Make sure paths end with a slash.
  localRoot = !localRoot.endsWith('/') ? localRoot + '/' : localRoot;
  remoteRoot = !remoteRoot.endsWith('/') ? remoteRoot + '/' : remoteRoot;

  let includes = [],
	excludes = [];

  if ( consistencyCheck ) {
	console.log( '::group::Running consistency check.' );
  } else {
	console.log( '::group::Running rsync.' );
  }

  shellParams = shellParams.split(' ');
  extraOptions = extraOptions.split(' ');

  if (remotePort) {
	shellParams.push('-p ' + remotePort);
  }

  if ( manifest ) {
	extraOptions.push( '--files-from=' + manifest );
	extraOptions.push( 'delete-missing-args' );
  }

  if (ignoreList) {
	// Split ignore list by newlines
	ignoreList = ignoreList.split('\n');

	for (let i = 0; i < ignoreList.length; i++) {
	  // If starts with a !, include
	  if (ignoreList[i].startsWith('!')) {
		includes.push(ignoreList[i].substr(1, ignoreList[i].length - 1));
		continue;
	  }

	  // Otherwise, exclude
	  excludes.push(ignoreList[i]);
	}
  }

  if ( consistencyCheck ) {
	// Remove verbose flag from sshFlags.
	sshFlags = sshFlags.replace( 'v', '' );
  }

  var rsync = new Rsync()
	.shell('ssh ' + shellParams.join(' '))
	.flags( sshFlags )
	.source( localRoot )
	.destination(
	  remoteTarget + ':' + remoteRoot
	);

  for (let i = 0; i < extraOptions.length; i++) {
    rsync.set(extraOptions[i]);
  }

  if ( consistencyCheck ) {
	rsync.set('dry-run');
	rsync.set('info', 'NAME');
  }

  if ( includes.length > 0 ) {
	rsync.include(includes);
  }

  if ( excludes.length > 0 ) {
	  rsync.exclude(excludes);
  }

  console.log(rsync.command());

  if ( core.isDebug() ) {
	  rsync.debug(true); 
  }

  let processedFiles = 0;

  // Execute the command
  rsync.execute(
	function (error, code, cmd) {
	  // we're done
	  if (code != 0 && code != 24) { // 24 is the code for "some files vanished while we were building the file list" See https://rsync.samba.org/FAQ.html#10
		console.error('rsync error: ' + error);
		console.error('rsync code: ' + code);
		core.setFailed('rsync failed with code ' + code);
	  }

	  if ( consistencyCheck && processedFiles > 0 ) {
		core.setFailed('Pre-push consistency check failed. Target filesystem does not match build directory.');
	  }

	  console.log( '::endgroup::' );
	},
	function (data) {
	  // do things like parse progress
	  processedFiles++;
	  console.log( data.toString());
	},
	function (data) {
	  // do things like parse error output
	  console.error(data.toString());
	}
  );


})();
