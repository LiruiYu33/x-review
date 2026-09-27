/* All writes pass through one queue to avoid overwriting concurrent captures. */
importScripts('core.js');
importScripts('activity-service.js');
importScripts('following-sync.js');
const core = globalThis.XReviewCore;
const empty = () => ({schemaVersion: 1, records: [], thresholdDays: 180});
let queue = Promise.resolve();
const enqueue = task => {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
};
const activeScan = scan => scan && ['running', 'paused'].includes(scan.phase);
function publicScan(scan) {
  if (!scan) return null;
  const fields = ['runId', 'tabId', 'owner', 'phase', 'collected', 'added', 'steps', 'startedAt', 'updatedAt', 'reason', 'stopCode', 'startedFromTop', 'autoSync', 'syncResult'];
  return Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(scan, key)).map(key => [key, scan[key]]));
}
function followingOwner(raw) {
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/);
    return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) && !url.port && match ? match[1] : null;
  } catch { return null; }
}
async function getScan() { return (await chrome.storage.local.get('followingScan')).followingScan || null; }
async function stopStored(runId, reason, stopCode = 'interrupted') {
  return enqueue(async () => {
    const scan = await getScan();
    if (!scan || scan.runId !== runId || !activeScan(scan)) return scan;
    Object.assign(scan, {phase: 'stopped', stopCode, reason, updatedAt: new Date().toISOString()});
    await chrome.storage.local.set({followingScan: scan});
    return scan;
  });
}
async function reconcileScan(scan) {
  if (!activeScan(scan)) return scan;
  try {
    const [result] = await chrome.scripting.executeScript({target: {tabId: scan.tabId}, func: () => globalThis.XReviewAutoCollector?.state() || null});
    const live = result?.result;
    if (!live && Date.now() - Date.parse(scan.startedAt) <= 10000) return scan;
    if (!live || live.runId !== scan.runId || !['running', 'paused'].includes(live.phase)) return stopStored(scan.runId, live?.reason || '原采集页面已刷新或会话已结束。');
    return scan;
  } catch { return stopStored(scan.runId, '原页面已关闭、跳转或读取权限失效。'); }
}
// A control call must not hold the data-write queue while awaiting an injected
// collector: the collector itself sends batches through that queue.
async function scanControl(message) {
  if (!Number.isInteger(message.tabId)) throw Error('请先打开自己的正在关注页面');
  let scan = await getScan();
  if (message.type === 'SCAN_STATUS') {
    if (!scan || scan.tabId !== message.tabId) return null;
    if (followingSync.failedScan(scan.runId)) return followingSync.failedScan(scan.runId);
    return reconcileScan(scan);
  }
  if (message.type === 'SCAN_STOP') {
    if (!scan || scan.tabId !== message.tabId) return null;
    const stopped = await stopStored(scan.runId, '你已停止采集，已保存的账户会保留。', 'manual');
    try { await chrome.scripting.executeScript({target: {tabId: scan.tabId}, func: runId => globalThis.XReviewAutoCollector?.stop('你已停止采集，已保存的账户会保留。', runId), args: [scan.runId]}); } catch { /* The page may already be closed. */ }
    return stopped;
  }
  if (message.type !== 'SCAN_BEGIN' || message.ownerConfirmed !== true) throw Error('请先确认这是你自己的正在关注列表');
  const tab = await chrome.tabs.get(message.tabId);
  const owner = followingOwner(tab.url);
  if (!owner) throw Error('自动收集仅支持 X 的 /用户名/following 页面');
  if ((await chrome.storage.local.get('activityRun')).activityRun?.phase === 'running') throw Error('正在检查账户主页，请先停止主页检查，再收集关注名单。');
  await reconcileScan(scan);
  scan = await enqueue(async () => {
    const existing = await getScan();
    if ((await chrome.storage.local.get('activityRun')).activityRun?.phase === 'running') throw Error('正在检查账户主页，请先停止主页检查。');
    if (activeScan(existing)) throw Error(existing.tabId === message.tabId ? '当前页面正在采集，请勿重复开始。' : '另一个页面正在采集，请先回到那个页面停止。');
    const now = new Date().toISOString();
    const data = await load();
    const state = {runId: crypto.randomUUID(), tabId: message.tabId, owner, phase: 'running', stopCode: null, autoSync: true,
      baseline: followingSync.baseline(data.records), seenHandles: [], startedFromTop: false,
      collected: 0, added: 0, steps: 0, startedAt: now, updatedAt: now, reason: '正在准备采集…'};
    await chrome.storage.local.set({followingScan: state});
    return state;
  });
  try {
    await chrome.scripting.executeScript({target: {tabId: message.tabId}, files: ['i18n.js', 'messages-runtime.js', 'reader.js', 'auto-collector.js']});
    await chrome.scripting.executeScript({target: {tabId: message.tabId}, func: options => globalThis.XReviewAutoCollector.start(options), args: [{runId: scan.runId, owner: scan.owner}]});
    return getScan();
  } catch (error) {
    await stopStored(scan.runId, '采集未能启动：' + error.message);
    throw error;
  }
}
async function scanMessage(message, sender) {
  const scan = await getScan();
  if (!scan || scan.runId !== message.runId || sender.tab?.id !== scan.tabId || sender.frameId !== 0 || String(message.owner).toLowerCase() !== scan.owner.toLowerCase()) throw Error('采集会话已失效');
  if (followingSync.failedScan(scan.runId)) return followingSync.failedScan(scan.runId);
  if (!activeScan(scan)) return scan;
  const owner = followingOwner(sender.url);
  if (!owner || owner.toLowerCase() !== scan.owner.toLowerCase()) {
    Object.assign(scan, {phase: 'stopped', stopCode: 'route-change', reason: '已离开原来的正在关注页面。', updatedAt: new Date().toISOString()});
    await chrome.storage.local.set({followingScan: scan});
    return scan;
  }
  scan.updatedAt = new Date().toISOString();
  if (Number.isInteger(message.steps)) scan.steps = Math.max(scan.steps, Math.min(500, message.steps));
  scan.collected = Array.isArray(scan.seenHandles) ? scan.seenHandles.length : 0;
  if (message.type === 'SCAN_PROGRESS') {
    if (!['running', 'paused', 'stopped'].includes(message.phase)) throw Error('无效的采集状态');
    scan.phase = message.phase;
    if (message.startedFromTop === true) scan.startedFromTop = true;
    const reportedCode = typeof message.stopCode === 'string' && /^[a-z-]{1,40}$/.test(message.stopCode) ? message.stopCode : 'unknown';
    scan.stopCode = message.phase === 'stopped'
      ? (reportedCode === 'bottom-stable' && (message.startedFromTop !== true || !scan.seenHandles?.length) ? 'incomplete' : reportedCode) : null;
    scan.reason = String(message.reason || '').slice(0, 300);
    if (scan.autoSync === true && scan.phase === 'stopped' && scan.stopCode === 'bottom-stable') {
      return followingSync.finish(scan);
    }
    await chrome.storage.local.set({followingScan: scan});
    return scan;
  }
  if (!Array.isArray(message.records) || message.records.length > 1000) throw Error('无效的账户批次');
  const records = message.records.map(record => core.normaliseRecord({handle: record.handle, name: record.name, source: 'auto-following', followingOwners: [scan.owner]}));
  const data = await load();
  const before = data.records.length;
  data.records = core.mergeRecords(data.records, records);
  scan.seenHandles = [...new Set([...(scan.seenHandles || []), ...records.map(record => record.handle.toLowerCase())])];
  scan.collected = scan.seenHandles.length;
  scan.added += Math.max(0, data.records.length - before);
  scan.reason = '采集中，账户已自动保存。';
  await chrome.storage.local.set({reviewData: data, followingScan: scan});
  return scan;
}
async function load() {
  return (await chrome.storage.local.get('reviewData')).reviewData || empty();
}
async function handle(message) {
  const data = await load();
  switch (message.type) {
    case 'GET': return data;
    case 'MERGE': {
      if (!Array.isArray(message.records)) throw Error('待合并的数据必须为账户数组。');
      const importedAt = new Date().toISOString();
      const incoming = message.records.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('账户记录格式无效。');
        return { ...record, updatedAt: importedAt };
      });
      data.records = core.mergeRecords(data.records, incoming);
      if (Number.isInteger(message.thresholdDays) && message.thresholdDays >= 1 && message.thresholdDays <= 3650) data.thresholdDays = message.thresholdDays;
      break;
    }
    case 'EVIDENCE': {
      const index = data.records.findIndex(r => r.key === message.key);
      if (index < 0) throw Error('账户记录不存在');
      const updated = core.normaliseRecord({...data.records[index], evidence: {...message.evidence, scope: 'manual'}, updatedAt: new Date().toISOString()});
      const evidence = updated.evidence;
      if (!evidence?.latestPostAt || !evidence.observedAt || Date.parse(evidence.latestPostAt) > Date.parse(evidence.observedAt) || Date.parse(evidence.observedAt) > Date.now()) throw Error('观察日期无效，请重新填写');
      // A deliberate correction replaces evidence; automatic captures still merge conservatively.
      data.records[index] = updated;
      break;
    }
    case 'STATUS': {
      if (!['pending', 'keep', 'reviewed'].includes(message.status)) throw Error('无效的记录状态');
      const record = data.records.find(r => r.key === message.key);
      if (record && record.status !== message.status) { record.status = message.status; record.updatedAt = new Date().toISOString(); }
      break;
    }
    case 'THRESHOLD':
      if (!Number.isInteger(message.days) || message.days < 1 || message.days > 3650) throw Error('阈值须为 1–3650 天');
      data.thresholdDays = message.days;
      break;
    case 'CLEAR': {
      data.records = [];
      const scan = await getScan();
      if (scan) {
        const cleared = {...scan, phase: 'stopped', stopCode: 'cleared', baseline: [], seenHandles: [], collected: 0,
          reason: '本地名单已清空，自动采集同时停止。', updatedAt: new Date().toISOString()};
        delete cleared.syncResult;
        delete cleared.syncRemovedRecords;
        await chrome.storage.local.set({followingScan: cleared});
      }
      await activity.cancelForClear();
      await followingSync.clearForReset();
      break;
    }
    case 'OPEN': {
      const record = data.records.find(r => r.key === message.key);
      if (!record) throw Error('找不到这条记录');
      const url = core.profileUrl(record);
      if (!url) throw Error('无效的 X 主页地址');
      const tab = await chrome.tabs.create({url});
      // Stable-ID entries are linked to the resolved handle only after explicit confirmation.
      if (record.id) await chrome.storage.local.set({['tabLink:' + tab.id]: {key: record.key, id: record.id}});
      return data;
    }
    case 'LINK': {
      const link = (await chrome.storage.local.get('tabLink:' + message.tabId))['tabLink:' + message.tabId];
      if (!link) throw Error('关联已失效，请重新从名单打开主页');
      data.records = core.mergeRecords(data.records, [{...message.record, id: link.id}]);
      await chrome.storage.local.remove('tabLink:' + message.tabId);
      break;
    }
    default: throw Error('未知操作');
  }
  await chrome.storage.local.set({reviewData: data});
  return data;
}
const activity = createActivityService({core, enqueue, load, getFollowingScan: getScan, reconcileFollowingScan: reconcileScan});
const followingSync = createFollowingSyncService({core, enqueue, load, getScan});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  let operation;
  if (['SCAN_BATCH', 'SCAN_PROGRESS'].includes(message.type)) operation = enqueue(() => scanMessage(message, sender));
  else if (!sender.url?.startsWith(chrome.runtime.getURL(''))) operation = Promise.reject(Error('此操作须从扩展工作台发起'));
  else if (String(message.type).startsWith('ACT_')) operation = activity.handle(message, sender);
  else if (String(message.type).startsWith('SYNC_')) operation = followingSync.handle(message, sender);
  else if (['SCAN_BEGIN', 'SCAN_STATUS', 'SCAN_STOP'].includes(message.type)) operation = scanControl(message);
  else operation = enqueue(() => handle(message));
  operation.then(data => respond({ok: true, data: String(message.type).startsWith('SCAN_') ? publicScan(data) : data}), error => respond({ok: false, error: error.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => {
  await chrome.storage.local.remove('tabLink:' + tabId);
  const scan = await getScan();
  if (scan?.tabId === tabId) await stopStored(scan.runId, '采集页面已关闭，已保存的账户会保留。', 'tab-closed');
  await activity.tabRemoved(tabId);
});
chrome.runtime.onStartup.addListener(async () => {
  const scan = await getScan();
  if (activeScan(scan)) await stopStored(scan.runId, '浏览器已重启，请重新开始采集。', 'restart');
  await activity.startup();
});
