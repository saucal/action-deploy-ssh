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
npm test                      # everything
node tests/run.js anchor      # only cases matching "anchor"
node tests/run.js --bugs      # the defects this suite pins
node tests/run.js --notes     # behaviour that is correct but surprising
node tests/run.js --list      # case names and per-file counts
```

The case suite **characterises** the deploy: it pins what the action does *today*, not
what it ought to do. Everything runs against real rsync and real `git check-ignore` --
nothing is mocked.

Two consequences worth understanding before changing anything:

- A case marked `bug:` still asserts the CURRENT, wrong result. The suite stays green
  until someone deliberately changes the behaviour, at which point that case fails and
  the change has to be declared. `--bugs` is the ledger of what is known-broken.
- A case marked `note:` pins behaviour that is correct but surprising -- by design,
  configurable, or matching `git` exactly. These are the ones that look like bugs in a
  bug report and are not.

Case files are `tests/cases-*.js`, picked up automatically:

| File | Area |
|---|---|
| `cases-patterns.js` | gitignore-flavoured pattern translation: anchoring, globs, negation, ordering, hygiene |
| `cases-deploy.js` | what the real rsync invocation does to a target filesystem |
| `cases-manifest.js` | `check-against-manifest.sh` reconciliation, and the repo-rooted subdirectory path |
| `cases-fleet.js` | common real-world rule shapes and the default list, plus hostile input |
| `cases-rules.js` | the `protect` / `hide` / `show` / `risk` prefixes |
| `cases-api.js` | the formatter API used by main.js (`reroot`, `toGitignore`) |

`tests/harness.js` runs rsync with the production flags taken from `main.js`
(`-avrcz` plus `--delete --no-inc-recursive --size-only --ignore-times --omit-dir-times
--no-owner --no-group --no-dirs --no-perms`), so the tests measure the real deploy rather
than a convenient approximation.

Writing a case: prefer the declarative fields (`rules`, `local`, `send`, `remote`,
`filter`, `manifest`, `rsyncExit`). Reach for `check:` only for scenarios they cannot express --
symlinks, mode bits, a file where the target has a directory. A case asserting on
`remote:` must supply `local:`, because `--delete` against an empty source wipes the
target and would make every `DELETED` assertion pass for free.

Other suites, all run by `npm test`:

| File | What it covers |
|---|---|
| `tests/e2e-main.js` | the real `main.js` end to end, against a local target through a fake ssh |
| `tests/manifest.sh` | `check-against-manifest.sh` reconciling each class of mismatch |
| `tests/default-ignore.test.sh` | the shipped `default-ignore.txt` |
| `test-consistency-diff.sh` | `consistency-diff.sh` |

`tests/fleet-audit.js` is not part of `npm test`: it replays every real ignore list from a
fleet scan (`gh-actions-management/scan-results.json`) and fails if any site would deploy
differently. Run it before and after changing the formatter.
