# Verification record

Target version: 1.6.8. Record date: 27 September 2026. Minimum Chrome/Chromium version: 116.

## Scope

The 1.6.0 update adds a per-account Unfollow action that opens a separate native X window. The user performs the unfollow; a page observer verifies the following-to-not-following transition before removing the unchanged local record. A separate undo restores local records only. English and Simplified Chinese remain available with a saved preference, and existing collection, post-date checking, and scan-cleanup behaviour is retained. Updating the extension files does not directly change the records already stored in a user's browser. Reload the extension and refresh X pages to run the updated code.

The historical validation below uses local sample data and isolated browser fixtures. Version 1.6.1 additionally includes a limited, read-only inspection of a signed-in X Following page to confirm the reported identity-parsing issue. No follow or unfollow action was performed during that inspection. A physical Edge installation and the complete updated extension workflow on signed-in X have not been validated. Fixture success does not prove that every X page layout, loading behaviour, or language is supported.

## Version 1.6.8 profile-check startup

The user reported an `about:blank` tab and the previous generic "checking page was closed" status. Source inspection ties that status to a catch covering controller-tab, extension-context and checking-tab reads; the exact underlying browser exception was not captured. It does not establish that the user closed a tab or that blank-page permissions caused the error. The old start command deliberately opened a blank page and depended on a subsequent control-page request to navigate it.

Starting now selects the first eligible account, opens its actual X URL and starts one observation in the background service. That first navigation is reused, including numeric-ID redirects. Subsequent requests carry their expected queue index; stale requests only retrieve progress, and the index is checked again within the write queue before selection. The controller retains its one-second pause before requesting another account. No autonomous multi-account loop is introduced.

Page-validation API failures receive up to two cancellable read retries, 250 ms apart. Explicit missing-tab errors stop immediately. A persistent failure reports the validation stage and original error instead of assuming that a page was closed. Permission, controller identity, target identity, cancellation and save guards remain enforced.

All 234 included Node.js tests and root JavaScript syntax checks passed, including 18 new startup and indexed-controller cases. Coverage includes direct handle/ID navigation, startup without a control-page continuation, delayed and duplicate requests, queue selection races, creation failures, bounded read retries and accurate diagnostics. Three focused startup regressions fail against the unchanged 1.6.7 service: it creates a blank page for both handle and numeric-ID targets and does not begin observing without a second request. These tests use a virtual clock and mocked browser APIs; the user's original browser exception and a signed-in end-to-end rerun remain unverified.

## Version 1.6.7 faster post-date checks

Profile checks remain serial in one X tab. A ready observation classified as recent under the selected inactivity threshold can complete after at least 2 seconds from navigation and 1 second of matching evidence. Old or insufficient evidence still requires at least 5 seconds; a ready timeline still needs 1.5 seconds of matching evidence on that path. Unavailable pages retain the 5-second minimum, and unresolved loading retains the 25-second deadline. The controller pauses for 1 second between accounts instead of 3 seconds.

The service samples every 500 ms and installs the page reader once per visit, recovering if a reload removes it or script execution fails. Loading, missing probes and changes of document reset accumulated stability. Existing page readiness, account identity, permission, cancellation and login/rate-limit checks remain in place. Before saving a fast recent result, the service rechecks the current threshold; if it no longer establishes recent activity, it stops without changing that account's evidence or advancing the queue.

All 216 included Node.js tests and root JavaScript syntax checks passed. The 37 new service and controller cases cover recent and conservative timing boundaries, changing timestamps, loading and document replacement, script recovery, threshold changes before saving, serial requests, cancellation, navigation and permission loss, completion and language switching. The control-page timing regressions fail against the unchanged 1.6.6 controller. Two focused service regressions also fail against the exact 1.6.6 source: recent evidence is not committed by 2 seconds, and an unchanged profile receives repeated script installations.

The timing checks use a virtual clock and mocked Chrome APIs. They verify the production service and controller logic, not live X loading or total run duration. No real account actions were performed for this update.

## Version 1.6.6 faster manual-unfollow recognition

A recognised, trusted manual action now uses a 500 ms stable Follow interval instead of 2,000 ms. The background independently enforces the same interval before local removal. Initial not-following reconciliation still requires 2,000 ms and matching stored ownership. The panel reports verification as soon as the native Follow state is recognised, and restores an accurate still-following message if the page rolls back. Cancellation, identity conflicts, hidden or pending controls, unstable observations, two fresh background probes, atomic removal with undo and save-before-close remain enforced.

Detection also rejects timeline and other excluded controls before computing their visibility or geometry, reuses the profile-name geometry within a single read, and reuses the viewer evidence within a single tick. This removes redundant work without changing which profile controls qualify. The 250 ms fallback poll and error-retry interval remain unchanged.

The user reported a 5–10 second wait while the panel still showed its pre-verification prompt. Source inspection confirms a fixed two-second delay and unnecessary layout work but does not attribute every second of that reported wait. The reduced interval is measured from recognised eligible page evidence, not from the native click; it is not a promise of total completion time or an X server acknowledgement. A late UI rollback remains possible, and local undo remains available.

All 179 included Node.js tests and root JavaScript syntax checks passed, including manual 499/500 ms boundaries, recovery 1,999/2,000 ms boundaries, rollback and fresh-probe failures, visible feedback, stability resets, and excluded controls that fail the test if their geometry is read. A local browser fixture observed the manual confirmation report 598 ms after the native Follow change; a separate initial-state fixture required 2,228 ms of stable evidence before reporting reconciliation. The fixtures run the production watcher with a scoped fictional X URL and mocked background acknowledgements, so these figures measure fixture recognition rather than installed-extension save-and-close time. Validation uses fictional accounts and mocked Chrome APIs; the user's signed-in end-to-end latency has not been measured.

## Version 1.6.5 automatic popup closure

After a verified manual unfollow or owner-bound current-state reconciliation, the background now waits for the atomic local removal and undo save before closing the monitored tab. Removing its sole tab closes the original popup. Closure runs outside the shared write queue, so the tab-removed event cannot deadlock persistence, and that event cannot change an already completed result to cancelled. No new permission is required.

The close operation requires the same completed run, original tab and window, and the same fully loaded profile with no pending navigation. Moved or navigated tabs are left open; additional tabs in the popup are not removed. A changed run or local undo aborts closure. Browser closure errors leave the saved removal and undo intact. Retained, cancelled, unverified and failed-save outcomes do not close the tab.

All 168 Node.js tests and root JavaScript syntax checks passed, including 20 new closure cases covering save-before-close ordering, both success paths, terminal failures, duplicate completion, close failures, tab movement and navigation, concurrent undo and replacement sessions. Tests exercise the actual background service and its message flow with mocked Chrome APIs. The installed-extension window-close behaviour on a signed-in X account has not been exercised end to end.

## Version 1.6.4 profile-loading feedback-loop fix

Version 1.6.3 added native `aria-label` observation, but every waiting-state render also rewrote that attribute on the extension panel's light-DOM host. Browsers deliver attribute mutations even when the value is unchanged. The observer consequently reacted to its own panel, repeatedly rendered it and starved normal page tasks until the 25-second profile-recognition timeout. Read-only inspection of the reported window found the page eventually loaded with that timeout message. No native account action was performed.

Rendering is now idempotent, and the observer excludes mutations targeting its own panel while retaining observation of native X controls. Profile identity checks, the startup deadline, stable-state requirements, background verification and manual-action requirements are unchanged.

A real-browser comparison used the unchanged v1.6.3 watcher and the corrected watcher against the same fictional profile scheduled to appear after 500 ms. The baseline delayed insertion to 25,019 ms, delivered 551,517 observer callbacks and stopped; the corrected watcher allowed insertion at 516 ms, delivered one observer callback before the result snapshot and reached the armed state. These are measurements from one local fixture run, not live X network-performance guarantees. The fixture uses a scoped fictional X URL and mocked extension acknowledgements, so it does not validate the installed service worker end to end.

All 148 included Node.js tests and root JavaScript syntax checks passed. The two new loading/panel regressions also failed against the unchanged v1.6.3 source at the bounded mutation-delivery limit, confirming that they detect the original defect. The DOM test harness now delivers filtered attribute mutations, including same-value writes, through a bounded queue. This covers delayed profile readiness, exclusion of panel-only mutations and prompt detection of native accessible-label changes. Earlier mock observers required explicit test notifications and missed this feedback loop.

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
