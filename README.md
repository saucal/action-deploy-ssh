# Deploy files to an SSH server

This repo allows you to make a deployment to SSH (adding and/or removing files).

NOTE: the authentication method should be configured before this action is run. Either an SSH key added or password through `sshpass`.

## Getting Started

You can push to SSH using rsync with the following basic example

```yml
- name: Deploy to SSH
  uses: saucal/action-deploy-ssh@v1
  with:
    env-host: ${{ secrets.SSH_HOST }}
    env-port: ${{ secrets.SSH_PORT }}
    env-user: ${{ secrets.SSH_USER }}
    env-key: ${{ secrets.SSH_PASS }}
    env-pass: ${{ secrets.SSH_PASS }}
    env-local-root: 'source'
    env-remote-root: ${{ secrets.SSH_PATH }}
    force-ignore: ${{ inputs.ssh-ignore }}
    ssh-flags: ${{ inputs.ssh-flags }}
    ssh-shell-params: ${{ inputs.ssh-shell-params }}
    ssh-extra-options: ${{ inputs.ssh-extra-options }}

```

## Full options

```yml
- uses: saucal/action-deploy-ssh@v1
  with:
    # SSH Host to use to connect
    env-host: ""

    # SSH Port to use to connect
    env-port: ""

    # SSH User to use to connect
    env-user: ""

    # SSH key to use to connect to the host. Prefer this instead of a key if available.
    env-key: ""

    # SSH Password to use to connect, instead of a key.
    env-pass: ""

    # SSH Root to push to
    env-remote-root: ""

    # Root of the locals files stated in the manifest
    env-local-root: ""

    # Ignore rules. Each line will generate an extra --exclude=... parameter for rsync.
    force-ignore: ""

    # SSH Flags to pass to the RSync command
    ssh-flags: "avrcz"

    # Parameters to be passed to the SSH shell command
    ssh-shell-params: ""

    # Extra options for the RSync command
    ssh-extra-options: "delete no-inc-recursive size-only ignore-times omit-dir-times no-perms no-owner no-group no-dirs"

    # This will make the action run rsync with --dry-run and fail if there was output (so that we can check if rsync "sees" changes)
    consistency-check: ""
      
```
