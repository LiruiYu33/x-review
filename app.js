'use strict';
const core = globalThis.XReviewCore;
const i18n = globalThis.XReviewI18n;
const t = source => i18n.t(source);
const $ = id => document.getElementById(id);
const isExtension = !!globalThis.chrome?.runtime?.id;
$('activity-open').hidden = !isExtension;
$('activity-open').addEventListener('click', () => {
  if (isExtension) chrome.tabs.create({url: chrome.runtime.getURL('activity.html')});
});
const empty = () => ({schemaVersion: 1, records: [], thresholdDays: 180});
let data = empty(), demo = false, view = 'candidate', query = '', evidenceKey = '', toastTimer;
let manualUnfollow = null, manualCanUndo = false, manualBusy = false, manualError = '', manualStatusVersion = 0;
const activeUnfollow = () => ['opening', 'watching', 'armed'].includes(manualUnfollow?.phase);
const labels = {candidate: '待复核候选', all: '全部账户', unknown: '待补充数据', stale: '观察已过期', recent: '近期有发帖', keep: '保留名单', reviewed: '已处理'};
const descriptions = {candidate: '这些账户需要你到主页再次确认，并不代表已经停用。', all: '所有导入和手动采集的记录，包括数据不足的账户。', unknown: '缺少可靠发帖记录，或上次观察已超过 7 天；不会列入候选。', keep: '你选择保留的账户，不再进入候选名单。', reviewed: '你已经在本地标记处理的账户，不代表 X 关注状态已经改变。'};
function text(id, source) { const node = $(id); node.dataset.i18n = String(source ?? ''); node.textContent = t(source); }
function notify(message) { clearTimeout(toastTimer); text('notice', message); toastTimer = setTimeout(() => text('notice', ''), 6500); }
function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; }
function button(text, cls, fn) { const b = el('button', cls, t(text)); b.type = 'button'; b.addEventListener('click', () => Promise.resolve().then(fn).catch(e => notify(e.message))); return b; }
async function command(message) {
  if (demo) return localCommand(message, false);
  if (isExtension) { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw Error(result?.error || '扩展服务暂时不可用，请重新打开工作台。'); data = result.data; return data; }
  return navigator.locks ? navigator.locks.request('x-review-storage', () => localCommand(message, true)) : localCommand(message, true);
}
function localCommand(message, persist) {
  if (persist) { const stored = localStorage.getItem('x-review-v1'); data = stored ? JSON.parse(stored) : empty(); }
  if (message.type === 'GET') {
    return data;
  }
  if (message.type === 'MERGE') {
    data.records = core.mergeRecords(data.records, message.records);
    if(Number.isInteger(message.thresholdDays)&&message.thresholdDays>=1&&message.thresholdDays<=3650)data.thresholdDays=message.thresholdDays;
  }
  if (message.type === 'EVIDENCE') {
    const index=data.records.findIndex(r=>r.key===message.key);
    if(index<0)throw Error('账户记录不存在');
    data.records[index]=core.normaliseRecord({...data.records[index],evidence:message.evidence,updatedAt:new Date().toISOString()});
  }
  if (message.type === 'STATUS') { const record = data.records.find(r => r.key === message.key); if (record) record.status = message.status; }
  if (message.type === 'THRESHOLD') data.thresholdDays = message.days;
  if (message.type === 'CLEAR') data.records = [];
  if (persist) localStorage.setItem('x-review-v1', JSON.stringify(data));
  return data;
}
function fmt(date, withTime = false) {
  if (!date || !Number.isFinite(Date.parse(date))) return t('尚未记录');
  const opts = {year:'numeric',month:'2-digit',day:'2-digit'};
  if (withTime) Object.assign(opts, {hour:'2-digit',minute:'2-digit'});
  return new Intl.DateTimeFormat(i18n.getLocale(), opts).format(new Date(date));
}
function classified() { return data.records.map(record => ({record, result: core.classify(record, data.thresholdDays)})); }
function visibleRows() {
  return classified().filter(({record, result}) => (view === 'all' || (view === 'unknown' ? ['unknown','stale'].includes(result.bucket) : result.bucket === view)) && `${record.handle || ''} ${record.name || ''} ${record.id || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => (b.result.days || -1) - (a.result.days || -1) || (a.record.handle || a.record.id || '').localeCompare(b.record.handle || b.record.id || ''));
}
function render() {
  const all = classified(), counts = {};
  all.forEach(({result}) => counts[result.bucket] = (counts[result.bucket] || 0) + 1);
  const unknown = (counts.unknown || 0) + (counts.stale || 0);
  text('stat-total', data.records.length);
  text('stat-candidate', counts.candidate || 0);
  text('stat-unknown', unknown);
  text('stat-keep', counts.keep || 0);
  ['candidate','keep','reviewed'].forEach(key => $('nav-' + key).textContent = counts[key] || 0);
  text('nav-all', data.records.length); text('nav-unknown', unknown);
  $('threshold').value = data.thresholdDays;
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('selected', b.dataset.view === view); if (b.dataset.view === view) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  text('list-title', labels[view]); text('list-description', descriptions[view]);
  const rows = visibleRows(); text('result-count', `${rows.length} 个账户`);
  $('rows').replaceChildren(...rows.slice(0,500).map(renderRow));
  if (rows.length > 500) text('result-count', `${rows.length} 个账户 · 显示前 500 个，请搜索缩小范围`);
  $('account-table').hidden = rows.length === 0; $('empty-state').hidden = rows.length !== 0;
  const noData = data.records.length === 0;
  text('empty-title', noData ? '先建立你的关注名单' : query ? '没有匹配的账户' : view === 'candidate' ? '当前没有待复核候选' : '这个名单暂时为空');
  text('empty-text', noData ? '导入 X 档案中的 following.js、CSV，或粘贴用户名。没有发帖记录的账户会保留在「待补充数据」。' : view === 'candidate' && unknown ? `有 ${unknown} 个账户还需要补充或更新观察。未知状态不会自动成为候选。` : '试试其他视图、修改筛选阈值，或导入更多记录。');
  $('empty-import').hidden = !noData;
  $('export-csv').disabled = rows.length === 0;
  $('mode-banner').hidden = isExtension && !demo;
  text('mode-banner', demo ? '示例模式 · 以下账户及数据均为虚构，不会写入你的真实名单。' : '独立网页模式 · 可导入、筛选和记录日期。读取 X 页面请安装同目录的浏览器扩展；两种模式的数据可通过 JSON 备份迁移。');
  text('demo-toggle', demo ? '返回我的名单' : '体验示例');
  $('import-open').disabled = demo; $('empty-import').disabled = demo;
  $('clear-data').hidden = demo; $('export-json').disabled = demo;
  $('following-sync-open').hidden = !isExtension || demo;
  renderManualUnfollow();
}
function renderRow({record, result}) {
  const tr = el('tr');
  const identity = el('td'), account = el('div','account');
  const name = record.name && demo && record.source === 'demo' ? t(record.name) : record.name;
  account.append(el('span','avatar',(name || record.handle || '#').slice(0,2).toUpperCase()));
  const text = el('div'); text.append(el('span','account-name', name || (record.handle ? '@' + record.handle : t('待解析账户'))));
  text.append(el('span','subline',record.handle ? '@' + record.handle : 'ID ' + record.id)); account.append(text); identity.append(account);
  const date = el('td'); date.append(el('span','',fmt(record.evidence?.latestPostAt)));
  if (record.evidence?.observedAt) date.append(el('span','subline',t('采集 ' + fmt(record.evidence.observedAt))));
  const reason = el('td','reason'); reason.append(el('span','badge ' + result.bucket,t(labels[result.bucket])));
  const explanation = ['candidate','recent'].includes(result.bucket) ? `采集时相隔 ${result.days} 天 · ${record.evidence?.scope === 'manual' ? '人工核实' : (record.evidence?.sampleCount || 0) + ' 条普通帖子样本'}` : result.reason;
  const detail = el('span','subline',t(explanation)); detail.title = t(result.reason); reason.append(detail);
  const actions = el('td'), wrap = el('div','row-actions');
  const link = el('a','button',t('打开 X 主页')); link.href = core.profileUrl(record); link.target = '_blank'; link.rel = 'noopener noreferrer';
  if (demo) link.addEventListener('click', e => {e.preventDefault(); notify('这是虚构示例。返回「我的名单」后可打开真实账户。');});
  else if (isExtension) link.addEventListener('click', e => { e.preventDefault(); command({type:'OPEN',key:record.key}).catch(e => notify(e.message)); });
  wrap.append(link);
  if (isExtension && !demo) {
    const sameSession = activeUnfollow() && manualUnfollow.key === record.key;
    const unfollow = el('button', 'button unfollow-button', t(sameSession ? '返回取关窗口' : '取消关注'));
    unfollow.type = 'button'; unfollow.dataset.unfollowKey = record.key;
    unfollow.disabled = manualBusy || (activeUnfollow() && !sameSession);
    unfollow.title = t('在新窗口中使用 X 原生按钮自行取关，确认状态改变后自动移除本地记录。');
    // Keep the permission request on the original user gesture, before any await or deferred callback.
    unfollow.addEventListener('click', () => { void beginManualUnfollow(record.key); });
    wrap.append(unfollow);
  }
  const secondary = el('div','row-secondary');
  secondary.append(button('记录日期','text-button',() => openEvidence(record)));
  if (record.status === 'keep' || record.status === 'reviewed') secondary.append(button('恢复待审','text-button',async () => {await command({type:'STATUS',key:record.key,status:'pending'});render();}));
  else {
    secondary.append(button('保留','text-button',async () => {await command({type:'STATUS',key:record.key,status:'keep'});render();notify('已加入本地保留名单');}));
    secondary.append(button('已处理','text-button',async () => {await command({type:'STATUS',key:record.key,status:'reviewed'});render();notify('已标记处理；X 关注关系未由本工具更改');}));
  }
  wrap.append(secondary);actions.append(wrap);tr.append(identity,date,reason,actions);return tr;
}
function renderManualUnfollow() {
  $('manual-unfollow').hidden = !isExtension || demo || (!manualUnfollow && !manualCanUndo && !manualError && !manualBusy);
  const names = {opening:'正在打开 X 窗口', watching:'等待核实关注状态', armed:'请在 X 窗口自行取消关注', removed:'已移除本地记录', retained:'本地记录已保留', cancelled:'已停止观察', failed:'未能完成观察'};
  const account = manualUnfollow?.handle ? '@' + manualUnfollow.handle : manualUnfollow?.key || '';
  text('manual-unfollow-title', (names[manualUnfollow?.phase] || '手动取关') + (account ? ' · ' + account : ''));
  text('manual-unfollow-reason', manualError || manualUnfollow?.reason || '在新窗口中使用 X 原生按钮自行取关，确认状态改变后自动移除本地记录。');
  $('manual-unfollow-reason').classList.toggle('error', !!manualError || manualUnfollow?.phase === 'failed');
  $('manual-unfollow-undo').hidden = !manualCanUndo;
  $('manual-unfollow-undo').disabled = manualBusy || activeUnfollow();
  $('manual-unfollow-refresh').disabled = manualBusy;
  $('manual-unfollow-cancel').hidden = !activeUnfollow();
  $('manual-unfollow-cancel').disabled = manualBusy;
}
async function manualRequest(message) {
  if (!isExtension || demo) throw Error('手动取关同步仅在扩展版的真实名单中可用。');
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw Error(response?.error || '取关观察服务暂时不可用，请重新加载扩展。');
  return response.data;
}
async function loadManualUnfollow() {
  if (!isExtension || demo) return;
  const version = ++manualStatusVersion;
  try {
    const status = await manualRequest({type:'UNFOLLOW_STATUS'});
    if (version !== manualStatusVersion) return;
    manualUnfollow = status?.session || null;
    manualCanUndo = status?.canUndo === true;
    manualError = '';
    render();
  } catch (error) {
    if (version !== manualStatusVersion) return;
    manualError = error.message;
    renderManualUnfollow();
  }
}
async function beginManualUnfollow(key) {
  if (manualBusy || !isExtension || demo) return;
  manualBusy = true; manualError = '';
  try {
    // Chrome requires this call to run directly in the trusted click handler.
    const permission = chrome.permissions.request({origins:['https://x.com/*']});
    render();
    if (!await permission) throw Error('未授予 X 页面访问权限；账户记录已保留。');
    manualUnfollow = await manualRequest({type:'UNFOLLOW_BEGIN', key});
    render();
    await loadManualUnfollow();
  } catch (error) { manualError = error.message; }
  finally { manualBusy = false; render(); }
}
$('manual-unfollow-cancel').addEventListener('click', async () => {
  if (manualBusy || !activeUnfollow() || !isExtension || demo) return;
  manualBusy = true; manualError = ''; renderManualUnfollow();
  try {
    manualUnfollow = await manualRequest({type:'UNFOLLOW_CANCEL'});
    await loadManualUnfollow();
  } catch(error) { manualError = error.message; }
  finally { manualBusy = false; render(); }
});
$('manual-unfollow-refresh').addEventListener('click', () => { void loadManualUnfollow(); });
$('manual-unfollow-undo').addEventListener('click', async () => {
  if (manualBusy || !manualCanUndo || activeUnfollow() || !isExtension || demo) return;
  manualBusy = true; manualError = ''; renderManualUnfollow();
  try {
    const result = await manualRequest({type:'UNFOLLOW_UNDO'});
    manualUnfollow = result?.session || manualUnfollow;
    notify(Number(result?.restored) > 0 ? '本地记录已恢复；不会重新关注 X 账户。' : '未覆盖现有记录；不会重新关注 X 账户。');
    await command({type:'GET'});
    await loadManualUnfollow();
  } catch (error) { manualError = error.message; }
  finally { manualBusy = false; render(); }
});
function download(name, text, mime) { const url = URL.createObjectURL(new Blob([text],{type:mime})); const a = el('a'); a.href=url; a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url),1000); }
function showImport() { text('import-error', ''); $('import-dialog').showModal(); }
function localDateTime(value) { const date = new Date(value); return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16); }
function openEvidence(record) { evidenceKey=record.key; text('evidence-title', '记录观察 · ' + (record.handle ? '@'+record.handle : record.id)); $('last-post').value=record.evidence?.latestPostAt ? localDateTime(record.evidence.latestPostAt) : ''; $('observed-at').value=localDateTime(Date.now()); text('evidence-error', ''); $('evidence-dialog').showModal(); }
function demoData() {
  const now = new Date().toISOString(), ago = days => new Date(Date.now()-days*86400000).toISOString();
  const specimens = [
    {handle:'sample_atlas',name:'Atlas / 阅读笔记',days:426}, {handle:'sample_studio',name:'Studio Journal',days:284}, {handle:'sample_field',name:'Field Notes',days:192},
    {handle:'sample_today',name:'每日观察',days:2}, {handle:'sample_new',name:'尚未采集的账户'},
    {handle:'sample_old',name:'需要更新观察',days:200,stale:true}, {handle:'sample_keep',name:'值得保留的作者',days:730,status:'keep'}, {handle:'sample_done',name:'已经核实的账户',days:240,status:'reviewed'}
  ];
  return {schemaVersion:1,thresholdDays:180,records:specimens.map(s => core.normaliseRecord({handle:s.handle,name:s.name,status:s.status || 'pending',source:'demo',evidence:s.days ? {latestPostAt:ago(s.days),observedAt:s.stale ? ago(20) : now,sampleCount:5,scope:'profile-posts',profileAtTop:true,hasUncertainReposts:false} : undefined}))};
}
$('views').addEventListener('click', e => { const b=e.target.closest('[data-view]'); if(b){view=b.dataset.view;render();} });
$('search').addEventListener('input', e => {query=e.target.value;render();});
$('threshold-apply').addEventListener('click', async () => {const days=Number($('threshold').value); if(!Number.isInteger(days)||days<1||days>3650){notify('请输入 1–3650 之间的整数天数');return;} try{await command({type:'THRESHOLD',days});render();notify('筛选阈值已更新');}catch(e){notify(e.message);}});
['import-open','empty-import'].forEach(id => $(id).addEventListener('click',showImport));
$('import-submit').addEventListener('click', async () => {
  const submit=$('import-submit'); submit.disabled=true;
  try {const file=$('import-file').files[0]; if(file && file.size>20*1024*1024) throw Error('文件大于 20 MB，请仅选择关注名单文件。'); const text=file ? await file.text() : $('import-text').value; const parsed=core.parseImport(text,file?.name); let thresholdDays;try{const backup=JSON.parse(text);if(backup.schemaVersion===1)thresholdDays=backup.thresholdDays;}catch{} await command({type:'MERGE',records:parsed.records,thresholdDays}); view='all';query='';$('search').value='';render();$('import-dialog').close();$('import-file').value='';$('import-text').value='';notify(`已合并 ${parsed.records.length} 条记录。${parsed.warnings.slice(0,2).join(' ')}`);}catch(e){text('import-error', e.message);}finally{submit.disabled=false;}
});
$('evidence-save').addEventListener('click',async () => {
  try { const record=data.records.find(r=>r.key===evidenceKey);if(!record)throw Error('账户记录不存在');const latest=$('last-post').value,observed=$('observed-at').value;if(!latest||!observed)throw Error('请填写两个日期和时间');const last=new Date(latest),seen=new Date(observed);if(!Number.isFinite(last.getTime())||!Number.isFinite(seen.getTime())||last>seen||seen>new Date())throw Error('发帖时间不能晚于核对时间，核对时间不能在未来');await command({type:'EVIDENCE',key:record.key,evidence:{latestPostAt:last.toISOString(),observedAt:seen.toISOString(),sampleCount:1,scope:'manual',profileAtTop:true,hasUncertainReposts:false}});render();$('evidence-dialog').close();notify('人工观察已保存');}catch(e){text('evidence-error', e.message);}
});
$('export-json').addEventListener('click',()=>download('x-review-backup.json',JSON.stringify(data,null,2),'application/json'));
$('export-csv').addEventListener('click',()=>download(demo?'x-review-demo.csv':'x-review-candidates.csv',core.exportCSV(visibleRows().map(({record})=>record)),'text/csv;charset=utf-8'));
$('help-open').addEventListener('click',()=>$('help-dialog').showModal());
$('demo-toggle').addEventListener('click',async()=>{try{demo=!demo; if(demo)data=demoData();else { await command({type:'GET'}); void loadManualUnfollow(); }view='candidate';query='';$('search').value='';render();}catch(e){notify(e.message);}});
$('clear-data').addEventListener('click',async()=>{if(!confirm(t('清空当前浏览器中保存的所有账户记录，并停止自动采集？此操作不会更改 X 上的关注关系。请先备份需要保留的数据。')))return;try{await command({type:'CLEAR'});render();notify('本地名单已清空');}catch(e){notify(e.message);}});
if(isExtension) chrome.storage.onChanged.addListener(async (changes, area)=>{
  if (area !== 'local' || demo) return;
  if (changes.reviewData) { try { await command({type:'GET'}); render(); } catch(error) { notify(error.message); } }
  if (changes.manualUnfollow || changes.manualUnfollowUndo) void loadManualUnfollow();
});
else window.addEventListener('storage',async event=>{if(event.key==='x-review-v1'&&!demo){try{await command({type:'GET'});render();}catch(e){notify(e.message);}}});
let syncPreview = null, syncBusy = false, syncVersion = 0;
async function syncRequest(message) {
  if (!isExtension || demo) throw Error('同步记录仅在扩展版的真实名单中可用。');
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw Error(response?.error || '同步服务暂时不可用，请重新加载扩展。');
  return response.data;
}
function syncFeedback(message, error = false) {
  text('sync-feedback', message);
  $('sync-feedback').classList.toggle('error', error);
}
function syncControls() {
  $('sync-refresh').disabled = syncBusy || !isExtension || demo;
  $('sync-undo').hidden = !syncPreview?.canUndo;
  $('sync-undo').disabled = syncBusy || !isExtension || demo;
}
function renderSyncPreview(preview) {
  syncPreview = preview || null;
  const number = value => Math.max(0, Number(value) || 0);
  const owner = preview?.owner ? '@' + String(preview.owner).replace(/^@/, '') : '';
  text('sync-run-summary', owner ? '本轮列表：' + owner + ' · 收录 ' + number(preview.collected) + ' 个账户' : '尚无关注列表的自动同步记录');
  text('sync-removed-count', preview?.undone ? '本轮自动清理已撤销' : preview?.autoSynced ? '本轮自动清理：' + number(preview.removedCount) + ' 条本地旧记录' : '本轮未执行自动清理');
  text('sync-retained', preview ? '另保留 ' + number(preview.retainedCount) + ' 条无法可靠清理的旧记录' : '');
  const undoOwner = preview?.undoOwner ? '@' + String(preview.undoOwner).replace(/^@/, '') : '上一次名单';
  $('sync-undo-detail').hidden = !preview?.canUndo;
  text('sync-undo-detail', '可撤销的上一轮：' + undoOwner + ' · ' + number(preview?.undoRemovedCount ?? preview?.removedCount) + ' 条本地记录');
  text('sync-reason', preview?.reason || (preview?.autoSynced ? '自动清理已完成。若发现名单漏项，可撤销上次自动清理。' : '重新自动收集自己的正在关注列表，自然到底结束后会自动同步。打开此窗口或刷新记录不会清理数据。'));
  const records = Array.isArray(preview?.removedRecords) ? preview.removedRecords : [];
  $('sync-removed-list-section').hidden = !records.length;
  $('sync-removed-records').replaceChildren(...records.map(record => {
    const row = el('div', 'sync-record'); row.setAttribute('role', 'listitem');
    const handle = record.handle ? '@' + String(record.handle).replace(/^@/, '') : String(record.key || t('旧记录'));
    row.append(el('strong', '', record.name || handle), el('span', 'subline', handle));
    return row;
  }));
  syncControls();
}
async function loadSyncPreview() {
  if (syncBusy) return;
  const version = ++syncVersion;
  syncBusy = true;
  renderSyncPreview(null);
  syncFeedback('正在读取自动同步记录…');
  try {
    const preview = await syncRequest({type: 'SYNC_STATUS'});
    if (version !== syncVersion) return;
    renderSyncPreview(preview);
    syncFeedback('');
  } catch (error) {
    if (version === syncVersion) {
      renderSyncPreview(null);
      syncFeedback(error.message + ' 此窗口只显示结果；请从扩展启动新的关注列表收集。', true);
    }
  } finally { if (version === syncVersion) { syncBusy = false; syncControls(); } }
}
function openFollowingSync() {
  if (!$('following-sync-dialog').open) $('following-sync-dialog').showModal();
  void loadSyncPreview();
}
$('following-sync-open').addEventListener('click', openFollowingSync);
$('sync-refresh').addEventListener('click', loadSyncPreview);
$('sync-undo').addEventListener('click', async () => {
  if (syncBusy || !isExtension || demo || !syncPreview?.canUndo) return;
  syncBusy = true; syncControls(); syncFeedback('正在恢复上次自动清理的本地记录…');
  try {
    const result = await syncRequest({type: 'SYNC_UNDO'});
    renderSyncPreview(result.preview);
    const message = '已恢复 ' + (Number(result.restored) || 0) + ' 条本地记录。';
    syncFeedback(message); notify(message);
    try { await command({type: 'GET'}); render(); }
    catch (error) { syncFeedback(message + ' 工作台刷新失败，请重新打开：' + error.message, true); }
  } catch (error) { syncFeedback('无法撤销：' + error.message, true); }
  finally { syncBusy = false; syncControls(); }
});
window.addEventListener('hashchange', () => { if (location.hash === '#following-sync') openFollowingSync(); });
i18n.bindLanguageSelect($('language-select'));
i18n.onChange(() => {
  const draftThreshold = $('threshold').value;
  i18n.apply(document); render();
  $('threshold').value = draftThreshold;
  if ($('following-sync-dialog').open) renderSyncPreview(syncPreview);
  renderManualUnfollow();
});
Promise.all([i18n.ready, command({type:'GET'})]).then(() => {i18n.apply(document);render();void loadManualUnfollow();if(location.hash==='#following-sync')openFollowingSync();}).catch(e => {i18n.apply(document);render();notify('无法读取本地数据：'+e.message);});
