'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const I = globalThis.XReviewI18n;
  const t = source => I.t(source);
  let latestNote = null;
  const extension = Boolean(globalThis.chrome?.runtime?.id && chrome.permissions?.request);
  let currentTabId, run = null, ready = false, starting = false, stopping = false;
  let localRunId = null, generation = 0, closed = false, statusBusy = false, pollTimer;
  let delayTimer, delayResolve;
  const running = () => run?.phase === 'running';
  const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;

  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '无法完成此次操作，请重新打开扩展后再试。');
    return result.data;
  }
  function note(source, error = false) {
    latestNote = {source, error};
    $('activity-status').textContent = typeof source === 'function' ? source() : t(source);
    $('activity-status').classList.toggle('error', error);
  }
  function controls() {
    const busy = starting || stopping;
    $('activity-start').disabled = !extension || !ready || busy || running();
    $('activity-stop').disabled = !extension || busy || !running();
    $('activity-mode').disabled = busy || running();
    $('activity-limit').disabled = busy || running();
    $('activity-show-controller').hidden = !running() || run.controllerTabId === currentTabId;
  }
  function cancelDelay() {
    clearTimeout(delayTimer);
    delayTimer = undefined;
    if (delayResolve) { const resolve = delayResolve; delayResolve = undefined; resolve(false); }
  }
  function interruptLoop() {
    generation++;
    localRunId = null;
    cancelDelay();
  }
  function render(next) {
    run = next || null;
    if (localRunId && (!running() || run.runId !== localRunId)) interruptLoop();
    const total = count(run?.total ?? run?.queue?.length);
    const completed = count(run?.completed);
    const skipped = count(run?.skipped);
    const progressed = Math.min(completed + skipped, total);
    $('activity-phase').textContent = t({running: '检查中', stopped: '已停止', complete: '已完成'}[run?.phase] || '未开始');
    $('activity-phase').classList.toggle('recent', running() || run?.phase === 'complete');
    $('activity-total').textContent = run ? t(`${progressed} / ${total} 个账户`) : t('尚未开始');
    $('activity-completed').textContent = String(completed);
    $('activity-read').textContent = String(count(run?.read));
    $('activity-unknown').textContent = String(count(run?.unknown));
    $('activity-current').textContent = running() ? (run.currentLabel || run.currentKey || t('正在准备下一个账户')) : '—';
    $('activity-progress').max = Math.max(1, total);
    $('activity-progress').value = progressed;
    $('activity-skipped').hidden = skipped === 0;
    $('activity-skipped').textContent = t(`已跳过 ${skipped} 个账户；总进度包含跳过项，「已检查」仅计实际检查。`);
    $('activity-results').hidden = !run || running();
    const defaults = {
      running: '正在逐个检查。请保留本页和用于检查的 X 标签页。',
      stopped: '检查已停止，已保存记录会保留。你可以调整范围后再次开始。',
      complete: '本轮检查完成。请到工作台查看候选和仍需核实的账户。'
    };
    note(run ? (run.reason || defaults[run.phase] || '请核对检查状态。') : '准备就绪。点击「开始检查」后才会读取 X 主页。');
    controls();
  }
  function betweenAccounts(token) {
    if (closed || token !== generation) return Promise.resolve(false);
    return new Promise(resolve => {
      delayResolve = resolve;
      delayTimer = setTimeout(() => { delayResolve = undefined; delayTimer = undefined; resolve(true); }, 3000);
    });
  }
  async function drive(runId, token) {
    try {
      while (!closed && token === generation && localRunId === runId) {
        const next = await send({type: 'ACT_NEXT', runId});
        if (closed || token !== generation || localRunId !== runId) return;
        render(next);
        if (!running() || run?.runId !== runId || !(await betweenAccounts(token))) return;
      }
    } catch (error) {
      if (closed || token !== generation) return;
      interruptLoop();
      try { render(await send({type: 'ACT_STOP', runId})); } catch (_) { run = run ? {...run, phase: 'stopped'} : null; controls(); }
      note(() => t('检查已中断：') + t(error.message), true);
    }
  }
  async function refreshStatus() {
    if (!extension || !ready || closed || statusBusy || starting || stopping) return;
    statusBusy = true;
    const token = generation;
    try {
      const next = await send({type: 'ACT_STATUS'});
      if (!closed && !starting && !stopping && token === generation && JSON.stringify(next || null) !== JSON.stringify(run)) render(next);
    } catch (error) { if (!closed) note(() => t('暂时无法读取检查状态：') + t(error.message), true); }
    finally { statusBusy = false; }
  }

  $('activity-start').addEventListener('click', () => {
    if (!extension || !ready || closed || starting || stopping || running()) return;
    const limit = Number($('activity-limit').value);
    const mode = $('activity-mode').value;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) { note('请输入 1–5,000 之间的整数。', true); return; }
    if (!['missing', 'all'].includes(mode)) { note('请选择有效的检查范围。', true); return; }
    // Request optional host access directly in the user's click, before any await.
    let permission;
    try { permission = chrome.permissions.request({origins: ['https://x.com/*']}); }
    catch (error) { note(() => t('无法请求 X 网站访问权限：') + t(error.message), true); return; }
    starting = true;
    generation++;
    controls();
    note('请在浏览器提示中确认是否允许访问 X。');
    Promise.resolve(permission).then(async granted => {
      if (closed) return;
      if (!granted) { note('未授予 X 网站访问权限，检查没有启动。'); return; }
      const next = await send({type: 'ACT_BEGIN', mode, limit});
      if (closed) {
        if (next?.runId && next.controllerTabId === currentTabId) send({type: 'ACT_STOP', runId: next.runId}).catch(() => {});
        return;
      }
      render(next);
      if (running() && next.controllerTabId === currentTabId) {
        localRunId = next.runId;
        const token = generation;
        starting = false;
        controls();
        void drive(next.runId, token);
      }
    }).catch(error => { if (!closed) note(() => t('未能开始检查：') + t(error.message), true); })
      .finally(() => { starting = false; if (!closed) controls(); });
  });
  $('activity-stop').addEventListener('click', async () => {
    if (!extension || stopping || !running()) return;
    const runId = run.runId;
    interruptLoop();
    stopping = true;
    controls();
    note('正在停止，后续账户不会继续检查…');
    try { render(await send({type: 'ACT_STOP', runId})); }
    catch (error) { note(() => t('停止请求未能确认：') + t(error.message) + t('。可关闭用于检查的 X 标签页。'), true); }
    finally { stopping = false; controls(); }
  });
  $('activity-show-controller').addEventListener('click', async () => {
    if (!running() || !Number.isInteger(run.controllerTabId)) return;
    try { await chrome.tabs.update(run.controllerTabId, {active: true}); }
    catch (error) { note('无法打开原控制页，请停止本轮后重新开始。', true); }
  });
  function leavePage() {
    if (closed) return;
    const runId = localRunId || (running() && run.controllerTabId === currentTabId ? run.runId : null);
    closed = true;
    interruptLoop();
    clearInterval(pollTimer);
    if (runId) chrome.runtime.sendMessage({type: 'ACT_STOP', runId}).catch(() => {});
  }
  window.addEventListener('pagehide', leavePage, {once: true});
  window.addEventListener('unload', leavePage, {once: true});
  async function initialise() {
    if (!extension) {
      $('activity-unavailable').hidden = false;
      note('请从浏览器扩展打开自动检查页面。');
      controls();
      return;
    }
    try {
      const tab = await chrome.tabs.getCurrent();
      currentTabId = tab?.id;
      if (!Number.isInteger(currentTabId)) throw new Error('无法识别此控制页，请从扩展重新打开。');
      let next = await send({type: 'ACT_STATUS'});
      const previousOwnRun = next?.phase === 'running' && next.controllerTabId === currentTabId;
      if (previousOwnRun) next = await send({type: 'ACT_STOP', runId: next.runId});
      ready = true;
      render(next);
      if (previousOwnRun) note('控制页已重新加载，上一次检查已停止。请点击「开始检查」重新启动。');
      pollTimer = setInterval(refreshStatus, 1000);
    } catch (error) { note(() => t('无法读取检查状态：') + t(error.message), true); controls(); }
  }
  function localise() {
    I.apply(document);
    const saved = latestNote;
    render(run);
    if (saved) note(saved.source, saved.error);
  }
  I.bindLanguageSelect($('language-select'));
  I.onChange(localise);
  I.ready.then(() => { localise(); void initialise(); });
})();
