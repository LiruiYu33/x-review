# Verification record

Target version: 1.6.0. Record date: 27 September 2026. Minimum Chrome/Chromium version: 116.

## Scope

The 1.6.0 update adds a per-account Unfollow action that opens a separate native X window. The user performs the unfollow; a page observer verifies the following-to-not-following transition before removing the unchanged local record. A separate undo restores local records only. English and Simplified Chinese remain available with a saved preference, and existing collection, post-date checking, and scan-cleanup behaviour is retained. Updating the extension files does not directly change the records already stored in a user's browser. Reload the extension and refresh X pages to run the updated code.

The validation described below uses local sample data and isolated browser fixtures. It does not access a user's browser profile or actual following list. Real, signed-in X pages and a physical Edge installation have not been validated. Fixture success does not prove that current X markup, loading behaviour, or every page language is supported.

## Existing regression coverage

The included `tests/core.test.cjs` suite checks record parsing, identity handling, evidence classification, import/merge behaviour, and the background synchronisation protocol. Automatic cleanup requires a fresh own-list collection that starts at the top, reads a non-empty set, and naturally reaches a stable bottom. Status reads, manual stops, errors, navigation changes, empty collections, and collection limits must not delete old records.

Cleanup retains numeric-ID records, kept accounts, accounts known to belong to another owner, and records added or changed during collection. Older records without ownership information use the owner explicitly confirmed for the current collection. Reaching the bottom still does not prove that X loaded every account, so cleanup keeps a local undo copy.

The background checks the current run before saving the updated list, completion result, and undo data together. Tests cover storage failure, duplicate or late completion messages, no retrospective cleanup for old runs, and no repeat deletion after an undo. Undo restores missing records without replacing newly reimported versions. A later zero-removal run preserves the previous effective undo. Clearing the list clears the undo and prevents a late completion from restoring eligibility.

Before the 1.5.0 language work, isolated Chromium extension checks also covered collection deduplication, automatic cleanup without a manual apply request, read-only synchronisation history, undo, interrupted runs, hidden-tab pause, single-page navigation, rate-limit handling, stopped-task recovery, and continued collection after closing the popup. Additional fixtures checked completion feedback, workspace import/export and filtering, optional site permission handling, standalone operation, and narrow-screen layout. These browser fixtures were release-validation tools and are not all included in this repository.

## Version 1.6.0 workspace validation

Eight isolated Chromium workspace fixture scenarios passed. They checked that real extension records expose the Unfollow action alongside the existing profile link; optional site permission is requested synchronously from a trusted button click before a begin message; an active observation permits returning to its window and prevents another account from starting; language switching does not start or cancel an observation; stopping or denying permission retains records; storage changes remove a row and expose the separate local undo; the English banner fits a 390-pixel viewport; and demo/standalone views do not offer monitored unfollow controls. The English help text and dynamic interface messages were checked for untranslated text. Syntax checks passed for the updated workspace and its translation module.

These workspace fixtures simulate extension messages and local storage. They verify the interface contract rather than current X markup.

All 56 included Node.js tests passed on the final source, including 18 new manual-unfollow background tests. They cover exact document, target and viewer binding; fresh verification immediately before writing; protection against synthetic or unstable evidence, pending navigation, changed local records, other owners and conflicting IDs; mutual exclusion with collection/profile checks; atomic removal with undo; failed storage; stale completion messages; and clear/reset behaviour. JavaScript syntax checks passed for every root script.

Fourteen isolated Chromium observer scenarios passed, including trusted native clicks, confirmation and cancellation, a modal that hides the background with aria-hidden, ambiguous handles and ID mismatches, protected identity binding, optimistic UI rollback, unrelated recommendation clicks, synthetic events, unavailable acknowledgements, language switching, and cancellation propagation. The observer never activates the native controls.

Seven integration scenarios passed using the real extension service worker, storage, page injection, workspace and Chrome popup windows with synthetic X pages. Tests verified row removal after manual confirmation without a rescan, local-only undo, cancellation and closure, initially unfollowed profiles, numeric-ID redirects, concurrent local edits, and stopping monitoring. The fixture opens a blank window briefly before navigating so Playwright can attach offline interception before the first request; this is a test-only timing accommodation, not production behaviour. No real X account or network was used.

The final source also passed nine following-list cleanup integration scenarios and 15 workspace regression scenarios covering imports, evidence, filtering, backups, undo, standalone mode and narrow layouts. The historical language checks below describe the previous release and are not claimed as a full current-version rerun.

## Historical version 1.5.0 validation

All 38 included Node.js tests passed: 27 record/synchronisation tests, eight shared translation/preference tests, and three runtime-diagnostic translation tests. Root JavaScript syntax checks also passed.

Version 1.5.0 isolated Chromium checks passed across six full-extension language scenarios, eight workspace language scenarios, and six popup/controller language scenarios. They verified switching both ways, reopening with the saved choice, live synchronisation across extension pages and the injected collector panel, independent standalone storage, English dates and dynamic diagnostics, unchanged imported account data and draft inputs, no task restart or cancellation during a language change, and a 390-pixel-wide English layout without document overflow. The collector test also confirmed that its language setting leaves the X host document language unchanged.

Version 1.5.0 additionally passed nine automatic-cleanup extension regression scenarios and 15 workspace regression scenarios, including import/export, evidence edits, filtering, backups, undo, incomplete-scan protection and optional host permissions. All browser checks used fixtures, not a live X account. The preview image contains fictional demo accounts.

The repository CI workflow runs syntax checks on the root JavaScript files and runs all included Node.js tests with `node --test tests/*.test.cjs`. This documents the configured checks; a workflow file alone is not evidence of a successful GitHub Actions run.

## Browser-fixture boundaries

Browser checks use synthetic X pages served through local request fixtures and a fresh Chromium profile. Where injection requires host access, only the isolated test copy grants that access; the published manifest keeps X host access optional. Accelerated fixture timers do not change the production collection interval of approximately 2.5 seconds. The tool does not call X's follow or unfollow controls.

The extension permissions remain `activeTab`, `scripting`, and `storage`, with optional `https://x.com/*` access requested for a user-started profile check or manual-unfollow window. No cookie access, network interception, private API, or external application server is introduced. Repository branch protection is a separate GitHub setting and must be verified on GitHub after application; its committed configuration does not activate it automatically.
