'use strict';
const $ = id => document.getElementById(id);
const I = globalThis.XReviewI18n;
const t = source => I.t(source);
let snapshot, tabId, link, previewThreshold = 180, previewReady = false, scanOwner = '';
let popupNotice = null, scanNotice = null, activityNotice = null;
const noticeText = source => typeof source === 'function' ? source() : String(source).split('\n').map(t).join('\n');
async function send(message) {const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error||'保存失败');return result.data;}
function status(source,error=false){popupNotice={source,error};$('popup-status').textContent=noticeText(source);$('popup-status').classList.toggle('error',error);}
let scanTabId, scanState = null, scanBusy = false, scanPolling = false, scanTimer, popupClosed = false, scanRevision = 0;
const scanIsActive = () => ['running', 'paused'].includes(scanState?.phase);
function scanStatus(source, error = false) {
  scanNotice = {source, error};
  $('scan-status').textContent = noticeText(source);
  $('scan-status').classList.toggle('error', error);
}
function updateScanControls() {
  $('scan-start').disabled = !scanTabId || scanBusy || scanIsActive() || !$('auto-confirm').checked;
  $('scan-stop').disabled = scanBusy || !scanIsActive();
  $('auto-confirm').disabled = scanBusy || scanIsActive();
}
function renderScan(next) {
  scanState = next?.tabId === scanTabId ? next : null;
  $('scan-progress').hidden = !scanState;
  $('scan-phase').textContent = t({running: '收集中', paused: '已暂停', stopped: '已停止'}[scanState?.phase] || '未开始');
  $('scan-phase').classList.toggle('recent', scanState?.phase === 'running');
  for (const field of ['collected', 'added', 'steps']) {
    const count = Number(scanState?.[field]);
    $('scan-' + field).textContent = Number.isFinite(count) && count >= 0 ? String(Math.floor(count)) : '0';
  }
  if (scanIsActive()) $('auto-confirm').checked = false;
  const defaults = {
    running: '正在保存名单并滚动加载；可随时停止，已保存的账户会保留。',
    paused: '采集已暂停。回到此 X 标签页并保持可见后继续。',
    stopped: '本轮已停止。收集结果不代表已覆盖完整关注名单。'
  };
  const scanMessage = scanState ? (scanState.reason || defaults[scanState.phase] || '请核对采集状态。') : '勾选确认后开始；打开扩展不会自动运行。';
  const sync = scanState?.syncResult;
  const syncMessage = sync?.status === 'applied'
    ? `自动清理了 ${Math.max(0, Number(sync.removed) || 0)} 条本地旧记录，另保留 ${Math.max(0, Number(sync.retainedCount) || 0)} 条不确定旧记录。可点「查看同步记录」查看或撤销。`
    : sync?.status === 'failed' ? '自动清理失败，请在「查看同步记录」中查看原因。'
    : scanState?.stopCode === 'bottom-stable' ? '可点「查看同步记录」查看本轮结果。' : '';
  scanStatus(() => t(scanMessage) + (syncMessage ? ' ' + t(syncMessage) : ''));
  updateScanControls();
}
async function refreshScan() {
  if (!scanTabId || scanBusy || scanPolling || popupClosed || document.hidden) return;
  scanPolling = true;
  const revision = scanRevision;
  try {
    const state = await send({type: 'SCAN_STATUS', tabId: scanTabId});
    if (!popupClosed && !scanBusy && revision === scanRevision) renderScan(state);
  } catch (error) {
    if (!popupClosed) scanStatus(() => t('无法读取采集状态：') + t(error.message), true);
  } finally { scanPolling = false; }
}
function pollScan() {
  clearInterval(scanTimer);
  if (!popupClosed && !document.hidden && scanTabId) scanTimer = setInterval(refreshScan, 1000);
}
$('auto-confirm').addEventListener('change', updateScanControls);
$('scan-start').addEventListener('click', async () => {
  if (!scanTabId || scanBusy || scanIsActive() || !$('auto-confirm').checked) return;
  scanBusy = true;
  scanRevision++;
  $('auto-confirm').checked = false;
  updateScanControls();
  scanStatus('正在启动自动收集…');
  try { renderScan(await send({type: 'SCAN_BEGIN', tabId: scanTabId, ownerConfirmed: true})); }
  catch (error) { scanStatus(error.message, true); }
  finally { scanBusy = false; updateScanControls(); }
});
$('scan-stop').addEventListener('click', async () => {
  if (!scanTabId || scanBusy || !scanIsActive()) return;
  scanBusy = true;
  scanRevision++;
  updateScanControls();
  scanStatus('正在停止收集…');
  try { renderScan(await send({type: 'SCAN_STOP', tabId: scanTabId})); }
  catch (error) { scanStatus(error.message, true); }
  finally { scanBusy = false; updateScanControls(); }
});
document.addEventListener('visibilitychange', () => { pollScan(); if (!document.hidden) refreshScan(); });
window.addEventListener('pagehide', () => { popupClosed = true; clearInterval(scanTimer); }, {once: true});
window.addEventListener('unload', () => { popupClosed = true; clearInterval(scanTimer); }, {once: true});
async function initialiseScan() {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const url = new URL(tab?.url || 'about:blank');
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || !match || !Number.isInteger(tab?.id)) return;
    scanTabId = tab.id;
    scanOwner = match[1];
    $('auto-owner').textContent = t(`@${scanOwner} 的正在关注列表`);
    $('auto-section').hidden = false;
    updateScanControls();
    await refreshScan();
    pollScan();
  } catch (error) { status(() => t('无法识别当前页面：') + t(error.message), true); }
}
function renderPreview() {
  if (!previewReady || !snapshot) return;
  let text = '';
  if (snapshot.kind === 'following') {
    text = t(`列表所属：@${snapshot.owner}`) + '\n' + t(`已读取 ${snapshot.records.length} 个已加载账户。`) + '\n' + t('尚未滚动加载的账户不在此次结果中。');
  } else {
    const record = snapshot.record, evidence = record.evidence;
    const date = evidence?.latestPostAt ? new Date(evidence.latestPostAt).toLocaleString(I.getLocale()) : t('无法确定');
    text = `@${record.handle}\n` + t(`本次发帖样本：${evidence?.sampleCount || 0} 条`) + '\n' + t('观察到的最新发帖：') + date + '\n';
    text += t(`当前阈值：${previewThreshold} 天`) + '\n' + t(globalThis.XReviewCore.classify(record, previewThreshold).reason);
    if (link) $('link-label').textContent = t(`将 @${record.handle} 关联到工作台打开的 ID ${link.id}（请确认期间未切换账户）`);
  }
  if (snapshot.warnings?.length) text += '\n\n' + snapshot.warnings.map(t).join('\n');
  $('preview').textContent = text;
  $('save').textContent = t(snapshot.kind === 'following' ? '保存这批账户' : '保存观察');
}
$('capture').addEventListener('click',async()=>{
  $('capture').disabled=true; $('save').hidden=true; $('preview').hidden=true; $('following-check').hidden=true; $('link-check').hidden=true; $('following-confirm').checked=false; $('link-confirm').checked=false; snapshot=null;link=null;previewReady=false;status('正在读取当前页面…');
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;
    const url=new URL(tab?.url||'about:blank');
    if(url.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname))throw Error('请先切换到 X 账户主页或自己的正在关注列表。');
    await chrome.scripting.executeScript({target:{tabId},files:['reader.js']});
    const [result]=await chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.XReviewReadPage()});
    snapshot=result.result;
    if(!snapshot||!['profile','following'].includes(snapshot.kind))throw Error(snapshot?.warnings?.join('\n')||'暂不支持此页面，请打开账户的「帖子」页。');
    if(snapshot.kind==='following'){
      $('following-check').hidden=false;
      if(!snapshot.records.length)throw Error(snapshot.warnings?.join('\n')||'没有读到账户，请等待列表加载后重试。');
    }else{
      const data=await send({type:'GET'});previewThreshold=data.thresholdDays;
      link=(await chrome.storage.local.get('tabLink:'+tabId))['tabLink:'+tabId];
      if(link)$('link-check').hidden=false;
    }
    previewReady=true;renderPreview();$('preview').hidden=false;$('save').hidden=false;$('save').disabled=false;status('请核对后保存。');
  }catch(e){status(e.message,true);}finally{$('capture').disabled=false;}
});
$('save').addEventListener('click',async()=>{
  $('save').disabled=true;
  try{
    if(snapshot.kind==='following'){
      if(!$('following-confirm').checked)throw Error('请先确认这是你自己的正在关注列表。');
      await send({type:'MERGE',records:snapshot.records.map(record=>({...record,followingOwners:[snapshot.owner]}))});
    }else if(link&&$('link-confirm').checked)await send({type:'LINK',tabId,record:snapshot.record});
    else await send({type:'MERGE',records:[snapshot.record]});
    status('已保存到本地工作台。');$('save').hidden=true;
  }catch(e){status(e.message,true);}finally{$('save').disabled=false;}
});
$('dashboard').addEventListener('click',()=>chrome.tabs.create({url:chrome.runtime.getURL('index.html')}));
$('following-sync-open').addEventListener('click',()=>chrome.tabs.create({url:chrome.runtime.getURL('index.html#following-sync')}));

// The controller owns profile checks; the popup only opens it or requests a stop.
let activityPollTimer, activityStatusBusy = false;
function activityStatus(source) {activityNotice=source;$('activity-popup-status').textContent=noticeText(source);}
async function popupActivityStatus() {
  if (popupClosed || activityStatusBusy || document.hidden) return;
  activityStatusBusy = true;
  try {
    const run = await send({type: 'ACT_STATUS'});
    if (popupClosed) return;
    const active = run?.phase === 'running';
    $('activity-stop').hidden = !active;
    $('activity-popup-status').hidden = !active;
    if (active) {
      const completed = Number(run.completed) || 0, skipped = Number(run.skipped) || 0, total = Number(run.total) || 0;
      activityStatus(`发帖时间检查：进度 ${Math.min(completed + skipped, total)} / ${total}，已检查 ${completed}，跳过 ${skipped}。`);
    }
  } catch (_) { /* Older service versions may not expose this status yet. */ }
  finally { activityStatusBusy = false; }
}
$('activity-open').addEventListener('click', async () => {
  try {
    const run = await send({type: 'ACT_STATUS'});
    if (run?.phase === 'running' && Number.isInteger(run.controllerTabId)) {
      try { await chrome.tabs.update(run.controllerTabId, {active: true}); return; } catch (_) {}
    }
    await chrome.tabs.create({url: chrome.runtime.getURL('activity.html')});
  } catch (_) { chrome.tabs.create({url: chrome.runtime.getURL('activity.html')}); }
});
$('activity-stop').addEventListener('click', async () => {
  $('activity-stop').disabled = true;
  try {
    await send({type: 'ACT_STOP'});
    $('activity-stop').hidden = true;
    $('activity-popup-status').hidden = false;
    activityStatus('发帖时间检查已停止，已保存记录会保留。');
  } catch (error) {
    $('activity-popup-status').hidden = false;
    activityStatus(() => t('停止请求未能确认：') + t(error.message));
  } finally { $('activity-stop').disabled = false; }
});
function pollPopupActivity() {
  clearInterval(activityPollTimer);
  if (!popupClosed && !document.hidden) activityPollTimer = setInterval(popupActivityStatus, 1000);
}
function localise() {
  I.apply(document);
  const previousScanNotice = scanNotice;
  renderScan(scanState);
  if (previousScanNotice) scanStatus(previousScanNotice.source, previousScanNotice.error);
  if (scanOwner) $('auto-owner').textContent = t(`@${scanOwner} 的正在关注列表`);
  renderPreview();
  if (popupNotice) status(popupNotice.source, popupNotice.error);
  if (activityNotice !== null) activityStatus(activityNotice);
  if (!previewReady) $('save').textContent = t('保存观察');
}
I.bindLanguageSelect($('language-select'));
I.onChange(localise);
document.addEventListener('visibilitychange', () => { pollPopupActivity(); if (!document.hidden) popupActivityStatus(); });
window.addEventListener('pagehide', () => clearInterval(activityPollTimer), {once: true});
window.addEventListener('unload', () => clearInterval(activityPollTimer), {once: true});
I.ready.then(() => {localise();initialiseScan();popupActivityStatus();pollPopupActivity();});
