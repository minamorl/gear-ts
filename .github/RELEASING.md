# Releasing

`@minamorl/gear` is published from GitHub Actions using Release Please and npm
provenance.

## Release flow

1. Merge work into `main` with Conventional Commit messages. `fix:` requests a
   patch release and `feat:` requests a minor release; breaking changes use `!`
   or a `BREAKING CHANGE:` footer.
2. The Release workflow opens or updates a version pull request. Release Please
   updates `package.json`, `package-lock.json`, `src/version.ts`, the release
   manifest, and `CHANGELOG.md`.
3. Review and merge the version pull request. The next Release run creates the tag
   and GitHub Release, then checks out that tag in its publish job.
4. The publish job installs dependencies, checks formatting, type-checks, tests,
   builds, and runs `npm publish --provenance --access public`.

The first release is `0.1.0`: the initial manifest contains `0.0.0` and the config
sets `initial-version` to `0.1.0`. `bootstrap-sha` limits the first changelog to
commits after the pre-publication baseline. Add the automation with a releasable
commit such as `feat(ci): prepare Gear for public releases`; `docs:` and `chore:`
alone do not request a release.

Keep the `x-release-please-version` annotation in `src/version.ts`. It lets the
generic updater keep the exported runtime version aligned with the package.

## Repository setup

- Make the repository public before publishing with provenance.
- Enable **Settings → Actions → General → Allow GitHub Actions to create and
  approve pull requests**.
- Set the repository Actions secret `NPM_TOKEN` to a valid granular npm token
  authorized to publish `@minamorl/gear`. Unattended publication needs permission
  to bypass an interactive 2FA challenge.

The workflow exposes this token only to the publishing step as `NODE_AUTH_TOKEN`.
Do not commit npm credentials. The publish job grants `id-token: write` for
provenance and disables the setup-node package cache.

## Version pull-request checks

Release Please uses `GITHUB_TOKEN`. Events created by that token do not start new
workflow runs, so a generated version pull request may have no automatic CI run.
The CI workflow supports manual dispatch against that branch before merging. The
publish job also repeats all package checks against the released tag.

Both workflows support manual dispatch. Release only acts on `main`; dispatching
it on another branch skips its jobs.

## Retrying a failed publication

Use **Re-run failed jobs** on the original Release run. That preserves the
successful release job's tag output. A new manual Release run generally sees an
already-created release and skips publishing.

Before retrying after an ambiguous network failure, check whether the exact version
already exists on npm. Published versions cannot be overwritten. For later fixes,
merge a new releasable commit and publish a new version.
