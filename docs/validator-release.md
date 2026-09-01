# Validator package release

`@mizchi/jsimd-validator-compiler` and `@mizchi/jsimd-validator` use independent package versions.
The compiler's primary product is a schema-specialized Wasm SIMD AOT validator; the runtime package
remains the low-level typed-array SIMD implementation.

Normal pushes do not create release pull requests. Release timing remains an explicit maintainer
decision, and publication is isolated from the regular validator CI workflow.

## Initial npm publication

Both package names were unavailable on npm as of 2026-09-01. npm requires an existing package before
its Trusted Publisher can be registered, so version `0.1.0` must be claimed once with an
authenticated maintainer account:

```sh
just release-check-validator-packages

cd packages/validator
npm publish

cd ../validator-compiler
npm publish
```

After both initial publishes, configure a GitHub Trusted Publisher in each npm package:

- owner: `mizchi`
- repository: `jsimd`
- workflow filename: `publish-validator.yml`
- environment: empty

Use 2FA for authorization only. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to the repository.

The release-please workflow also requires the existing `mizchi-release-please` GitHub App to be
installed on this repository and its PEM private key to be stored as
`RELEASE_PLEASE_APP_PRIVATE_KEY`.

Check only the secret name, never its value:

```sh
gh secret list --repo mizchi/jsimd | rg RELEASE_PLEASE_APP_PRIVATE_KEY
```

## Subsequent releases

Use Conventional Commit scopes so release-please can assign changes to the correct component:

- `feat(validator-compiler): ...`
- `fix(validator-compiler): ...`
- `feat(validator): ...`
- `fix(validator): ...`

Start the release explicitly:

```sh
gh workflow run release-please.yml --repo mizchi/jsimd
```

Review and merge the generated release PR. The merge causes release-please to create
`validator-vX.Y.Z` or `validator-compiler-vX.Y.Z` and its GitHub Release. The published release then
starts `publish-validator.yml`, which runs the release checks and uses npm OIDC Trusted Publishing
with provenance.

Verify the result:

```sh
npm view @mizchi/jsimd-validator version
npm view @mizchi/jsimd-validator-compiler version
npm audit signatures
```

Do not manually edit a generated `CHANGELOG.md` or the release manifest after automation takes
ownership of them.
