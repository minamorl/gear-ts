# Deploying the Gear FIFO host

`deploy-vultr.sh` deploys a committed source checkout to immutable releases and
switches a `current` symlink after building. Despite its historical filename, it
uses ordinary Linux tools and has no provider-specific API dependency.

The host currently starts with an empty program registry. Register your application
programs in `src/bin/host.ts`, commit them, and verify the build before deploying.
A running service and FIFO prove that the host is available; they do not prove that
an application program succeeds.

## Requirements

- Linux, Bash, GNU coreutils, Git, tar, flock, and a working user systemd manager.
- Node.js 20 or later and npm. The defaults are `/usr/bin/node` and `/usr/bin/npm`.
- A source checkout that can fetch `origin/main` and install its npm dependencies.
- A `.env` file in the source checkout with mode exactly `0600`. It must use
  systemd `EnvironmentFile` syntax; an empty file is sufficient when the application
  needs no additional environment variables.

The script runs as the service user and does not invoke `sudo`. If the service
must survive logout, arrange user lingering with the system administrator.

## Setup

Run these commands from the source checkout as the service user:

```sh
test -e .env || (umask 077; touch .env)
chmod 0600 .env
install -d -m 0700 "$HOME/.config/systemd/user"
install -m 0644 deploy/gear-host.service "$HOME/.config/systemd/user/gear-host.service"
systemctl --user daemon-reload
systemctl --user enable gear-host.service
./deploy/deploy-vultr.sh
```

The unit uses `%h`, which systemd expands to the service manager user's home
directory. Its defaults agree with the script:

| Setting          | Default                                   |
| ---------------- | ----------------------------------------- |
| Source           | Checkout containing the deployment script |
| Deployment root  | `$HOME/deploy/gear`                       |
| Releases         | `$HOME/deploy/gear/releases/<commit-sha>` |
| Active release   | `$HOME/deploy/gear/current`               |
| Persistent state | `$HOME/deploy/gear/shared`                |
| Intake FIFO      | `$HOME/deploy/gear/shared/intake`         |
| Service          | `gear-host.service` in the user manager   |
| Node / npm       | `/usr/bin/node` / `/usr/bin/npm`          |

Every release links `.env` to the source checkout's canonical `.env`; secrets are
not copied into releases. The unit loads `current/.env`, sets `GEAR_STATE_DIR` to
the shared directory, and starts `dist/bin/host.js` with `UMask=0077` and
`NoNewPrivileges=true`.

## Configuration

| Variable             | Purpose                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `GEAR_SOURCE_REPO`   | Override the absolute source checkout path.                                |
| `GEAR_DEPLOY_ROOT`   | Override the absolute deployment root.                                     |
| `GEAR_DEPLOY_REF`    | Default ref when no positional ref is supplied; defaults to `origin/main`. |
| `GEAR_KEEP_RELEASES` | Positive number of ready releases to retain; defaults to `3`.              |
| `GEAR_NODE_BIN`      | Node executable path; defaults to `/usr/bin/node`.                         |
| `GEAR_NPM_BIN`       | npm executable path; defaults to `/usr/bin/npm`.                           |

When changing the deployment root or Node path, also update the installed unit's
`WorkingDirectory`, `GEAR_STATE_DIR`, `EnvironmentFile`, and `ExecStart` as
appropriate, then run `systemctl --user daemon-reload`. Before fetching or building,
the script checks that the loaded service's working directory is exactly the
configured `current` path. A mismatch stops deployment. Executable overrides apply
to the build script only; they do not rewrite the installed service unit.

## Updates

```sh
./deploy/deploy-vultr.sh
./deploy/deploy-vultr.sh <reviewed-ref-or-commit>
```

The default ref fetches `origin/main`; other refs are resolved locally. Every ref
must resolve to a full 40-character lowercase commit SHA. Uncommitted changes are
not deployed.

The script takes a nonblocking deployment lock, archives the commit, runs `npm ci`
and `npm run build`, and verifies `dist/bin/host.js`. It writes the revision and
ready marker before renaming the staging directory into a release. Ready releases
for the same commit are reused; incomplete existing releases are left untouched
and rejected.

After building, the script atomically switches `current` and restarts the service.
The shared state directory is outside releases and is never pruned.

## Health checks and rollback

Health requires both:

1. `systemctl --user is-active --quiet gear-host.service` succeeds.
2. The shared `intake` path is a FIFO.

The script checks up to 40 times, sleeping one second after each failure. It does
not send application work, perform an HTTP probe, or inspect the FIFO protocol.
Service-command execution time is additional to that sleep budget.

If the new release fails, the script restores the previous valid release and
restarts it, then applies the same health checks. Deployment still exits with a
failure status after rollback. On a first deployment there is no previous release
to restore.

Only successful deployments prune old ready releases. The current release and
previous rollback candidate are retained even when they fall outside the configured
retention count. Existing non-FIFO intake paths and unsafe release symlinks are
rejected.

## Inspect the service

```sh
systemctl --user status gear-host.service
journalctl --user -u gear-host.service -f
readlink "$HOME/deploy/gear/current"
```

The deployment script and unit are provided for application integration. Build
checks do not establish that the service, FIFO, or rollback works on a particular
host; verify those after configuring your deployment.
