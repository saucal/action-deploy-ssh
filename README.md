# Deploy files to an FTP server

This repo allows you to make a deployment to FTP (adding and/or removing files).

## Getting Started

You can push to FTP with the following basic example

```yml
- name: Deploy to FTP
  uses: saucal/action-deploy-ftp@v2
  with:
    manifest: |
      + file-to-push.php
      - file-to-remove.css
    env-type: 'sftp'
    env-host: ${{ secrets.FTP_HOST }}
    env-port: ${{ secrets.FTP_PORT }}
    env-user: ${{ secrets.FTP_USER }}
    env-pass: ${{ secrets.FTP_PASS }}
    env-local-root: 'source'
    env-remote-root: ${{ secrets.FTP_PATH }}
```

## Full options

```yml
- uses: saucal/action-deploy-ftp@v2
  with:
    # SFTP is the default, and only supported value here.
    env-type: "sftp"

    # FTP Host to use to connect
    env-host: ""

    # FTP Port to use to connect
    env-port: ""

    # FTP User to use to connect
    env-user: ""

    # FTP Password to use to connect
    env-pass: ""

    # FTP Root to push to
    env-remote-root: ""

    # Root of the locals files stated in the manifest
    env-local-root: ""

    # List of files to push/remove.
    # Pushes prefixed with +, removals with -.
    #
    # manifest: |
    #   + file-1.txt
    #   + file-2.txt
    #   - old-file.txt
    manifest: ""

    # Ignore files when present in the manifest. 
    # Similar to .gitignore functionality, tho each rule is
    # analized individually, compared to how gitignore works
    # where you can negate part of a previous rule.
    #
    # For multiline, you can do:
    #
    # force-ignore: |
    #   ignore1
    #   ignore2
    #   directory/**
    force-ignore: ""
```
