(async function () {
  const core = require('@actions/core');
  const Rsync = require('rsync');

  const remoteTarget =
	core.getInput('env-user', { required: true }) +
	'@' +
	core.getInput('env-host', { required: true });
  const remotePort = core.getInput('env-port', { required: false });
  let shellParams = core.getInput('shell-params', { required: false });
  let ignoreList = core.getInput('force-ignore', { required: false });
  let extraOptions = core.getInput('extra-options', { required: false });

  let includes,
	excludes = [];

  if (shellParams) {
	shellParams = shellParams.split(' ');
  } else {
	shellParams = ['-oStrictHostKeyChecking=no'];
  }

  if (extraOptions) {
	extraOptions = extraOptions.split(' ');
  } else {
	extraOptions = [
		'delete',
		'no-inc-recursive'
	];
  }

  if (remotePort) {
	shellParams.push('-p ' + remotePort);
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

  var rsync = new Rsync()
	.shell('ssh ' + shellParams.join(' '))
	.flags(core.getInput('env-ssh-flags', { require: true }))
	.source(core.getInput('env-local-root', { required: true }))
	.destination(
	  remoteTarget + ':' + core.getInput('env-remote-root', { required: true })
	);

  for (let i = 0; i < extraOptions.length; i++) {
    rsync.set(extraOptions[i]);
  }

  rsync.include(includes);
  rsync.exclude(excludes);

  rsync.debug(true); // core.isDebug()

  console.log(rsync.command());

  // Execute the command
  rsync.execute(
	function (error, code, cmd) {
	  // we're done
	  if (code != 0) {
		console.error('rsync error: ' + error);
		console.error('rsync code: ' + code);
		core.setFailed('rsync failed with code ' + code);
	  }
	},
	function (data) {
	  // do things like parse progress
	  console.log(data.toString());
	},
	function (data) {
	  // do things like parse error output
	  console.error(data.toString());
	}
  );
})();
