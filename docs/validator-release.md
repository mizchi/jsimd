# Validator package release

`@mizchi/jsimd-validator-compiler` and `@mizchi/jsimd-validator` use independent package versions.
The compiler's primary product is a schema-specialized Wasm SIMD AOT validator; the runtime package
remains the low-level typed-array SIMD implementation.

Pushing a release tag publishes one package. Nothing else publishes: normal pushes and merged pull
requests do not, and there is no release pull request.

| Package                            | Directory                     | Tag                             |
| ---------------------------------- | ----------------------------- | ------------------------------- |
| `@mizchi/jsimd-validator`          | `packages/validator`          | `validator-v<version>`          |
| `@mizchi/jsimd-validator-compiler` | `packages/validator-compiler` | `validator-compiler-v<version>` |

`.github/workflows/publish-validator.yml` runs on those tags. It stops unless the tag equals the
version in the package's `package.json` and `deno.json`, runs
`just release-check-validator-packages`, packs the package with `pnpm pack`, publishes the tarball
with npm OIDC Trusted Publishing (provenance is attached), and creates the GitHub Release from the
matching section of the package's `CHANGELOG.md`.

## One-time setup

Both packages already exist on npm, which npm requires before a Trusted Publisher can be registered.
Register this repository and workflow for each package (npm 11.15 or newer, 2FA enabled, run in a
terminal with a TTY):

```sh
npm trust github @mizchi/jsimd-validator --repo mizchi/jsimd --file publish-validator.yml --allow-publish -y
npm trust github @mizchi/jsimd-validator-compiler --repo mizchi/jsimd --file publish-validator.yml --allow-publish -y
npm trust list @mizchi/jsimd-validator
npm trust list @mizchi/jsimd-validator-compiler
```

The registration is bound to the workflow filename. Renaming `publish-validator.yml` means
registering again.

Whoever can push a release tag can publish, so restrict creating, moving, and deleting release tags
to repository admins with a tag ruleset on `refs/tags/*-v*`.

Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to the repository or the workflow. A token takes
precedence over OIDC. The workflow needs no repository secret.

Register the Trusted Publisher and the ruleset before pushing the first tag. A tag pushed earlier
fails at the publish step and has to be recreated.

## Releasing

Use Conventional Commits. Only `feat`, `fix`, `perf`, `revert`, and `docs` commits appear in a
changelog, and a package's changelog lists the commits that touch its directory:

- `feat(validator-compiler): ...`
- `fix(validator-compiler): ...`
- `feat(validator): ...`
- `fix(validator): ...`

Release one package at a time from an up-to-date `main`. The example releases
`@mizchi/jsimd-validator` 0.2.0; for the compiler replace `validator` with `validator-compiler`.

```sh
# 1. Bump package.json and deno.json, and prepend the new section to the package's CHANGELOG.md.
just release-prepare-validator-package validator 0.2.0

# 2. Review the changelog section against the diff, then verify the packages.
git add packages/validator
git diff --cached
just release-check-validator-packages

# 3. Commit, tag, and push the branch together with the tag.
git commit -m "chore(validator): release 0.2.0"
git tag validator-v0.2.0
git push origin main validator-v0.2.0

# 4. Watch the publish workflow to the end.
gh run watch --repo mizchi/jsimd --exit-status
```

For the compiler, step 3 reads:

```sh
git commit -m "chore(validator-compiler): release 0.2.0"
git tag validator-compiler-v0.2.0
git push origin main validator-compiler-v0.2.0
```

A version containing `-`, such as `0.2.0-rc.0` with the tag `validator-v0.2.0-rc.0`, is published
under the `next` dist-tag and its GitHub Release is marked as a pre-release.

### Changelog

`just release-prepare-validator-package <component> <version>` runs
[git-cliff](https://git-cliff.org) with the root `cliff.toml` and adds only the new section:

```sh
touch packages/validator/CHANGELOG.md
GITHUB_TOKEN=$(gh auth token) npx -y git-cliff@2.14.2 --unreleased \
  --tag validator-v0.2.0 \
  --tag-pattern '^validator-v[0-9]' \
  --include-path 'packages/validator/**' \
  --prepend packages/validator/CHANGELOG.md
```

- `--tag-pattern` limits the release boundary to this package's tags. Without it, a newer tag of the
  other package hides the commits made before that tag.
- `--include-path` keeps commits that do not touch the package out of its changelog.
- `--prepend` needs an existing file, hence `touch` before the first release.
- `GITHUB_TOKEN` lets git-cliff look up pull requests and authors so that outside contributors are
  credited with `by @login`. Pass `--offline` to skip the lookup.

Versions 0.1.1 of the runtime package and 0.1.3 of the compiler were published without tags. Until a
package has its first tag, its generated section covers the package's whole history.

The generated files are excluded from `deno fmt` in the root `deno.json`. Do not edit a generated
section by hand. Fix the commit message or `cliff.toml` and generate again.

## Verifying

The registry lags about a minute behind a successful workflow run.

```sh
npm view @mizchi/jsimd-validator version
npm view @mizchi/jsimd-validator-compiler version
npm audit signatures
```

## When a release fails

- Before the publish step (version check, release checks): fix the cause on `main`, then recreate
  the tag on the fixed commit.

  ```sh
  git tag -d validator-v0.2.0
  git push origin :refs/tags/validator-v0.2.0
  git tag validator-v0.2.0
  git push origin main validator-v0.2.0
  ```

- After the version reached npm: a published version cannot be published again. Bump the patch
  version and release again.
