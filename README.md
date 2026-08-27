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

    # Ignore rules, gitignore-flavoured. See "Ignore rules" below.
    force-ignore: ""

    # SSH Flags to pass to the RSync command
    ssh-flags: "avrcz"

    # Parameters to be passed to the SSH shell command
    ssh-shell-params: ""

    # Extra options for the RSync command
    ssh-extra-options: "delete no-inc-recursive size-only ignore-times omit-dir-times no-perms no-owner no-group no-dirs"

    # This will make the action run rsync with --dry-run and fail if there was output (so that we can check if rsync "sees" changes)
    consistency-check: ""

    # NEED some help here i though the manifest file was dynamically being produced. What's the point of accepting as a param ?
    manifest: ''

    # Whether the ssh connectivity to be prepared.
    run-pre: true

    # Whether the ssh connectivity to be forgotten post action.
    run-post: true

    # Full path to a script to be executed before rsync.
    action-pre-push: ''
      
```


## Ignore rules

`force-ignore` (and `force-ignore-extra`, appended to it) takes a gitignore-flavoured
list. `SSH_IGNORE_LIST` / `SSH_IGNORE_LIST_EXTRA` are the repository variables that feed
it through `action-bundle-push-to-ssh` and `consistency-check`.

```
/uploads/                 # excluded: we don't send it, and --delete won't remove it
!/uploads/keep.txt        # re-included
```

An exclude is symmetric — it stops us sending a path *and* stops `--delete` removing it.
That is often not what a deploy wants, so four rsync rule types are available as line
prefixes:

| Prefix | Short | What it does |
|---|---|---|
| `protect` | `P` | Keep sending ours, but never delete what is already on the target |
| `risk`    | `R` | An exception to a `protect` |
| `hide`    | `H` | Stop sending, and **do** let `--delete` remove what we pushed before |
| `show`    | `S` | An exception to a `hide` |

```
protect /mu-plugins/          # overwrite our files, leave anything else alone
hide /old-plugin/             # stop deploying it, and clean up what's already there
```

`hide` is how you retire a path. A plain exclude leaves whatever you last pushed sitting
on the server forever; `hide` stops sending it while leaving it deletable.

Prefix a line with `\` to treat it as a literal path (`\protect me.txt`).

### Things worth knowing

- **`protect` only speaks to deletion.** If an exclude also covers the path, nothing gets
  sent there. In a whitelist-style list, pair it with an include:
  `!/mu-plugins/` *and* `protect /mu-plugins/`.
- **`--delete` only removes inside directories rsync is transferring.** If a directory
  doesn't exist locally, rsync never descends into it, so `risk` cannot reach inside.
- **You cannot `show` something inside a wholly hidden directory**, the same way git
  cannot re-include a file under an excluded directory. Hide the contents with a glob
  instead (`hide /legacy/*`).

### Ordering

Rules are sorted most-specific-first, not by the order you wrote them. This is
deliberate: `!dir/` expands to a whole-subtree include (`+ dir/***`), which is much
broader than git's `!dir/`, and specificity ordering is what keeps narrower rules ahead
of it. Ties are broken by reverse authoring order, so the last line written wins, as in
gitignore.

Two consequences differ from `git check-ignore`, both verified against every ignore list
in the fleet before being kept:

- A negation written *before* the broad rule that would recover it still wins.
- A mid-pattern slash (`config/secret.php`) is not anchored to the root, so it matches at
  any depth.

## Tests

```sh
npm test
```

`tests/run.js` drives **real rsync** — every case asserts what actually gets transferred
and what survives `--delete`, not just the text of the filter file. `tests/manifest.sh`
covers the git-manifest reconciliation. See `tests/cases.js` for the behaviours pinned.
