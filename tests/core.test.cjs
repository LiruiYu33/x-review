const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../core.js');
const NOW = '2026-09-27T00:00:00.000Z';
const evidence = (overrides = {}) => ({ observedAt: NOW, latestPostAt: '2025-01-01T00:00:00.000Z', sampleCount: 5, scope: 'profile-posts', hasUncertainReposts: false, profileAtTop: true, ...overrides });
const record = (overrides = {}) => C.normaliseRecord({ handle: 'Someone', evidence: evidence(), ...overrides }, NOW);

function backgroundHarness(records) {
  const stored = { reviewData: { schemaVersion: 1, records: structuredClone(records), thresholdDays: 180 } };
  let listener, failureMode = '', blockedStorage = false, failedWrites = 0;
  const writes = [];
  const chrome = {
    runtime: { id: 'test', getURL: file => 'chrome-extension://test/' + file,
      onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} } },
    storage: { local: {
      get: async key => ({ [key]: structuredClone(stored[key]) }),
      set: async data => {
        if (blockedStorage || (failureMode && data.followingScan?.syncResult?.status === 'applied')) {
          failedWrites++; blockedStorage = failureMode === 'all'; throw Error('QUOTA_BYTES exceeded');
        }
        writes.push(structuredClone(data)); Object.assign(stored, structuredClone(data));
      },
      remove: async key => { delete stored[key]; }
    } },
    tabs: { get: async id => ({ id, url: 'https://x.com/Owner/following' }), onRemoved: { addListener() {} } },
    scripting: { executeScript: async options => options.files ? [] : [{ result: { runId: stored.followingScan?.runId, phase: stored.followingScan?.phase } }] }
  };
  const context = vm.createContext({ chrome, Date, URL, console, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  const sender = { id: 'test', url: 'chrome-extension://test/index.html' };
  const content = { id: 'test', url: 'https://x.com/Owner/following', tab: { id: 7 }, frameId: 0 };
  const send = (message, fromPage = false) => new Promise(resolve => listener(message, fromPage ? content : sender, resolve));
  return { stored, writes, send, fail: mode => { failureMode = mode; }, failedWrites: () => failedWrites,
    begin: () => send({ type: 'SCAN_BEGIN', tabId: 7, ownerConfirmed: true }),
    batch: records => send({ type: 'SCAN_BATCH', runId: stored.followingScan.runId, owner: 'Owner', records }, true),
    finish: (overrides = {}) => send({ type: 'SCAN_PROGRESS', runId: stored.followingScan.runId, owner: 'Owner',
      phase: 'stopped', stopCode: 'bottom-stable', startedFromTop: true, ...overrides }, true)
  };
}

test('normalises identities and rejects malicious or mismatched profile destinations', () => {
  assert.equal(C.normaliseRecord({ profileUrl: 'https://twitter.com/Someone?lang=en' }, NOW).profileUrl, 'https://x.com/Someone');
  assert.equal(C.normaliseRecord({ accountId: '1234567890123456789' }, NOW).key, 'id:1234567890123456789');
  assert.equal(C.profileUrl({ id: '123' }), 'https://x.com/i/user/123');
  assert.equal(C.profileUrl({ id: '123', handle: 'OldHandle' }), 'https://x.com/i/user/123');
  assert.equal(C.normaliseRecord({ id: '123', handle: 'OldHandle' }, NOW).profileUrl, 'https://x.com/i/user/123');
  for (const url of ['javascript:alert(1)', 'https://x.com.evil.test/Someone', 'https://x.com@evil.test/Someone', 'https://x.com/Someone/status/1', 'https://x.com/home', 'https://x.com:444/Someone']) assert.throws(() => C.normaliseRecord({ profileUrl: url }, NOW));
  assert.throws(() => C.normaliseRecord({ handle: 'Good', profileUrl: 'https://x.com/Evil' }, NOW));
  assert.throws(() => C.normaliseRecord({ id: 1234567890123456789 }, NOW));
  assert.throws(() => C.normaliseRecord({ handle: 'account.name' }, NOW));
});

test('fresh complete old visible samples are tentative candidates only', () => {
  const outcome = C.classify(record(), 180, NOW);
  assert.equal(outcome.bucket, 'candidate');
  assert.match(outcome.reason, /候选/);
  for (const overrides of [{ profileAtTop: false }, { sampleCount: 0 }, { hasUncertainReposts: true }, { hasUncertainReposts: undefined }, { latestPostAt: null }]) {
    assert.equal(C.classify(record({ evidence: evidence(overrides) }), 180, NOW).bucket, 'unknown');
  }
});

test('recent dated evidence rules out candidates even when page sampling is incomplete', () => {
  const value = record({ evidence: evidence({ latestPostAt: '2026-09-25T00:00:00Z', profileAtTop: false, hasUncertainReposts: true }) });
  assert.equal(C.classify(value, 180, NOW).bucket, 'recent');
});

test('old snapshots never age automatically into inactivity candidates', () => {
  const value = record({ evidence: evidence({ observedAt: '2026-09-01T00:00:00Z', latestPostAt: '2026-03-10T00:00:00Z' }) });
  assert.equal(C.classify(value, 180, '2026-09-01T00:00:00Z').bucket, 'recent');
  assert.equal(C.classify(value, 180, NOW).bucket, 'stale');
  const nearBoundary = record({ evidence: evidence({ observedAt: '2026-09-26T00:00:00Z', latestPostAt: '2026-03-30T12:00:00Z' }) });
  assert.equal(C.classify(nearBoundary, 180, NOW).bucket, 'recent');
});

test('invalid and future dates stay unknown; manual dates obey freshness', () => {
  for (const overrides of [{ latestPostAt: '2027-01-01' }, { observedAt: '2027-01-01' }, { latestPostAt: '2026-02-30' }, { observedAt: '2026-09-01', latestPostAt: '2026-09-15' }]) assert.equal(C.classify(record({ evidence: evidence(overrides) }), 180, NOW).bucket, 'unknown');
  assert.equal(C.classify(record({ evidence: evidence({ scope: 'manual', sampleCount: 0, profileAtTop: false, hasUncertainReposts: true }) }), 180, NOW).bucket, 'candidate');
  assert.equal(C.classify(record({ evidence: evidence({ scope: 'manual', observedAt: '2026-09-01' }) }), 180, NOW).bucket, 'stale');
  assert.equal(C.classify(record({ status: 'keep' }), 180, NOW).bucket, 'keep');
  assert.equal(C.classify(record({ status: 'reviewed' }), 180, NOW).bucket, 'reviewed');
});

test('zero days leaves unknown evidence, expired observations and review labels intact', () => {
  const cases = [
    [record({ evidence: undefined }), 'unknown'],
    [record({ evidence: evidence({ hasUncertainReposts: true }) }), 'unknown'],
    [record({ evidence: evidence({ observedAt: '2026-09-01T00:00:00Z' }) }), 'stale'],
    [record({ status: 'keep' }), 'keep'],
    [record({ status: 'reviewed' }), 'reviewed']
  ];
  const before = JSON.stringify(cases);
  for (const [value, expected] of cases) assert.equal(C.classify(value, 0, NOW).bucket, expected);
  assert.equal(JSON.stringify(cases), before, 'A workspace filter must not rewrite account evidence or review labels');
});

test('zero threshold persists through GET and invalid updates cannot replace it', async () => {
  const records = [record({ handle: 'Kept', status: 'keep' }), record({ handle: 'Unknown', evidence: undefined })];
  const h = backgroundHarness(records);
  const applied = await h.send({ type: 'THRESHOLD', days: 0 });
  assert.equal(applied.ok, true);
  assert.equal(applied.data.thresholdDays, 0);
  assert.equal(h.stored.reviewData.thresholdDays, 0);
  assert.equal((await h.send({ type: 'GET' })).data.thresholdDays, 0);
  assert.deepEqual(h.stored.reviewData.records, records);
  for (const days of [-1, 0.5, 3651, NaN, Infinity, '0']) {
    const before = h.writes.length;
    const rejected = await h.send({ type: 'THRESHOLD', days });
    assert.equal(rejected.ok, false, 'Reject invalid threshold ' + String(days));
    assert.equal(h.writes.length, before, 'Invalid input cannot write review data');
    assert.equal((await h.send({ type: 'GET' })).data.thresholdDays, 0);
    assert.deepEqual(h.stored.reviewData.records, records);
  }
});

test('a JSON backup restores zero over the default threshold and invalid imported thresholds preserve it', async () => {
  const h = backgroundHarness([record({ handle: 'Existing', status: 'keep' })]);
  const backup = JSON.stringify({ schemaVersion: 1, thresholdDays: 0,
    records: [record({ handle: 'Imported', status: 'reviewed', evidence: undefined })] });
  const parsed = C.parseImport(backup, 'backup.json', NOW);
  const restored = await h.send({ type: 'MERGE', records: parsed.records, thresholdDays: JSON.parse(backup).thresholdDays });
  assert.equal(restored.ok, true);
  const saved = (await h.send({ type: 'GET' })).data;
  assert.equal(saved.thresholdDays, 0);
  assert.equal(saved.records.find(value => value.handle === 'Existing').status, 'keep');
  assert.equal(saved.records.find(value => value.handle === 'Imported').status, 'reviewed');
  assert.equal(JSON.parse(JSON.stringify(saved)).thresholdDays, 0, 'A subsequent JSON export preserves zero');
  for (const thresholdDays of [-1, 0.5, 3651, '0']) {
    const result = await h.send({ type: 'MERGE', records: [], thresholdDays });
    assert.equal(result.ok, true);
    assert.equal(result.data.thresholdDays, 0, 'Ignore an invalid backup threshold without resetting the saved filter');
    assert.equal(h.stored.reviewData.records.length, 2);
  }
});

test('merging keeps review decisions and the latest known post across pinned-post snapshots', () => {
  const first = record({ id: '123', status: 'keep', evidence: evidence({ observedAt: '2026-09-25', latestPostAt: '2026-09-24' }) });
  const later = record({ id: '123', handle: 'Renamed', evidence: evidence() });
  const result = C.mergeRecords([first], [later], NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'keep');
  assert.equal(result[0].handle, 'Renamed');
  assert.equal(result[0].evidence.observedAt, NOW);
  assert.equal(result[0].evidence.latestPostAt, '2026-09-24T00:00:00.000Z');
  result[0].status = 'pending';
  assert.equal(C.classify(result[0], 180, NOW).bucket, 'recent');
});

test('valid observations replace future or contradictory imported evidence', () => {
  const valid = record({ evidence: evidence({ latestPostAt: '2026-09-25' }) });
  for (const invalid of [
    evidence({ observedAt: '2027-01-01', latestPostAt: '2025-01-01' }),
    evidence({ observedAt: NOW, latestPostAt: '2027-01-01' }),
    evidence({ observedAt: NOW, latestPostAt: 'not-a-date' })
  ]) {
    const result = C.mergeRecords([record({ evidence: invalid })], [valid], NOW)[0];
    assert.equal(result.evidence.observedAt, NOW);
    assert.equal(result.evidence.latestPostAt, '2026-09-25T00:00:00.000Z');
    assert.equal(C.classify(result, 180, NOW).bucket, 'recent');
  }
  const result = C.mergeRecords([valid], [record({ evidence: evidence({ observedAt: '2027-01-01' }) })], NOW)[0];
  assert.equal(result.evidence.observedAt, NOW);
  assert.equal(C.classify(result, 180, NOW).bucket, 'recent');
});

test('an empty fresh observation never renews an old candidate', () => {
  const old = record({ evidence: evidence({ scope: 'manual', observedAt: '2026-07-01' }) });
  for (const scope of ['manual', 'profile-posts']) {
    const empty = record({ evidence: evidence({ scope, latestPostAt: null, sampleCount: 0 }) });
    const result = C.mergeRecords([old], [empty], NOW)[0];
    assert.equal(result.evidence.latestPostAt, null);
    assert.equal(C.classify(result, 180, NOW).bucket, 'unknown');
  }
});

test('case-insensitive handles merge; known different IDs with a reused handle remain separate', () => {
  assert.equal(C.mergeRecords([{ handle: 'Someone' }], [{ handle: 'someone' }], NOW).length, 1);
  assert.equal(C.mergeRecords([{ handle: 'Someone', id: '1' }], [{ handle: 'Someone', id: '2' }], NOW).length, 2);
});

test('an ID and handle observation bridges archive-only and handle-only records', () => {
  const existing = [{ id: '123' }, { handle: 'Somebody', status: 'keep' }];
  const result = C.mergeRecords(existing, [{ id: '123', handle: 'Somebody' }, { handle: 'somebody' }], NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '123');
  assert.equal(result[0].status, 'keep');
  assert.equal(result[0].key, 'id:123');
});

test('official following.js is parsed as data without executing appended code', () => {
  const text = 'window.YTD.following.part0 = [{"following":{"accountId":"1234567890123456789","userLink":"https://twitter.com/intent/user?user_id=1234567890123456789"}}];';
  const result = C.parseImport(text, 'following.js', NOW);
  assert.equal(result.records[0].id, '1234567890123456789');
  assert.equal(C.classify(result.records[0], 180, NOW).bucket, 'unknown');
  assert.ok(result.warnings.length);
  assert.throws(() => C.parseImport(text + ' globalThis.PWNED = true;', 'following.js', NOW));
  assert.equal(globalThis.PWNED, undefined);
});

test('backups and arrays preserve evidence and reject unknown backup schema', () => {
  const input = record();
  assert.equal(C.parseImport(JSON.stringify({ schemaVersion: 1, records: [input] }), 'backup.json', NOW).records[0].evidence.latestPostAt, input.evidence.latestPostAt);
  assert.equal(C.parseImport(JSON.stringify([input]), '', NOW).records.length, 1);
  assert.throws(() => C.parseImport('{"schemaVersion":2,"records":[]}', '', NOW));
});

test('CSV supports BOM, quotes, comma-containing names and multiline quoted cells', () => {
  const text = '\uFEFFhandle,name,latestPostAt,observedAt\r\nSomebody,"Smith, \"\"Sam\"\"\nJr",2025-01-01,2026-09-27\r\n';
  const result = C.parseImport(text, 'following.csv', NOW);
  assert.equal(result.records[0].name, 'Smith, "Sam"\nJr');
  assert.equal(C.classify(result.records[0], 180, NOW).bucket, 'candidate');
  const noObservation = C.parseImport('handle,latestPostAt\nSomebody,2025-01-01', '', NOW);
  assert.equal(C.classify(noObservation.records[0], 180, NOW).bucket, 'unknown');
  assert.throws(() => C.parseImport('handle,name\nSomeone,"unclosed', 'a.csv', NOW));
});

test('plain handles and profile URLs import without assuming timestamps', () => {
  const result = C.parseImport('@Somebody\nhttps://x.com/Another\nhttps://evil.test/Bad', '', NOW);
  assert.equal(result.records.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.equal(C.classify(result.records[0], 180, NOW).bucket, 'unknown');
  for (const input of ['', '   ', '[]', '{}']) assert.throws(() => C.parseImport(input, '', NOW));
});

test('CSV export guards formulas and never exports an arbitrary destination', () => {
  const csv = C.exportCSV([record({ name: '=HYPERLINK("https://evil.test")' }), record({ handle: 'Other', name: '  +SUM(1,2)' })]);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"'  \+SUM/);
  assert.match(csv, /https:\/\/x.com\/Someone/);
  assert.equal(C.parseImport(csv, 'export.csv', NOW).records.length, 2);
  assert.throws(() => C.exportCSV([{ handle: 'Someone', profileUrl: 'https://evil.test' }]));
});

test('following owners normalise, union across observation merges, and survive both backup formats', () => {
  const first = record({ followingOwners: ['@Owner', 'owner', 'Other'] });
  assert.deepEqual(first.followingOwners, ['other', 'owner']);
  const merged = C.mergeRecords([first], [record({ source: 'auto-profile', followingOwners: ['Third'] })], NOW)[0];
  assert.deepEqual(merged.followingOwners, ['other', 'owner', 'third']);
  assert.deepEqual(C.parseImport(C.exportCSV([merged]), 'backup.csv', NOW).records[0].followingOwners, merged.followingOwners);
  assert.deepEqual(C.parseImport(JSON.stringify({ schemaVersion: 1, records: [merged] }), 'backup.json', NOW).records[0].followingOwners, merged.followingOwners);
  for (const owners of ['owner', [null], ['invalid.owner']]) assert.throws(() => record({ followingOwners: owners }));
});

test('a new natural scan automatically removes only unchanged unseen handle-only records atomically', async () => {
  const h = backgroundHarness([
    record({ handle: 'Seen' }), record({ handle: 'Legacy' }), record({ handle: 'Owned', followingOwners: ['Owner'] }),
    record({ handle: 'Kept', status: 'keep' }), record({ handle: 'OtherOwner', followingOwners: ['Other'] }),
    record({ handle: 'Shared', followingOwners: ['Owner', 'Other'] }), C.normaliseRecord({ id: '123' }, NOW),
    record({ id: '456', handle: 'KnownID' }), record({ handle: 'Changed' })
  ]);
  const begun = await h.begin();
  assert.equal(begun.ok, true); assert.equal(begun.data.autoSync, true);
  assert.equal('baseline' in begun.data, false); assert.equal('seenHandles' in begun.data, false);
  await h.send({ type: 'MERGE', records: [record({ handle: 'Changed', name: 'Changed after scan began' }), record({ handle: 'AddedLater' })] });
  await h.batch([{ handle: 'Seen' }]);
  const finished = await h.finish();
  assert.equal(finished.ok, true); assert.equal(finished.data.syncResult.status, 'applied');
  assert.equal(finished.data.syncResult.removed, 2); assert.equal(finished.data.syncResult.retainedCount, 6);
  assert.equal(h.stored.reviewData.records.length, 8);
  assert.deepEqual(h.stored.followingSyncUndo.records.map(r => r.key), ['handle:legacy', 'handle:owned']);
  const finalWrite = h.writes.at(-1);
  assert.ok(finalWrite.reviewData && finalWrite.followingScan && finalWrite.followingSyncUndo);
  const report = (await h.send({ type: 'SYNC_STATUS' })).data;
  assert.equal(report.autoSynced, true); assert.equal(report.removedCount, 2); assert.equal(report.canUndo, true);
  assert.deepEqual(Array.from(report.removedRecords, r => r.key), ['handle:legacy', 'handle:owned']);
  assert.equal('candidates' in report, false); assert.equal('available' in report, false);
});

test('status reads and legacy SYNC_APPLY never initiate deletion', async () => {
  const h = backgroundHarness([record({ handle: 'Old' })]);
  await h.begin(); await h.batch([{ handle: 'Seen' }]);
  const before = h.writes.length;
  for (let i = 0; i < 3; i++) assert.equal((await h.send({ type: 'SYNC_STATUS' })).data.autoSynced, false);
  assert.equal(h.writes.length, before);
  const legacy = await h.send({ type: 'SYNC_APPLY', runId: h.stored.followingScan.runId, keys: ['handle:old'], confirmed: true });
  assert.equal(legacy.ok, false); assert.match(legacy.error, /已取消/);
  assert.equal(h.stored.reviewData.records.length, 2);
});

test('partial, manual, limited, empty and non-top scans never automatically delete', async () => {
  const failures = [
    { phase: 'running' }, { phase: 'paused' }, { stopCode: 'manual' }, { stopCode: 'duration-limit' },
    { stopCode: 'step-limit' }, { stopCode: 'account-limit' }, { stopCode: 'rate-limit' },
    { stopCode: 'route-change' }, { stopCode: 'cleared' }, { stopCode: 'unknown' }, { startedFromTop: false }
  ];
  for (const options of failures) {
    const h = backgroundHarness([record({ handle: 'Old' })]); await h.begin(); await h.batch([{ handle: 'Seen' }]);
    await h.finish(options);
    assert.equal(h.stored.reviewData.records.some(r => r.handle === 'Old'), true, JSON.stringify(options));
    assert.equal(h.stored.followingScan.syncResult, undefined);
  }
  const empty = backgroundHarness([record({ handle: 'Old' })]); await empty.begin(); await empty.finish();
  assert.equal(empty.stored.followingScan.stopCode, 'incomplete'); assert.equal(empty.stored.reviewData.records.length, 1);
  const stopped = backgroundHarness([record({ handle: 'Old' })]); await stopped.begin(); await stopped.batch([{ handle: 'Seen' }]);
  await stopped.send({ type: 'SCAN_STOP', tabId: 7 }); await stopped.finish();
  assert.equal(stopped.stored.followingScan.stopCode, 'manual'); assert.equal(stopped.stored.followingScan.syncResult, undefined);
});

test('duplicate completion and late batches cannot delete again after undo or revive stopped scans', async () => {
  const h = backgroundHarness([record({ handle: 'Old', status: 'reviewed', followingOwners: ['Owner'] })]);
  await h.begin(); await h.batch([{ handle: 'Seen' }]); await h.finish();
  const finishedRun = h.stored.followingScan.runId;
  const undo = await h.send({ type: 'SYNC_UNDO' });
  assert.equal(undo.data.restored, 1); assert.equal(undo.data.preview.undone, true);
  assert.equal(undo.data.preview.removedCount, 0); assert.equal(undo.data.preview.removedRecords.length, 0);
  const restored = h.stored.reviewData.records.find(r => r.handle === 'Old');
  assert.equal(restored.status, 'reviewed'); assert.deepEqual(restored.followingOwners, ['owner']);
  assert.deepEqual(restored.evidence, record().evidence);
  const writes = h.writes.length;
  const duplicate = await h.finish(); await h.batch([{ handle: 'Late' }]);
  assert.equal(duplicate.data.syncResult.undone, true); assert.equal(h.writes.length, writes);
  assert.equal(h.stored.reviewData.records.some(r => r.handle === 'Late'), false);
  assert.equal((await h.send({ type: 'SYNC_UNDO' })).data.restored, 0);
  await h.begin();
  const old = await h.finish({ runId: finishedRun }); assert.equal(old.ok, false);
  assert.equal(h.stored.followingScan.syncResult, undefined);
});

test('a zero-deletion scan keeps the previous useful undo without attributing its records to the new scan', async () => {
  const h = backgroundHarness([record({ handle: 'Old' })]); await h.begin(); await h.batch([{ handle: 'Seen' }]); await h.finish();
  const first = h.stored.followingScan.runId;
  await h.begin(); await h.batch([{ handle: 'Seen' }]); await h.finish();
  const report = (await h.send({ type: 'SYNC_STATUS' })).data;
  assert.equal(report.autoSynced, true); assert.equal(report.removedCount, 0); assert.equal(report.removedRecords.length, 0);
  assert.equal(report.canUndo, true); assert.equal(report.undoRunId, first); assert.equal(report.undoRemovedCount, 1);
  assert.notEqual(report.runId, first); assert.match(report.reason, /上一轮/);
  const undo = await h.send({ type: 'SYNC_UNDO' }); assert.equal(undo.data.restored, 1);
  assert.equal(undo.data.preview.undone, false); assert.equal(undo.data.preview.removedCount, 0);
});

test('undo does not overwrite new records with the same identity', async () => {
  const h = backgroundHarness([record({ handle: 'Old' }), record({ handle: 'Other' })]);
  await h.begin(); await h.batch([{ handle: 'Seen' }]); await h.finish();
  await h.send({ type: 'MERGE', records: [record({ handle: 'Other', id: '999', name: 'New record survives' })] });
  const undo = await h.send({ type: 'SYNC_UNDO' }); assert.equal(undo.data.restored, 1);
  assert.equal(h.stored.reviewData.records.find(r => r.handle === 'Other').name, 'New record survives');
});

test('reimported old JSON receives a current timestamp and is protected from current and repeated completion', async () => {
  const old = record({ handle: 'Restored', addedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' });
  const h = backgroundHarness([old]); await h.begin(); await h.batch([{ handle: 'Seen' }]);
  const originalJSON = JSON.stringify({ schemaVersion: 1, records: [old] });
  const imported = await h.send({ type: 'MERGE', records: C.parseImport(originalJSON, 'backup.json').records });
  assert.equal(imported.ok, true); await h.finish();
  assert.equal(h.stored.followingScan.syncResult.removed, 0);
  const restored = h.stored.reviewData.records.find(r => r.handle === 'Restored');
  assert.notEqual(restored.updatedAt, old.updatedAt); assert.equal(restored.addedAt, old.addedAt);
  assert.equal(restored.evidence.observedAt, old.evidence.observedAt);
  await h.finish(); assert.equal(h.stored.reviewData.records.length, 2);
  for (const records of [undefined, null, {}, 'invalid', [null]]) {
    const invalid = await h.send({ type: 'MERGE', records }); assert.equal(invalid.ok, false);
  }
});

test('old 1.3 scans never receive retroactive cleanup from status or completion messages', async () => {
  for (const ended of [true, false]) {
    const h = backgroundHarness([record({ handle: 'Old' })]); await h.begin(); await h.batch([{ handle: 'Seen' }]);
    delete h.stored.followingScan.autoSync;
    if (ended) Object.assign(h.stored.followingScan, { phase: 'stopped', stopCode: 'bottom-stable', startedFromTop: true });
    const before = h.stored.reviewData.records.length;
    await h.send({ type: 'SYNC_STATUS' }); await h.finish();
    assert.equal(h.stored.reviewData.records.length, before); assert.equal(h.stored.followingScan.syncResult, undefined);
    assert.equal((await h.send({ type: 'SYNC_STATUS' })).data.autoSynced, false);
  }
});

test('failed automatic cleanup retains original and acknowledged records and never reports deletion success', async () => {
  for (const mode of ['once', 'all']) {
    const h = backgroundHarness([record({ handle: 'Old' })]); await h.begin(); await h.batch([{ handle: 'Seen' }]);
    h.fail(mode);
    const response = await h.finish(); assert.equal(response.ok, true);
    assert.equal(response.data.syncResult.status, 'failed'); assert.equal(response.data.syncResult.removed, 0);
    assert.match(response.data.reason, /保存失败/);
    assert.deepEqual(h.stored.reviewData.records.map(r => r.handle).sort(), ['Old', 'Seen']);
    const report = (await h.send({ type: 'SYNC_STATUS' })).data;
    assert.equal(report.autoSynced, false); assert.equal(report.removedCount, 0); assert.match(report.reason, /保存失败/);
    const failedWrites = h.failedWrites(); await h.finish(); await h.batch([{ handle: 'Late' }]);
    assert.equal(h.failedWrites(), failedWrites); assert.equal(h.stored.reviewData.records.length, 2);
  }
});

test('clearing records cancels cleanup and removes undo and historical record summaries', async () => {
  const h = backgroundHarness([record({ handle: 'Old' })]); await h.begin(); await h.batch([{ handle: 'Seen' }]); await h.finish();
  await h.send({ type: 'CLEAR' }); await h.finish();
  const report = (await h.send({ type: 'SYNC_STATUS' })).data;
  assert.equal(h.stored.reviewData.records.length, 0); assert.equal(report.canUndo, false);
  assert.equal(report.removedRecords.length, 0); assert.equal(report.removedCount, 0);
  assert.equal((await h.send({ type: 'SYNC_UNDO' })).data.restored, 0);
});

test('automatic unknown observations retain a plain reason through JSON and CSV', () => {
  const r = record({evidence: evidence({latestPostAt:null,note:'账户帖子受保护，无法读取公开发帖时间。'})});
  assert.equal(C.classify(r,180,NOW).bucket,'unknown');
  assert.equal(C.classify(r,180,NOW).reason,r.evidence.note);
  const imported=C.parseImport(C.exportCSV([r]),'results.csv',NOW).records[0];
  assert.equal(imported.evidence.note,r.evidence.note);
  assert.equal(C.classify(imported,180,NOW).bucket,'unknown');
});
