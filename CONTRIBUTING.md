# Contributing to X Review

Use an issue to describe a reproducible problem or a proposed change. Include the browser and extension versions, the expected behaviour, and the observed behaviour. Remove personal account lists, profile data, cookies, access tokens, and private paths from examples or screenshots before posting them.

## Local development

Fork or clone the repository, create a feature branch, and load its root folder as an unpacked extension in Chrome or Edge. There are no runtime dependencies to install and no build step. Use Node.js 24 to run the included tests:

```sh
node --test tests/*.test.cjs
```

The CI workflow also runs `node --check` on each root JavaScript file. After changing extension files, reload the extension and refresh any open X page before testing. Use a separate browser profile and synthetic fixtures when possible. Do not commit exported account data, browser profiles, credentials, generated archives, or local test artefacts.

Keep English and Simplified Chinese interface text consistent, including empty states, errors, and dynamically rendered messages. Do not rewrite user-supplied names or stored notes when changing language. Translate known diagnostic messages only at the presentation boundary. Language changes must not start, restart, or stop a collection, profile check, or manual-unfollow observation, and must not clear review data.

Preserve the project's behaviour: no automatic follow or unfollow actions; unknown evidence never establishes inactivity; interrupted or incomplete collection does not prune old records; cleanup has an undo; and existing data is not silently overwritten. A manual-unfollow observer may remove a local record only after verifying a following-to-not-following transition on the intended profile for the same viewer. Never infer success from closing a window, clicking a confirmation, an initially unfollowed profile, or a missing button. Keep the record when identity, ownership, the transition, or local changes cannot be established. The manual-removal undo restores local data only and must not follow an account again. Keep optional permission requests on the original trusted user gesture. Add focused tests for changes that affect these guarantees. Describe the observed test results and their limits in your pull request; passing fixtures do not establish compatibility with live X pages.

## Pull requests and protected main

Propose changes through a pull request targeting `main`. Describe the concrete problem, the resulting behaviour, and how it was checked. Keep the branch up to date and resolve review conversations before merging. The CI job is deliberately named `test`, matching the required status check in [the protection configuration](.github/branch-protection.json).

The intended protection requires a pull request and a successful, up-to-date `test` check, including for administrators, and disallows force pushes and branch deletion. The required approving-review count is zero because the repository currently has a sole maintainer who cannot approve their own pull requests. `CODEOWNERS` routes reviews to the maintainer without imposing a separate approval gate. Other users still need repository write access to merge; a public repository does not grant that access. A maintainer with administration rights can change repository settings, so these rules prevent accidental bypass rather than removing the owner's control.

The JSON file documents the intended server-side settings; committing it alone does not enable branch protection. A repository administrator can apply and verify it using an authenticated GitHub CLI:

```sh
gh api --method PUT repos/LiruiYu33/x-review/branches/main/protection \
  --input .github/branch-protection.json
gh api repos/LiruiYu33/x-review/branches/main/protection
```

Apply protection after the initial branch and CI job exist. Check the returned settings rather than treating this document as proof that protection is active. If the CI job is renamed, update both the workflow and the required status check without leaving `main` blocked on a check that will never run. The schema follows the [GitHub branch-protection API](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection).

## Releases

Update the manifest version and user-facing documentation, run the included checks, and test installation from an extracted release ZIP. Publish a version tag and a ZIP containing the extension files with `manifest.json` directly inside its top-level folder. Do not include local browser data, test profiles, unpublished recordings, or secrets. Record any unverified live-browser behaviour instead of implying broader coverage.

Contributions are distributed under the repository's [MIT licence](LICENSE).
