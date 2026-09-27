/* A user opens one native X window and performs the account action themselves.
 * Only verified page observations can remove its unchanged local record.
 * Never hold the shared write queue while injecting a watcher that sends messages.
 */
(function (root) {
  'use strict';
  root.createManualUnfollowService = function ({core, enqueue, load}) {
    const KEY = 'manualUnfollow', UNDO = 'manualUnfollowUndo';
    const MAX_MS = 10 * 60 * 1000;
    const attaching = new Set();
    const active = run => run && ['opening', 'watching', 'armed'].includes(run.phase);
    const fresh = run => active(run) && Date.now() < Date.parse(run.expiresAt);
    const get = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
    const getUndo = async () => (await chrome.storage.local.get(UNDO))[UNDO] || null;
    const now = () => new Date().toISOString();
    const fingerprint = record => JSON.stringify(core.normaliseRecord(record, 0));
    const sameHandle = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
    const sharesIdentity = (a, b) => a.key === b.key || (a.id && a.id === b.id) || (a.handle && sameHandle(a.handle, b.handle));
    const permission = () => chrome.permissions.contains({origins: ['https://x.com/*']});
    const publicRun = run => run ? Object.fromEntries(['runId','key','phase','reason','handle','id','viewer','tabId','windowId','createdAt','updatedAt','expiresAt'].filter(key => key in run).map(key => [key, run[key]])) : null;
    function route(raw) {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.hostname !== 'x.com' || url.port || url.username || url.password) return null;
        const handle = url.pathname.match(/^\/([a-z0-9_]{1,15})\/?$/i);
        if (handle) return {handle: core.normaliseRecord({handle: handle[1]}).handle};
        const id = url.pathname.match(/^\/i\/user\/(\d{1,30})\/?$/);
        return id ? {id: id[1]} : null;
      } catch { return null; }
    }
    function validIdentity(message) {
      return /^[a-z0-9_]{1,15}$/i.test(String(message.handle || '')) && /^\d{1,30}$/.test(String(message.id || '')) && /^[a-z0-9_]{1,15}$/i.test(String(message.viewer || ''));
    }
    function matchesTarget(run, seen) {
      return (!run.targetHandle || sameHandle(run.targetHandle, seen.handle)) && (!run.targetId || run.targetId === seen.id);
    }
    function outcome(run, phase, reason) { return {...run, phase, reason, updatedAt: now()}; }
    async function cancel(runId, reason = '已停止观察取关窗口，本地记录已保留。') {
      return enqueue(async () => {
        const run = await get();
        if (!active(run) || (runId && run.runId !== runId)) return publicRun(run);
        const stopped = outcome(run, 'cancelled', reason);
        await chrome.storage.local.set({[KEY]: stopped});
        return publicRun(stopped);
      });
    }
    async function reconcile() {
      const run = await get();
      if (!active(run)) return run;
      if (!fresh(run)) { await cancel(run.runId, '取关观察已超过 10 分钟，本地记录已保留。请重新打开取关窗口。'); return get(); }
      if (!await permission()) { await cancel(run.runId, 'X 页面读取权限已撤销，本地记录已保留。'); return get(); }
      if (Number.isInteger(run.tabId)) {
        try { await chrome.tabs.get(run.tabId); }
        catch { await cancel(run.runId, '取关窗口已关闭；没有确认取关，本地记录已保留。'); return get(); }
      }
      return run;
    }
    async function busy() { return fresh(await get()); }
    async function status() {
      const run = await reconcile(), undo = await getUndo(), data = await load();
      return {session: publicRun(run), canUndo: Boolean(undo?.record && !data.records.some(record => sharesIdentity(record, undo.record)))};
    }
    async function begin(message) {
      if (!await permission()) throw Error('请允许读取 X 页面，以确认你手动完成的取关操作。');
      await reconcile();
      let reuse = false;
      const run = await enqueue(async () => {
        const previous = await get();
        if (fresh(previous)) {
          if (previous.key !== message.key) throw Error('请先完成或关闭当前取关窗口。');
          reuse = true; return previous;
        }
        const scan = (await chrome.storage.local.get('followingScan')).followingScan;
        const activity = (await chrome.storage.local.get('activityRun')).activityRun;
        if (scan && ['running', 'paused'].includes(scan.phase)) throw Error('请先停止关注名单收集，再打开取关窗口。');
        if (activity?.phase === 'running') throw Error('请先停止发帖时间检查，再打开取关窗口。');
        const data = await load(), record = data.records.find(record => record.key === message.key);
        if (!record) throw Error('找不到这条记录');
        const session = {runId: crypto.randomUUID(), key: record.key, phase: 'opening',
          targetHandle: record.handle || '', targetId: record.id || '', handle: record.handle || '', id: record.id || '',
          fingerprint: fingerprint(record), createdAt: now(), updatedAt: now(), expiresAt: new Date(Date.now() + MAX_MS).toISOString(),
          reason: '正在打开 X 取关窗口，请在原生页面手动操作。'};
        await chrome.storage.local.set({[KEY]: session});
        return session;
      });
      if (reuse) {
        if (Number.isInteger(run.windowId)) await chrome.windows.update(run.windowId, {focused: true});
        return publicRun(run);
      }
      try {
        const window = await chrome.windows.create({url: core.profileUrl({handle: run.targetHandle || undefined, id: run.targetId || undefined}), type: 'popup', width: 800, height: 900, focused: true});
        const tabs = window.tabs || await chrome.tabs.query({windowId: window.id});
        const tab = tabs.find(tab => Number.isInteger(tab.id));
        if (!tab) throw Error('无法创建 X 取关窗口。');
        await enqueue(async () => {
          const latest = await get();
          if (!fresh(latest) || latest.runId !== run.runId) return;
          await chrome.storage.local.set({[KEY]: {...latest, tabId: tab.id, windowId: window.id, phase: 'watching', updatedAt: now(), reason: '请在新窗口手动取消关注；确认状态变化后，本地记录会自动移除。'}});
        });
        const currentTab = await chrome.tabs.get(tab.id);
        if (currentTab.status === 'complete') await attach(tab.id);
        return publicRun(await get());
      } catch (error) {
        await cancel(run.runId, '取关窗口未能准备完成，本地记录已保留：' + error.message);
        throw error;
      }
    }
    async function attach(tabId) {
      const run = await get();
      if (!fresh(run) || run.tabId !== tabId || attaching.has(run.runId)) return;
      attaching.add(run.runId);
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.pendingUrl || tab.status !== 'complete') return;
        const destination = route(tab.url);
        if (!destination) { await cancel(run.runId, '已离开目标 X 主页，本地记录已保留。'); return; }
        if (destination.id) {
          if (destination.id !== run.targetId) await cancel(run.runId, '主页身份与目标账户不一致，本地记录已保留。');
          return; // Wait for the native numeric-ID redirect to finish.
        }
        if (run.targetHandle && !sameHandle(run.targetHandle, destination.handle)) {
          await cancel(run.runId, '主页身份与目标账户不一致，本地记录已保留。'); return;
        }
        await chrome.scripting.executeScript({target: {tabId}, files: ['i18n.js', 'messages-unfollow-service.js', 'messages-unfollow-watcher.js', 'unfollow-watcher.js']});
        await chrome.scripting.executeScript({target: {tabId}, func: options => globalThis.XReviewUnfollowWatcher.start(options), args: [{runId: run.runId, handle: run.targetHandle, id: run.targetId}]});
      } catch (error) { await cancel(run.runId, '无法观察取关窗口，本地记录已保留：' + error.message); }
      finally { attaching.delete(run.runId); }
    }
    async function watchStopped(message, sender) {
      const run = await get();
      if (!run || run.runId !== message.runId || sender.id !== chrome.runtime.id || sender.tab?.id !== run.tabId || sender.frameId !== 0 || typeof sender.documentId !== 'string' || (run.documentId && run.documentId !== sender.documentId)) throw Error('取关观察会话已失效。');
      return cancel(run.runId, typeof message.reason === 'string' ? message.reason.slice(0, 500) : '未能确认取关，本地记录已保留。');
    }
    async function observed(message, sender) {
      const initial = await get();
      if (!initial || initial.runId !== message.runId || sender.id !== chrome.runtime.id || sender.tab?.id !== initial.tabId || sender.frameId !== 0 || typeof sender.documentId !== 'string') throw Error('取关观察会话已失效。');
      if (!fresh(initial)) return publicRun(initial);
      if (!['following', 'confirmed'].includes(message.phase) || !validIdentity(message)) throw Error('取关页面证据无效，本地记录已保留。');
      const page = route(sender.url);
      if (!page?.handle || !sameHandle(page.handle, message.handle) || !matchesTarget(initial, message)) throw Error('主页身份与目标账户不一致，本地记录已保留。');
      if (!await permission()) throw Error('X 页面读取权限已撤销，本地记录已保留。');
      // The synchronous probe never sends a message and is safe to run again
      // within the write queue, immediately before committing an observation.
      async function verifyCurrent() {
        const tab = await chrome.tabs.get(initial.tabId), currentRoute = route(tab.url);
        if (tab.pendingUrl || tab.status === 'loading' || !currentRoute?.handle || !sameHandle(currentRoute.handle, message.handle) || !await permission()) throw Error('取关页面已改变，本地记录已保留。');
        const [probe] = await chrome.scripting.executeScript({target: {tabId: initial.tabId, documentIds: [sender.documentId]}, func: () => globalThis.XReviewUnfollowWatcher?.verify() || null});
        const proof = probe?.result;
        if (probe?.documentId !== sender.documentId || !proof || proof.runId !== initial.runId || proof.id !== message.id || !sameHandle(proof.handle, message.handle) || !sameHandle(proof.viewer, message.viewer) || proof.state !== (message.phase === 'following' ? 'following' : 'follow')) throw Error('无法再次确认取关页面状态，本地记录已保留。');
        if (message.phase === 'confirmed' && (proof.trustedAction !== true || !Number.isFinite(proof.stableFor) || proof.stableFor < 2000)) throw Error('尚未确认手动取关后的稳定状态，本地记录已保留。');
      }
      await verifyCurrent();
      return enqueue(async () => {
        const run = await get();
        if (!run || run.runId !== initial.runId) throw Error('取关观察会话已失效。');
        if (!fresh(run)) return publicRun(run);
        const tab = await chrome.tabs.get(run.tabId), currentRoute = route(tab.url);
        if (!currentRoute?.handle || !sameHandle(currentRoute.handle, message.handle) || !await permission()) throw Error('取关页面已改变，本地记录已保留。');
        const bound = run.phase === 'armed';
        if (bound && (run.documentId !== sender.documentId || run.id !== message.id || !sameHandle(run.handle, message.handle) || !sameHandle(run.viewer, message.viewer))) throw Error('取关期间账号或页面身份已改变，本地记录已保留。');
        if (message.phase === 'confirmed' && !bound) throw Error('尚未记录到正在关注状态，本地记录已保留。');
        const data = await load(), record = data.records.find(record => record.key === run.key);
        const identity = {handle: message.handle, id: message.id, viewer: message.viewer};
        let retention = '';
        if (!record || fingerprint(record) !== run.fingerprint) retention = '本地记录已被修改或移除，未覆盖你的后续操作。';
        else if ((record.followingOwners || []).some(owner => !sameHandle(owner, message.viewer))) retention = '这条记录属于其他或多个关注名单，已保留本地记录。';
        else if (data.records.some(other => other.key !== record.key && sameHandle(other.handle, message.handle) && other.id && other.id !== message.id)) retention = '本地存在同名但 ID 不同的账户，已保留记录供你核实。';
        if (retention) {
          const retained = {...outcome(run, 'retained', retention), ...identity};
          await chrome.storage.local.set({[KEY]: retained}); return publicRun(retained);
        }
        if (message.phase === 'following') {
          const armed = {...outcome(run, 'armed', '已确认正在关注此账号；请在 X 原生页面手动取消关注。'), ...identity, documentId: sender.documentId};
          await verifyCurrent();
          await chrome.storage.local.set({[KEY]: armed}); return publicRun(armed);
        }
        const removed = {...outcome(run, 'removed', '已确认手动取关，并移除对应本地记录。无需重新扫描关注名单。'), ...identity};
        const changes = {[KEY]: removed, reviewData: {...data, records: data.records.filter(item => item.key !== run.key)},
          [UNDO]: {runId: run.runId, record, viewer: message.viewer, removedAt: now()}};
        const syncUndo = (await chrome.storage.local.get('followingSyncUndo')).followingSyncUndo;
        if (Array.isArray(syncUndo?.records)) changes.followingSyncUndo = {...syncUndo, records: syncUndo.records.filter(item => !sharesIdentity(item, record))};
        await verifyCurrent();
        try { await chrome.storage.local.set(changes); }
        catch (error) {
          // One storage transaction carries both removal and undo. Failed writes
          // must never be acknowledged as a completed unfollow cleanup.
          const failed = {...outcome(run, 'failed', '本地移除保存失败，记录未被确认删除。请检查浏览器存储后重试。'), ...identity};
          try { await chrome.storage.local.set({[KEY]: failed}); } catch { /* Preserve the previous persisted state. */ }
          return publicRun(failed);
        }
        return publicRun(removed);
      });
    }
    async function undo() {
      return enqueue(async () => {
        const saved = await getUndo(), run = await get(), data = await load();
        if (!saved?.record) return {restored: 0, session: publicRun(run)};
        const existing = data.records.some(record => sharesIdentity(record, saved.record));
        const changes = {[UNDO]: null};
        if (!existing) changes.reviewData = {...data, records: [...data.records, {...saved.record, updatedAt: now()}]};
        let session = run;
        if (run?.runId === saved.runId && run.phase === 'removed') {
          session = outcome(run, 'retained', existing ? '本地已有该账号的新记录，未覆盖。撤销不会重新关注 X 账号。' : '已恢复本地记录；这不会重新关注 X 账号。');
          changes[KEY] = session;
        }
        await chrome.storage.local.set(changes);
        return {restored: existing ? 0 : 1, session: publicRun(session)};
      });
    }
    async function tabUpdated(tabId, change, tab) {
      const run = await get();
      if (!active(run) || run.tabId !== tabId) return;
      if (run.phase === 'armed' && (change.url || change.status === 'loading')) {
        await cancel(run.runId, '取关页面已刷新或跳转，本地记录已保留。请重新打开取关窗口。'); return;
      }
      if (change.url) {
        const next = route(change.url);
        if (!next || (next.id && next.id !== run.targetId) || (next.handle && run.targetHandle && !sameHandle(next.handle, run.targetHandle))) {
          await cancel(run.runId, '已离开目标 X 主页，本地记录已保留。'); return;
        }
      }
      if (change.status === 'complete') await attach(tabId);
    }
    async function handle(message) {
      switch (message.type) {
        case 'UNFOLLOW_BEGIN': return begin(message);
        case 'UNFOLLOW_STATUS': return status();
        case 'UNFOLLOW_CANCEL': return cancel(message.runId);
        case 'UNFOLLOW_UNDO': return undo();
        default: throw Error('未知的手动取关操作。');
      }
    }
    return {handle, observed, watchStopped, busy, tabUpdated,
      tabRemoved: async tabId => {const run = await get(); if (run?.tabId === tabId) await cancel(run.runId, '取关窗口已关闭；没有确认取关，本地记录已保留。');},
      startup: () => cancel(null, '浏览器已重启，本地记录已保留。请重新打开取关窗口。'),
      cancelForClear: async () => {const run = await get(); await chrome.storage.local.set({[KEY]: run ? {runId: run.runId, phase: 'cancelled', reason: '本地名单已清空，取关观察同时停止。', updatedAt: now()} : null, [UNDO]: null});}
    };
  };
})(globalThis);
