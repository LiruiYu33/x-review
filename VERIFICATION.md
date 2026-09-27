# Verification record

Target version: 1.5.0. Record date: 27 September 2026. Minimum Chrome/Chromium version: 116.

## Scope

The 1.5.0 update introduces a saved English/Simplified Chinese interface preference and prepares the source for public distribution. It retains the 1.4.0 collection, observation, automatic local-cleanup, and undo behaviour. Updating the extension files does not directly change the records already stored in a user's browser. Reload the extension and refresh X pages to run the updated code.

The validation described below uses local sample data and isolated browser fixtures. It does not access a user's browser profile or actual following list. Real, signed-in X pages and a physical Edge installation have not been validated. Fixture success does not prove that current X markup, loading behaviour, or every page language is supported.

## Existing regression coverage

The included `tests/core.test.cjs` suite checks record parsing, identity handling, evidence classification, import/merge behaviour, and the background synchronisation protocol. Automatic cleanup requires a fresh own-list collection that starts at the top, reads a non-empty set, and naturally reaches a stable bottom. Status reads, manual stops, errors, navigation changes, empty collections, and collection limits must not delete old records.

Cleanup retains numeric-ID records, kept accounts, accounts known to belong to another owner, and records added or changed during collection. Older records without ownership information use the owner explicitly confirmed for the current collection. Reaching the bottom still does not prove that X loaded every account, so cleanup keeps a local undo copy.

The background checks the current run before saving the updated list, completion result, and undo data together. Tests cover storage failure, duplicate or late completion messages, no retrospective cleanup for old runs, and no repeat deletion after an undo. Undo restores missing records without replacing newly reimported versions. A later zero-removal run preserves the previous effective undo. Clearing the list clears the undo and prevents a late completion from restoring eligibility.

Before the 1.5.0 language work, isolated Chromium extension checks also covered collection deduplication, automatic cleanup without a manual apply request, read-only synchronisation history, undo, interrupted runs, hidden-tab pause, single-page navigation, rate-limit handling, stopped-task recovery, and continued collection after closing the popup. Additional fixtures checked completion feedback, workspace import/export and filtering, optional site permission handling, standalone operation, and narrow-screen layout. These browser fixtures were release-validation tools and are not all included in this repository.

## Version 1.5.0 validation

All 38 included Node.js tests passed: 27 record/synchronisation tests, eight shared translation/preference tests, and three runtime-diagnostic translation tests. Root JavaScript syntax checks also passed.

Current-version isolated Chromium checks passed across six full-extension language scenarios, eight workspace language scenarios, and six popup/controller language scenarios. They verified switching both ways, reopening with the saved choice, live synchronisation across extension pages and the injected collector panel, independent standalone storage, English dates and dynamic diagnostics, unchanged imported account data and draft inputs, no task restart or cancellation during a language change, and a 390-pixel-wide English layout without document overflow. The collector test also confirmed that its language setting leaves the X host document language unchanged.

The current version additionally passed nine automatic-cleanup extension regression scenarios and 15 workspace regression scenarios, including import/export, evidence edits, filtering, backups, undo, incomplete-scan protection and optional host permissions. All browser checks used fixtures, not a live X account. The preview image contains fictional demo accounts.

The repository CI workflow runs syntax checks on the root JavaScript files and runs all included Node.js tests with `node --test tests/*.test.cjs`. This documents the configured checks; a workflow file alone is not evidence of a successful GitHub Actions run.

## Browser-fixture boundaries

Browser checks use synthetic X pages served through local request fixtures and a fresh Chromium profile. Where injection requires host access, only the isolated test copy grants that access; the published manifest keeps X host access optional. Accelerated fixture timers do not change the production collection interval of approximately 2.5 seconds. The tool does not call X's follow or unfollow controls.

The extension permissions remain `activeTab`, `scripting`, and `storage`, with optional `https://x.com/*` access requested for a user-started profile check. No cookie access, network interception, private API, or external application server is introduced. Repository branch protection is a separate GitHub setting and must be verified on GitHub after application; its committed configuration does not activate it automatically.
