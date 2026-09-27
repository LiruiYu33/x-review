/* Serial, user-started visits to public X profile pages. The controller requests
 * one account at a time. Network waits never hold the shared data-write queue.
 * No private endpoints, cookies, account controls or background fetches are used.
 */
(function (root) {
  'use strict';

  root.createActivityService = function createActivityService(options) {
    const { core, enqueue, load, getFollowingScan, reconcileFollowingScan } = options;
    const INTERVAL_MS = 1500;
    const MIN_OBSERVATION_MS = 5000;
    const MAX_OBSERVATION_MS = 25000;
    const ORIGINS = ['https://x.com/*'];
    const waiting = new Map();
    let nextOperation = null;

    const active = run => run && run.phase === 'running';
    const nowISO = () => new Date().toISOString();
    const getRun = async () => (await chrome.storage.local.get('activityRun')).activityRun || null;
    const extensionSender = sender => sender?.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
    const controllerURL = url => typeof url === 'string' && url.split(/[?#]/, 1)[0] === chrome.runtime.getURL('activity.html');
    const labelFor = record => record.handle ? '@' + record.handle : 'ID ' + record.id;

    function wake(runId) {
      const sleepers = waiting.get(runId);
      if (!sleepers) return;
      waiting.delete(runId);
      for (const finish of sleepers) finish();
    }

    function pause(runId, milliseconds) {
      return new Promise(resolve => {
        let timer;
        const finish = () => {
          clearTimeout(timer);
          const sleepers = waiting.get(runId);
          if (sleepers) {
            sleepers.delete(finish);
            if (!sleepers.size) waiting.delete(runId);
          }
          resolve();
        };
        if (!waiting.has(runId)) waiting.set(runId, new Set());
        waiting.get(runId).add(finish);
        timer = setTimeout(finish, milliseconds);
      });
    }

    async function stop(runId, reason) {
      const run = await enqueue(async () => {
        const latest = await getRun();
        if (!latest || (runId && latest.runId !== runId) || !active(latest)) return latest;
        Object.assign(latest, { phase: 'stopped', reason, updatedAt: nowISO() });
        await chrome.storage.local.set({ activityRun: latest });
        return latest;
      });
      if (runId) wake(runId);
      else if (run) wake(run.runId);
      return run;
    }

    async function hasPermission() {
      return chrome.permissions.contains({ origins: ORIGINS });
    }

    async function current(runId) {
      const run = await getRun();
      return active(run) && run.runId === runId ? run : null;
    }

    // Validate both tabs and permission after every asynchronous page wait.
    async function guard(runId) {
      const run = await current(runId);
      if (!run) return null;
      if (!await hasPermission()) {
        await stop(runId, 'X 页面读取权限已撤销，检查已停止。已保存的观察仍然保留。');
        return null;
      }
      try {
        await chrome.tabs.get(run.controllerTabId);
        // tabs.get() can omit even our own page's URL without the broad tabs
        // permission. runtime.getContexts() (Chrome 116+) identifies only this
        // extension's documents and does not require access to browsing history.
        if (typeof chrome.runtime.getContexts !== 'function') {
          await stop(runId, '此浏览器版本不支持控制页面验证；请使用 Chrome / Edge 116 或更新版本。');
          return null;
        }
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['TAB'], tabIds: [run.controllerTabId]
        });
        if (!contexts.some(context => context.tabId === run.controllerTabId && controllerURL(context.documentUrl))) {
          await stop(runId, '检查控制页面已关闭或跳转，任务已停止。');
          return null;
        }
        if (Number.isInteger(run.scanTabId)) await chrome.tabs.get(run.scanTabId);
      } catch {
        await stop(runId, '检查页面已关闭，任务已停止。已保存的观察仍然保留。');
        return null;
      }
      return current(runId);
    }

    function profileRoute(raw) {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.hostname !== 'x.com' || url.port || url.username || url.password) return null;
        const id = url.pathname.match(/^\/i\/user\/(\d{1,30})\/?$/);
        if (id) return { id: id[1], url: url.href };
        const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
        if (!match) return null;
        const record = core.normaliseRecord({ handle: match[1] });
        return { handle: record.handle, url: url.href };
      } catch { return null; }
    }

    async function begin(message, sender) {
      if (!Number.isInteger(sender.tab?.id) || !controllerURL(sender.url)) throw Error('请从检查控制页面开始任务。');
      if (!['missing', 'all'].includes(message.mode)) throw Error('请选择检查缺失数据或全部待审账户。');
      if (!Number.isInteger(message.limit) || message.limit < 1 || message.limit > 5000) throw Error('每轮检查数量须为 1–5,000。');
      if (!await hasPermission()) throw Error('请先允许扩展读取 https://x.com 的页面。');
      const following = await getFollowingScan();
      if (following && ['running', 'paused'].includes(following.phase)) await reconcileFollowingScan(following);
      let run = await enqueue(async () => {
        const previous = await getRun();
        if (active(previous)) throw Error('已有账户检查任务正在运行，请先停止该任务。');
        const scan = await getFollowingScan();
        if (scan && ['running', 'paused'].includes(scan.phase)) throw Error('请先停止关注名单收集，再开始逐个账户检查。');
        const data = await load();
        const records = data.records.filter(record => record.status === 'pending' &&
          (message.mode === 'all' || ['unknown', 'stale'].includes(core.classify(record, data.thresholdDays).bucket)))
          .slice(0, message.limit);
        const now = nowISO();
        const state = {
          runId: crypto.randomUUID(), phase: records.length ? 'running' : 'complete',
          controllerTabId: sender.tab.id, scanTabId: null, queue: records.map(record => record.key),
          mode: message.mode, index: 0, completed: 0, read: 0, unknown: 0, skipped: 0, inferredAssociations: 0,
          currentKey: null, currentLabel: '', total: records.length, association: '',
          reason: records.length ? '正在准备专用 X 检查标签页…' : '没有符合条件的待审账户。',
          startedAt: now, updatedAt: now
        };
        await chrome.storage.local.set({ activityRun: state });
        return state;
      });
      if (!active(run)) return run;
      try {
        if (!await guard(run.runId)) return getRun();
        // Only this initial tab creation requests focus. Later visits reuse it.
        const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        if (!Number.isInteger(tab.id)) throw Error('无法创建检查标签页。');
        run = await enqueue(async () => {
          const latest = await current(run.runId);
          if (!latest) return getRun();
          Object.assign(latest, { scanTabId: tab.id, reason: '准备就绪；将逐个打开公开主页并保存观察。', updatedAt: nowISO() });
          await chrome.storage.local.set({ activityRun: latest });
          return latest;
        });
        return run;
      } catch (error) {
        await stop(run.runId, '未能准备检查页面：' + error.message);
        throw error;
      }
    }

    function complete(run) {
      Object.assign(run, { phase: 'complete', currentKey: null, currentLabel: '', updatedAt: nowISO(),
        reason: `本轮检查已完成：${run.read} 个账户获得可用观察，${run.unknown} 个仍为未知${run.skipped ? `，另跳过 ${run.skipped} 个已处理或已删除账户` : ''}。${run.inferredAssociations ? `其中 ${run.inferredAssociations} 个数字 ID 账户按同标签页跳转关联观察，该关联属于导航推断。` : ''}请回到工作台复核候选。` });
    }

    async function select(runId) {
      return enqueue(async () => {
        const run = await current(runId);
        if (!run) return null;
        const data = await load();
        while (run.index < run.queue.length) {
          const record = data.records.find(item => item.key === run.queue[run.index]);
          if (record && record.status === 'pending') {
            Object.assign(run, { currentKey: record.key, currentLabel: labelFor(record), association: '',
              reason: '正在打开 ' + labelFor(record) + ' 的公开主页…', updatedAt: nowISO() });
            await chrome.storage.local.set({ activityRun: run });
            return { run, record };
          }
          run.index++;
          run.skipped++;
        }
        complete(run);
        await chrome.storage.local.set({ activityRun: run });
        return null;
      });
    }

    function unknownEvidence(reason) {
      return { observedAt: nowISO(), latestPostAt: null, sampleCount: 0, scope: 'profile-posts', profileAtTop: false,
        hasUncertainReposts: true, note: String(reason || '没有可确认的公开发帖证据。').slice(0, 300) };
    }

    function signature(snapshot) {
      const record = snapshot.record || {}, evidence = record.evidence || {};
      return JSON.stringify([record.handle?.toLowerCase(), record.id || '', evidence.latestPostAt || '',
        evidence.sampleCount || 0, evidence.profileAtTop === true, evidence.hasUncertainReposts !== false]);
    }

    async function observe(run, requested) {
      const targetURL = core.profileUrl(requested);
      if (!targetURL || !profileRoute(targetURL)) throw Error('该账户的 X 主页链接无效。');
      if (!await guard(run.runId)) return null;
      await chrome.tabs.update(run.scanTabId, { url: targetURL });
      if (!await guard(run.runId)) return null;
      const navigatedAt = Date.now();
      let acceptedHandle = '', previousSignature = '', matchingSince = 0, lastReason = '';
      while (Date.now() - navigatedAt <= MAX_OBSERVATION_MS) {
        if (!await guard(run.runId)) return null;
        const tab = await chrome.tabs.get(run.scanTabId);
        const navigatingURL = tab.pendingUrl || tab.url;
        const route = profileRoute(navigatingURL);
        if (!route) {
          await stop(run.runId, '检查标签页已离开 X 账户主页，或需要登录/验证；任务已停止，请自行查看页面。');
          return null;
        }
        if (route.id && (!requested.id || route.id !== requested.id)) {
          await stop(run.runId, '检查页面的账户 ID 已改变；任务已停止，未保存此次观察。');
          return null;
        }
        if (tab.status === 'complete' && route.handle) {
          const handle = route.handle.toLowerCase();
          if ((!requested.id && handle !== requested.handle?.toLowerCase()) || (acceptedHandle && acceptedHandle !== handle)) {
            await stop(run.runId, '检查期间账户主页已改变；任务已停止，未把其他账户的数据写入当前记录。');
            return null;
          }
          acceptedHandle = handle;
          try {
            await chrome.scripting.executeScript({ target: { tabId: run.scanTabId }, files: ['reader.js', 'profile-probe.js'] });
            if (!await guard(run.runId)) return null;
            const [result] = await chrome.scripting.executeScript({ target: { tabId: run.scanTabId }, func: () => globalThis.XReviewProfileProbe() });
            if (!await guard(run.runId)) return null;
            const probe = result?.result;
            if (probe?.state === 'blocked') {
              await stop(run.runId, probe.reason || 'X 显示登录、验证或访问限制；本轮检查已停止。');
              return null;
            }
            lastReason = typeof probe?.reason === 'string' ? probe.reason.slice(0, 300) : '页面尚未提供可用观察。';
            const captured = probe?.snapshot?.record;
            if (captured) {
              const snapshotHandle = typeof captured.handle === 'string' ? captured.handle.toLowerCase() : '';
              if (!snapshotHandle || snapshotHandle !== acceptedHandle || (!requested.id && snapshotHandle !== requested.handle.toLowerCase()) ||
                  (requested.id && captured.id && String(captured.id) !== requested.id)) {
                await stop(run.runId, '主页显示的账户身份与本次目标不一致；任务已停止，未保存此次观察。');
                return null;
              }
              // Probe and tab are read separately; recheck for manual navigation.
              const latestTab = await chrome.tabs.get(run.scanTabId);
              const latestRoute = profileRoute(latestTab.pendingUrl || latestTab.url);
              if (!latestRoute?.handle || latestRoute.handle.toLowerCase() !== acceptedHandle) {
                await stop(run.runId, '读取时主页地址发生变化；任务已停止，未保存此次观察。');
                return null;
              }
            }
            if (probe?.state === 'ready' && probe.snapshot?.kind === 'profile' && captured) {
              const nextSignature = signature(probe.snapshot);
              if (nextSignature !== previousSignature) { previousSignature = nextSignature; matchingSince = Date.now(); }
              else if (Date.now() - matchingSince >= INTERVAL_MS && Date.now() - navigatedAt >= MIN_OBSERVATION_MS) {
                return { snapshot: probe.snapshot, reason: lastReason, finalHandle: acceptedHandle,
                  association: requested.id && String(captured.id || '') !== requested.id ? 'stable-id-redirect' : '' };
              }
            } else {
              previousSignature = ''; matchingSince = 0;
              if (probe?.state === 'unavailable' && Date.now() - navigatedAt >= MIN_OBSERVATION_MS) {
                return { snapshot: null, reason: lastReason || '此主页没有可确认的公开发帖证据。', finalHandle: acceptedHandle, association: '' };
              }
            }
          } catch (error) {
            if (!await guard(run.runId)) return null;
            lastReason = '页面正在切换或无法读取：' + String(error.message || error).slice(0, 160);
            previousSignature = ''; matchingSince = 0;
          }
        }
        const remaining = MAX_OBSERVATION_MS - (Date.now() - navigatedAt);
        if (remaining <= 0) break;
        await pause(run.runId, Math.min(INTERVAL_MS, remaining));
      }
      if (!await guard(run.runId)) return null;
      return { snapshot: null, reason: '等待 25 秒后仍无稳定可用的公开帖子。' + (lastReason ? ' ' + lastReason : ''), finalHandle: acceptedHandle, association: '' };
    }

    async function commit(runId, requested, observation) {
      if (!await guard(runId)) return getRun();
      return enqueue(async () => {
        const run = await current(runId);
        if (!run || run.currentKey !== requested.key || run.queue[run.index] !== requested.key) return getRun();
        if (!await hasPermission()) {
          Object.assign(run, { phase: 'stopped', reason: 'X 页面读取权限已撤销，检查已停止。', updatedAt: nowISO() });
          await chrome.storage.local.set({ activityRun: run });
          wake(runId);
          return run;
        }
        const finalTab = await chrome.tabs.get(run.scanTabId);
        const finalRoute = profileRoute(finalTab.pendingUrl || finalTab.url);
        const sameIdentity = finalRoute && (finalRoute.id
          ? requested.id === finalRoute.id && !observation.finalHandle
          : (!requested.id ? finalRoute.handle.toLowerCase() === requested.handle.toLowerCase() : true) &&
            (!observation.finalHandle || finalRoute.handle.toLowerCase() === observation.finalHandle));
        if (!sameIdentity) {
          Object.assign(run, { phase: 'stopped', reason: '保存前检查页面已跳转到其他账户或离开 X；已停止，未保存此次观察。', updatedAt: nowISO() });
          await chrome.storage.local.set({ activityRun: run });
          wake(runId);
          return run;
        }
        const data = await load();
        const fresh = data.records.find(record => record.key === requested.key);
        if (!fresh || fresh.status !== 'pending') {
          run.index++; run.skipped++;
          run.reason = '当前账户已处理或删除，已跳过。';
        } else {
          const captured = observation.snapshot?.record;
          const provenID = fresh.id && String(captured?.id || '') === fresh.id;
          // An ID URL's redirect is a same-tab navigation association, not proof
          // obtained from an API. Do not overwrite a stored handle on that basis.
          const handle = fresh.id && !provenID ? fresh.handle : captured?.handle || fresh.handle;
          const incoming = core.normaliseRecord({ ...fresh, profileUrl: undefined, handle,
            name: fresh.id && !provenID ? fresh.name : captured?.name || fresh.name,
            source: observation.association ? 'auto-profile-id-redirect' : 'auto-profile',
            evidence: captured?.evidence ? { ...captured.evidence, scope: 'profile-posts' } : unknownEvidence(observation.reason), updatedAt: nowISO() });
          data.records = core.mergeRecords(data.records, [incoming]);
          const saved = data.records.find(record => record.key === fresh.key);
          const bucket = saved ? core.classify(saved, data.thresholdDays).bucket : 'unknown';
          if (['candidate', 'recent'].includes(bucket)) run.read++;
          else run.unknown++;
          run.completed++; run.index++;
          run.association = observation.association || '';
          if (observation.association) run.inferredAssociations = (run.inferredAssociations || 0) + 1;
          run.reason = observation.association
            ? '已按本轮数字 ID 链接的同标签页跳转关联观察；该关联属于导航推断，未改写既有用户名。'
            : observation.reason || '本次公开主页观察已保存。';
        }
        run.currentKey = null; run.currentLabel = ''; run.updatedAt = nowISO();
        if (run.index >= run.queue.length) complete(run);
        await chrome.storage.local.set({ reviewData: data, activityRun: run });
        return run;
      });
    }

    async function next(message, sender) {
      const run = await getRun();
      if (!run || run.runId !== message.runId || sender.tab?.id !== run.controllerTabId || !controllerURL(sender.url)) throw Error('账户检查会话已失效，请返回原控制页面。');
      if (!active(run)) return run;
      if (!Number.isInteger(run.scanTabId)) throw Error('检查标签页尚未准备完成。');
      if (nextOperation?.runId === run.runId) return nextOperation.promise;
      const operation = { runId: run.runId, promise: null };
      nextOperation = operation;
      operation.promise = (async () => {
        try {
          if (!await guard(run.runId)) return getRun();
          const selected = await select(run.runId);
          if (!selected) return getRun();
          const observation = await observe(selected.run, selected.record);
          if (!observation) return getRun();
          return await commit(run.runId, selected.record, observation);
        } catch (error) {
          await stop(run.runId, '检查已停止：' + String(error.message || error).slice(0, 250));
          return getRun();
        } finally {
          if (nextOperation === operation) nextOperation = null;
        }
      })();
      return operation.promise;
    }

    async function handle(message, sender) {
      if (!extensionSender(sender)) throw Error('账户检查只能从扩展页面控制。');
      switch (message.type) {
        case 'ACT_BEGIN': return begin(message, sender);
        case 'ACT_NEXT': return next(message, sender);
        case 'ACT_STATUS': {
          const run = await getRun();
          if (active(run)) await guard(run.runId);
          return getRun();
        }
        case 'ACT_STOP': return stop(message.runId || null, '你已停止账户检查，已保存的观察仍然保留。');
        default: throw Error('未知的账户检查操作。');
      }
    }

    async function tabRemoved(tabId) {
      const run = await getRun();
      if (active(run) && [run.controllerTabId, run.scanTabId].includes(tabId)) await stop(run.runId, '控制页面或检查标签页已关闭，任务已停止。');
    }

    async function startup() {
      const run = await getRun();
      if (active(run)) await stop(run.runId, '浏览器已重启，请重新开始账户检查。');
    }

    // Called by the parent from inside enqueue: never enqueue again here.
    async function cancelForClear() {
      const run = await getRun();
      if (active(run)) {
        Object.assign(run, { phase: 'stopped', reason: '本地名单已清空，账户检查同时停止。', updatedAt: nowISO() });
        await chrome.storage.local.set({ activityRun: run });
        wake(run.runId);
      }
      return run;
    }

    return { handle, tabRemoved, startup, cancelForClear };
  };
})(globalThis);
