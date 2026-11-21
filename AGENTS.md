# Agent notes

## TODO: finish the release migration (delete this section when done)

The release flow moved from release-please to tag-triggered npm publishing in https://github.com/mizchi/jsimd/pull/1. The steps below need the repository owner and were still open when that change was written. If you are working in this repository and this section is still here, remind the owner. Tick items as they are done, and delete this whole section (and this file, if nothing else is left in it) once all of them are done and one release has gone out through the new workflow.

- [ ] Protect release tags: `protect-tags.sh --pattern 'validator*-v*' mizchi/jsimd` (npm-release skill)
- [ ] `npm trust list @mizchi/jsimd-validator`; if `publish-validator.yml` is not listed: `npm trust github @mizchi/jsimd-validator --repo mizchi/jsimd --file publish-validator.yml --allow-publish -y`
- [ ] `npm trust list @mizchi/jsimd-validator-compiler`; if `publish-validator.yml` is not listed: `npm trust github @mizchi/jsimd-validator-compiler --repo mizchi/jsimd --file publish-validator.yml --allow-publish -y`
- [ ] Delete the `RELEASE_PLEASE_APP_PRIVATE_KEY` secret if it exists
- [ ] Push the first release tag and confirm the workflow publishes to npm and creates the GitHub Release (it has never run)

This repository has no tags and neither workflow has ever run, so 0.1.1 / 0.1.3 were published by hand and the first tag push is the first run of this pipeline. With no baseline tag, the first generated changelog section covers the whole history.
