/* New user-started scans synchronise the local list only when they naturally
 * finish from the top. Missing handles are local cleanup evidence, not proof of
 * an X unfollow. Public status reads never initiate cleanup or replay old scans.
 */
(function (root) {
  'use strict';

  function createFollowingSyncService({ core, enqueue, load, getScan }) {
    const UNDO_KEY = 'followingSyncUndo';
    const terminalFailures = new Map();
    const getUndo = async () => (await chrome.storage.local.get(UNDO_KEY))[UNDO_KEY] || null;
    const summary = record => ({ key: record.key, handle: record.handle || '', name: record.name || '' });

    function fingerprint(record) { return JSON.stringify(core.normaliseRecord(record, 0)); }
    function baseline(records) {
      return records.map(record => ({ key: record.key, handle: record.handle || null,
        id: record.id || null, updatedAt: record.updatedAt || null, fingerprint: fingerprint(record) }));
    }
    function sharesIdentity(a, b) {
      return a.key === b.key || (a.id && b.id && a.id === b.id) ||
        (a.handle && b.handle && a.handle.toLowerCase() === b.handle.toLowerCase());
    }
    function eligible(scan) {
      return scan?.autoSync === true && scan.phase === 'stopped' && scan.stopCode === 'bottom-stable' &&
        scan.startedFromTop === true && Array.isArray(scan.seenHandles) && scan.seenHandles.length > 0 &&
        Array.isArray(scan.baseline) && /^[a-z0-9_]{1,15}$/i.test(String(scan.owner || ''));
    }
    function removals(data, scan) {
      const owner = scan.owner.toLowerCase(), seen = new Set(scan.seenHandles.map(handle => String(handle).toLowerCase()));
      const byKey = new Map(data.records.map(record => [record.key, record]));
      const removed = []; let retainedCount = 0;
      for (const prior of scan.baseline) {
        const record = byKey.get(prior.key);
        if (!record || (record.handle && seen.has(record.handle.toLowerCase()))) continue;
        let unchanged = false;
        try { unchanged = prior.fingerprint === fingerprint(record); } catch { /* Retain malformed legacy records. */ }
        const owners = Array.isArray(record.followingOwners) ? record.followingOwners : [];
        if (record.id || !record.handle || prior.id || !unchanged || record.status === 'keep' ||
            owners.some(value => String(value).toLowerCase() !== owner)) { retainedCount++; continue; }
        removed.push(record);
      }
      return { removed, retainedCount };
    }

    function report(data, storedScan, undo) {
      const scan = terminalFailures.get(storedScan?.runId) || storedScan;
      const saved = Array.isArray(undo?.records) ? undo.records : [];
      const canUndo = saved.some(record => !data.records.some(current => sharesIdentity(current, record)));
      const applied = scan?.syncResult?.status === 'applied';
      const undone = applied && scan.syncResult.undone === true;
      const result = { runId: scan?.runId || null, owner: scan?.owner || '',
        collected: Array.isArray(scan?.seenHandles) ? scan.seenHandles.length : (scan?.collected || 0),
        reason: '', removedCount: applied && !undone ? scan.syncResult.removed : 0,
        retainedCount: scan?.syncResult?.retainedCount || 0,
        canUndo, autoSynced: applied, undone,
        removedRecords: applied && !undone && Array.isArray(scan.syncRemovedRecords) ? scan.syncRemovedRecords : [],
        undoOwner: canUndo ? undo.owner || '' : '', undoRemovedCount: canUndo ? saved.length : 0,
        undoRunId: canUndo ? undo.runId || null : null };
      if (!scan) result.reason = '重新收集自己的关注名单并自然到底后，软件会自动同步本地旧记录。';
      else if (undone) result.reason = `本轮自动同步已撤销，恢复 ${scan.syncResult.restored || 0} 条仍缺失的本地记录，已有的新记录未被覆盖。`;
      else if (applied) result.reason = `本轮已自动移除 ${scan.syncResult.removed} 条未见的本地旧记录，保留 ${scan.syncResult.retainedCount} 条身份、归属或改动情况不确定的旧记录。`;
      else if (scan.syncResult?.status === 'failed') result.reason = scan.reason || '自动清理保存失败，原记录与此前已保存的名单已保留。';
      else if (['running', 'paused'].includes(scan.phase)) result.reason = '本轮仍在收集；从顶部自然到底后会自动同步本地名单。';
      else if (scan.autoSync !== true) result.reason = '这是旧版本的采集记录，不会补做自动清理。重新收集后才会自动同步。';
      else result.reason = '本轮没有满足完整收集条件，未移除任何旧记录。';
      if (canUndo && undo.runId !== scan?.runId) result.reason += ' 上一轮已执行的移除仍可撤销。';
      return result;
    }

    // Called only by SCAN_PROGRESS while the parent already holds enqueue.
    // This function deliberately does not enqueue and never runs from STATUS.
    async function finish(scan) {
      if (terminalFailures.has(scan?.runId)) return terminalFailures.get(scan.runId);
      const stored = await getScan();
      if (!eligible(scan) || !stored || stored.runId !== scan.runId || stored.autoSync !== true ||
          !['running', 'paused'].includes(stored.phase) || stored.syncResult) return stored;
      const data = await load(), priorUndo = await getUndo();
      const { removed, retainedCount } = removals(data, scan);
      const removedKeys = new Set(removed.map(record => record.key));
      const completedAt = new Date().toISOString();
      const finished = { ...scan,
        syncResult: { status: 'applied', removed: removed.length, retainedCount, completedAt },
        syncRemovedRecords: removed.map(summary),
        reason: `关注名单收集结束，已自动移除 ${removed.length} 条未见的本地旧记录，保留 ${retainedCount} 条不确定记录。本次加载不保证完整。${removed.length ? '可在工作台撤销本次移除。' : ''}`,
        updatedAt: completedAt };
      const changes = { reviewData: { ...data, records: data.records.filter(record => !removedKeys.has(record.key)) }, followingScan: finished };
      // A no-op run must not destroy the previous useful undo snapshot.
      if (removed.length) changes[UNDO_KEY] = { runId: scan.runId, owner: scan.owner, removedAt: completedAt, records: removed };
      try {
        await chrome.storage.local.set(changes);
        return finished;
      } catch (error) {
        const failed = { ...scan,
          syncResult: { status: 'failed', removed: 0, retainedCount: retainedCount + removed.length, completedAt },
          syncRemovedRecords: [], updatedAt: completedAt,
          reason: '自动清理保存失败，原记录与此前已确认保存的名单已保留。请检查浏览器存储空间后重新收集。' };
        // The baseline is no longer actionable and can be large. Releasing it
        // lets a quota-related failure still persist a small, truthful status.
        delete failed.baseline;
        try {
          await chrome.storage.local.set({ reviewData: data, followingScan: failed, [UNDO_KEY]: priorUndo });
        } catch {
          // Even if all storage is unavailable, never replay or report a success
          // in this worker. Public status and scan replies expose the failure.
          terminalFailures.set(scan.runId, failed);
        }
        return failed;
      }
    }

    async function handle(message, sender) {
      if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) throw Error('请从扩展工作台查看名单同步结果。');
      return enqueue(async () => {
        if (message.type === 'SYNC_APPLY') throw Error('手动勾选清理已取消；新一轮关注名单自然收集结束后会自动同步。');
        const data = await load(), scan = await getScan(), undo = await getUndo();
        const before = report(data, scan, undo);
        if (message.type === 'SYNC_STATUS') return before;
        if (message.type === 'SYNC_UNDO') {
          if (!Array.isArray(undo?.records) || !undo.records.length) return { restored: 0, preview: before };
          let restored = 0;
          const now = new Date().toISOString();
          for (const record of undo.records) {
            if (data.records.some(current => sharesIdentity(current, record))) continue;
            data.records.push({ ...record, updatedAt: now });
            restored++;
          }
          const changes = { reviewData: data, [UNDO_KEY]: null };
          let reportScan = scan;
          if (scan?.runId === undo.runId && scan.syncResult?.status === 'applied') {
            reportScan = { ...scan, syncResult: { ...scan.syncResult, undone: true, restored, undoneAt: now },
              reason: `本轮自动同步已撤销，恢复 ${restored} 条本地记录，未覆盖已有的新记录。`, updatedAt: now };
            changes.followingScan = reportScan;
          }
          await chrome.storage.local.set(changes);
          return { restored, preview: report(data, reportScan, null) };
        }
        throw Error('未知的关注名单同步操作。');
      });
    }

    async function clearForReset() {
      await chrome.storage.local.set({ [UNDO_KEY]: null });
      terminalFailures.clear();
    }
    return { handle, baseline, finish, clearForReset, failedScan: runId => terminalFailures.get(runId) || null };
  }

  root.createFollowingSyncService = createFollowingSyncService;
  if (typeof module === 'object' && module.exports) module.exports = { createFollowingSyncService };
})(globalThis);
