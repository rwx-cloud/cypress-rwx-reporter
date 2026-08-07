# Releasing

Releases are published by hand. `scripts/release.js` checks what it can; these
steps are the rest.

**1. Install the toolchain.**

```sh
mise install
```

**2. Bump the version on a branch.**

```sh
node scripts/release.js prepare minor   # or major / patch
```

**3. Open a PR and merge it once CI is green.**

**4. Log in to npm.**

```sh
npm login
```

You need the `rwx-bot` account *and* its second factor.

**5. Publish the merged commit.**

```sh
git checkout main && git pull
node scripts/release.js publish
```

It verifies the toolchain, the branch, the tree, the lockfile, the tarball
contents, the npm account, and that neither the version nor the tag is already
taken; runs the suite in RWX; publishes; then tags the published commit and
pushes the tag.

Add `--dry-run` to stop after the checks, or `--skip-ci` if you already watched
the merge commit go green.
