# Verification record

Target version: 1.6.3. Record date: 27 September 2026. Minimum Chrome/Chromium version: 116.

## Scope

The 1.6.0 update adds a per-account Unfollow action that opens a separate native X window. The user performs the unfollow; a page observer verifies the following-to-not-following transition before removing the unchanged local record. A separate undo restores local records only. English and Simplified Chinese remain available with a saved preference, and existing collection, post-date checking, and scan-cleanup behaviour is retained. Updating the extension files does not directly change the records already stored in a user's browser. Reload the extension and refresh X pages to run the updated code.

The historical validation below uses local sample data and isolated browser fixtures. Version 1.6.1 additionally includes a limited, read-only inspection of a signed-in X Following page to confirm the reported identity-parsing issue. No follow or unfollow action was performed during that inspection. A physical Edge installation and the complete updated extension workflow on signed-in X have not been validated. Fixture success does not prove that every X page layout, loading behaviour, or language is supported.

## Version 1.6.3 subscription-enabled profile recognition

A read-only inspection of the reported native X profile confirmed that a paid Subscribe button used a numeric `-unfollow` test ID, while the actual relationship control was an icon-only button identified by an account-bound Unfollow label with no test ID. Treating every numeric follow/unfollow suffix as relationship evidence could therefore select the subscription button or produce a false conflict. The reported window's full before-and-after event was not captured, and no real follow, unfollow or subscription control was activated during diagnosis.

The watcher now recognises exact native action text and accessible labels within the existing profile-header boundary. Paid subscription controls never supply relationship state or trusted action evidence. A recognised subscription label explicitly addressed to the same account may corroborate its numeric ID when the native relationship icon lacks one. Mismatched handles, numeric IDs, action labels and relationship suffixes still retain the record. Missing, pending or disabled native controls cannot fall back to a subscription button. Stopped and failed panels explain that monitoring has ended and direct the user to reopen the account from the workspace, instead of asking them to keep waiting. Conflict messages identify which evidence disagreed.

All 145 included Node.js tests and root JavaScript syntax checks passed, including 37 new watcher cases covering English, Simplified Chinese and Traditional Chinese action labels, subscription-only controls, mixed pending/Follow evidence, target and ID conflicts, cancellation and terminal guidance. Two local browser fixture scenarios passed: manual confirmation with an unchanged subscription button (including an unrelated subscription click that did not authorise removal), and initial not-following reconciliation beside that subscription button. Local browser fixtures use fictional accounts and the production watcher with a scoped fictional X URL and mocked extension acknowledgements; they do not exercise the installed extension service worker or prove a successful end-to-end action on the user's X account.

## Version 1.6.2 manual-unfollow recovery

The watcher previously discarded a trusted manual action whenever profile controls briefly became unreadable, which could leave a stale local record after X had already completed the unfollow. It now distinguishes temporary missing elements from contradictory identity evidence, permits a missing-element gap of up to five seconds, and restarts the full two-second stability check on recovery. Conflicting identity, cancellation and an expired gap retain the record with a visible explanation. A rendered signed-in profile link outside the viewport can still identify the viewer. Disabled or busy profile controls cannot establish follow-state evidence; the full stability interval restarts after they become ready.

A separate reconciliation path handles a profile that is already not followed when its window opens, including an action completed during the initial monitoring handshake. It verifies the same profile, numeric ID and signed-in viewer in a stable Follow state. The background requires a non-empty stored following-list owner matching that viewer, the unchanged record fingerprint, current permission and two fresh page probes before the atomic local removal and undo save. This path reports a current-state synchronisation, not a newly observed manual unfollow. Unknown-owner imports and conflicting ownership remain retained.

All 108 included Node.js tests and root JavaScript syntax checks passed. New coverage comprises 27 watcher state-machine tests and 12 background reconciliation tests, including cancellation, synthetic events, timing boundaries, viewer and target changes, ownership checks, current-document checks, repeated proof validation, concurrent record changes, storage failure and local undo. Five local browser fixture scenarios passed: delayed control replacement after confirmation, initially not followed, state change during the initial handshake, contradictory numeric identity, and a retained backend response for an unknown-owner record. Browser fixtures ran the production watcher with a scoped fictional X URL and mocked extension acknowledgements; they do not exercise the installed extension service worker.

The user reported that X had changed its button to Follow while the extension retained the record. The exact missed event in that earlier window was not captured. A read-only check confirmed the current native profile selectors without clicking any real follow or unfollow control. Regression fixtures use fictional accounts; they do not prove a successful end-to-end action on the user's real account.

## Version 1.6.1 following-list identity fix

The previous reader searched every profile link and handle in an entire account row. A biography mentioning another account therefore produced multiple identity candidates and caused the followed account to be skipped. Read-only inspection of a signed-in Following page confirmed this failure on 36 observed rows. The inspection identified 177 distinct displayed account identities while the profile counter showed 178; that remaining discrepancy was not resolved, so this is not evidence of a complete 178-account scan.

The updated reader requires an unambiguous avatar identity, a matching avatar profile destination, and a separate exact displayed handle link. Biography mentions no longer disqualify an otherwise verified account. Conflicting identity evidence remains excluded. Older layouts without avatar metadata retain the conservative single-candidate rule. The collection timing and local-cleanup policy are unchanged.

Thirteen new dependency-free Node.js tests run the actual reader in a VM with a small DOM fixture. They cover biography mentions, link order, a fictional mixed list, conflicting avatar identities and destinations, missing corroboration, case handling, legacy layouts, recommendation exclusion, hidden rows, owner exclusion and deduplication. Fixtures contain fictional accounts; no actual following list or biography is included in the repository.

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
