/* X Review: user-started collection of rendered Following rows.
 * No requests, private endpoints, credentials, clicks or account mutations.
 * The fixed delay allows the native page to load after a normal viewport scroll.
 */
(() => {
  'use strict';

  // Reinjecting the script must not replace a live collector or start a new run.
  if (globalThis.XReviewAutoCollector) return;

  const ALLOWED_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  const INTERVAL_MS = 2500;
  const MAX_DURATION_MS = 20 * 60 * 1000;
  const MAX_STEPS = 500;
  const MAX_HANDLES = 10000;
  const PANEL_ID = 'x-review-auto-collector-panel';
  let current = null;

  function followingRoute() {
    if (location.protocol !== 'https:' || !ALLOWED_HOSTS.has(location.hostname) || location.port) return null;
    const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/);
    return match ? { owner: match[1].toLowerCase(), url: location.href } : null;
  }

  function snapshot(run = current) {
    if (!run) return { phase: 'idle', reason: '', stopCode: '', syncResult: null, steps: 0, collected: 0, startedFromTop: false };
    return {
      runId: run.runId, owner: run.owner, phase: run.phase, reason: run.reason,
      stopCode: run.stopCode, startedFromTop: run.startedFromTop,
      syncResult: run.syncResult ? { ...run.syncResult } : null,
      steps: run.steps, collected: run.seen.size, startedAt: run.startedAt,
      updatedAt: run.updatedAt, url: run.url,
      limits: { intervalMs: INTERVAL_MS, maxMinutes: 20, maxSteps: MAX_STEPS, maxAccounts: MAX_HANDLES }
    };
  }

  function isActive(run) {
    return current === run && (run.phase === 'running' || run.phase === 'paused');
  }

  function sameRoute(run) {
    const route = followingRoute();
    return Boolean(route && route.owner === run.owner.toLowerCase() && route.url === run.url);
  }

  function textOf(node) {
    return String(node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function isRendered(node) {
    if (!node || node.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }

  function followingLoading() {
    const root = document.querySelector('main [data-testid="primaryColumn"], main[data-testid="primaryColumn"]');
    return Boolean(root && [...root.querySelectorAll('[role="progressbar"]')].some(node => isRendered(node)
      && !node.closest('[data-testid="UserCell"],nav,[role="navigation"],header,aside')));
  }

  function pageTop() {
    const scrolling = document.scrollingElement || document.documentElement;
    return Math.max(0, window.scrollY || scrolling.scrollTop || 0);
  }

  function blockingMessage() {
    const root = document.querySelector('main [data-testid="primaryColumn"], main[data-testid="primaryColumn"], main');
    const login = document.querySelector('[data-testid="LoginForm_Login_Button"], input[autocomplete="current-password"]');
    if (isRendered(login)) return '页面要求登录；已停止，请在 X 中自行处理后重新开始。';
    const challenge = [...document.querySelectorAll('iframe[src*="arkoselabs"], iframe[title*="challenge"], iframe[title*="Challenge"]')]
      .some(isRendered);
    if (challenge) return '页面出现账户验证；已停止，请在 X 中自行处理。';
    const indicators = root
      ? [...root.querySelectorAll('[role="alert"], [data-testid="error-detail"], [data-testid="emptyState"], [data-testid="retry"], [data-testid="empty_state_header_text"], h1, h2, [role="heading"]')]
        .filter(node => !node.closest('[data-testid="UserCell"]'))
      : [];
    indicators.push(...document.querySelectorAll('[role="dialog"]'));
    const visibleRows = root && [...root.querySelectorAll('[data-testid="UserCell"]')].some(isRendered);
    if (root && !visibleRows && textOf(root).length < 1800) indicators.push(root);
    const text = indicators.filter(isRendered).map(textOf).join(' ');
    if (/rate limit|too many requests|请求过于频繁|请求次数|請求次數|超出.*限制|达到.*上限|達到.*上限|操作频繁|操作頻繁/i.test(text)) {
      return 'X 显示访问或操作限制；已停止，请稍后自行查看页面。';
    }
    if (/verify (?:that )?you(?: are|'re)|prove (?:that )?you|complete (?:the|this) (?:challenge|captcha)|authenticate your account|确认您是|確認您是|验证.*(?:身份|真人)|驗證.*(?:身分|真人)|安全验证|安全驗證/i.test(text)) {
      return '页面出现验证提示；已停止，请在 X 中自行处理。';
    }
    if (/sign in to (?:x|twitter)|log in to (?:x|twitter)|登录以继续|登入以繼續|请先登录|請先登入/i.test(text)) {
      return '页面要求登录；已停止，请在 X 中自行处理后重新开始。';
    }
    if (/something went wrong|try reloading|unable to (?:retrieve|load)|temporarily unavailable|出了[点些]问题|出错了|發生錯誤|发生错误|重新加载|重新載入|暂时无法|暫時無法/i.test(text)) {
      return 'X 页面显示加载错误；已停止，已保存的账户仍然保留。';
    }
    return '';
  }

  const t = value => globalThis.XReviewI18n?.t(value) ?? value;
  globalThis.XReviewI18n?.onChange(() => { if (current) render(current); });

  function createPanel(run) {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();
    const host = document.createElement('aside');
    host.id = PANEL_ID;
    host.setAttribute('aria-label', 'X Review 收集状态');
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:calc(100vw - 36px);';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{color-scheme:light dark}*{box-sizing:border-box}.panel{width:320px;max-width:calc(100vw - 36px);padding:15px 16px;border:1px solid #686868;border-radius:12px;background:#17191b;color:#f5f5f5;font:13px/1.5 system-ui,sans-serif;box-shadow:0 5px 22px #0005}.title{font-weight:650;font-size:14px;margin:0 0 5px}.status{margin:0;color:#e4e4e4;overflow-wrap:anywhere}.detail{margin:7px 0 0;color:#bfc3c6;font-size:12px}.actions{display:flex;gap:8px;margin-top:12px}button{font:inherit;padding:6px 13px;cursor:pointer;color:#f5f5f5;background:#30363b;border:1px solid #747c83;border-radius:6px}button:hover{background:#414a52}button:focus-visible{outline:2px solid #8fcaff;outline-offset:2px}[hidden]{display:none!important}';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const title = document.createElement('p');
    title.className = 'title';
    title.textContent = 'X Review · 关注名单';
    const status = document.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const detail = document.createElement('p');
    detail.className = 'detail';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.textContent = '停止收集';
    stopButton.addEventListener('click', () => { void stopRun(run, '已手动停止，已保存的账户仍然保留。'); });
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '关闭提示';
    closeButton.addEventListener('click', () => { if (run.phase === 'stopped') host.remove(); });
    actions.append(stopButton, closeButton);
    panel.append(title, status, detail, actions);
    shadow.append(style, panel);
    (document.body || document.documentElement).append(host);
    run.panel = { host, title, status, detail, stopButton, closeButton };
    render(run);
  }

  function render(run) {
    run.updatedAt = new Date().toISOString();
    if (!run.panel) return;
    const label = run.phase === 'running' ? '正在收集' : run.phase === 'paused' ? '已暂停' : '已停止';
    run.panel.host.setAttribute('aria-label', t('X Review 收集状态'));
    run.panel.host.setAttribute('lang', globalThis.XReviewI18n?.getLanguage() || 'zh-CN');
    run.panel.title.textContent = t('X Review · 关注名单');
    run.panel.stopButton.textContent = t('停止收集');
    run.panel.closeButton.textContent = t('关闭提示');
    run.panel.status.textContent = t(`@${run.owner} · ${label} · 已保存 ${run.seen.size} 个账户`);
    run.panel.detail.textContent = t(run.reason || '保持此标签页可见；每 2.5 秒滚动一次，只读取已加载的关注条目。');
    run.panel.stopButton.hidden = run.phase === 'stopped';
    run.panel.closeButton.hidden = run.phase !== 'stopped';
  }

  async function send(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply || reply.ok !== true) throw new Error(reply && reply.error || '扩展未确认保存。');
    return reply.data;
  }

  async function report(run) {
    const data = await send({ type: 'SCAN_PROGRESS', runId: run.runId, owner: run.owner,
      phase: run.phase, reason: run.reason, stopCode: run.stopCode, startedFromTop: run.startedFromTop,
      steps: run.steps, collected: run.seen.size });
    acceptRemoteState(run, data);
    return data;
  }

  function acceptRemoteState(run, data) {
    if (!data || !isActive(run)) return;
    if ((data.runId && data.runId !== run.runId) || data.phase === 'stopped') {
      run.phase = 'stopped';
      // Only this page's own verified bottom path can establish bottom-stable.
      run.stopCode = 'interrupted';
      run.reason = data.runId && data.runId !== run.runId
        ? '本次收集已被其他任务替代，已停止滚动。'
        : String(data.reason || '收集任务已停止，已保存的账户仍然保留。');
      detach(run);
      render(run);
    }
  }

  function cancelTimer(run) {
    if (run.timer !== null) clearTimeout(run.timer);
    run.timer = null;
  }

  function detach(run) {
    cancelTimer(run);
    if (run.observer) run.observer.disconnect();
    run.observer = null;
    document.removeEventListener('visibilitychange', run.onVisibility);
    window.removeEventListener('pagehide', run.onPageHide);
    window.removeEventListener('popstate', run.onRouteChange);
    window.removeEventListener('hashchange', run.onRouteChange);
  }

  async function stopRun(run, reason, stopCode = 'interrupted') {
    if (!run) return snapshot(run);
    if (run.phase === 'stopped') return run.stopPromise || snapshot(run);
    run.phase = 'stopped';
    run.stopCode = stopCode;
    run.reason = reason || '已手动停止，已保存的账户仍然保留。';
    detach(run);
    render(run);
    // Repeated stop calls share this final acknowledgement; they must neither
    // submit another synchronisation nor replace the confirmed completion text.
    run.stopPromise = (async () => {
      try {
        const data = await report(run);
        if (run.stopCode === 'bottom-stable') applySyncFeedback(run, data);
      } catch {
        if (run.stopCode === 'bottom-stable') applySyncFeedback(run, null);
      }
      render(run);
      return snapshot(run);
    })();
    return run.stopPromise;
  }

  function applySyncFeedback(run, data) {
    const matching = data && data.runId === run.runId && data.phase === 'stopped'
      && data.stopCode === 'bottom-stable'
      && (!data.owner || String(data.owner).toLowerCase() === run.owner.toLowerCase());
    const result = matching && data.syncResult;
    if (result && result.status === 'applied' && Number.isInteger(result.removed) && result.removed >= 0
      && Number.isInteger(result.retainedCount) && result.retainedCount >= 0
      && typeof result.completedAt === 'string' && Number.isFinite(Date.parse(result.completedAt))
      && (result.undone !== true || (Number.isInteger(result.restored) && result.restored >= 0
        && typeof result.undoneAt === 'string' && Number.isFinite(Date.parse(result.undoneAt))))) {
      run.syncResult = { status: 'applied', removed: result.removed, retainedCount: result.retainedCount,
        completedAt: result.completedAt };
      if (result.undone === true) {
        Object.assign(run.syncResult, { undone: true, restored: result.restored, undoneAt: result.undoneAt });
        run.reason = `本轮自动清理已撤销，恢复 ${result.restored} 条旧本地记录；本次加载不保证名单完整。`;
        return;
      }
      run.reason = result.removed > 0
        ? `本轮自动清理 ${result.removed} 条旧本地记录，可在工作台撤销；本次加载不保证名单完整。`
        : '本轮自动清理 0 条旧本地记录；本次加载不保证名单完整。';
      return;
    }
    if (result && ['failed', 'skipped'].includes(result.status)) {
      const detail = String(result.reason || result.error || result.message || data.reason || '').slice(0, 180);
      run.syncResult = { status: result.status, removed: 0, reason: detail };
      run.reason = (result.status === 'failed' ? '本轮本地自动清理失败' : '本轮未执行本地自动清理')
        + (detail ? `：${detail}` : '。请到工作台检查') + '；本次加载不保证名单完整。';
      return;
    }
    // Missing, stale or malformed replies cannot establish whether a local
    // cleanup committed. The workspace can show its persisted state safely.
    run.syncResult = { status: 'unconfirmed', reason: '未收到有效的本地自动清理结果。' };
    run.reason = '未能确认本轮本地自动清理结果，请到工作台检查；本次加载不保证名单完整。';
  }

  function check(run) {
    if (!isActive(run)) return false;
    if (!sameRoute(run)) {
      void stopRun(run, '页面地址或账户已改变；已停止，请在目标关注列表重新开始。');
      return false;
    }
    if (Date.now() - run.startedMs >= MAX_DURATION_MS) {
      void stopRun(run, '已达到 20 分钟收集时限；本次结果不代表完整关注名单。');
      return false;
    }
    if (run.seen.size >= MAX_HANDLES) {
      void stopRun(run, '已达到本次 10,000 个账户上限；本次结果不代表完整关注名单。');
      return false;
    }
    if (document.hidden) {
      pause(run);
      return false;
    }
    return run.phase === 'running';
  }

  function pause(run) {
    if (!isActive(run) || run.phase === 'paused') return;
    run.phase = 'paused';
    run.reason = '此标签页不可见，已暂停滚动；返回标签页后继续。';
    run.bottomCycles = 0;
    run.stallCycles = 0;
    cancelTimer(run);
    render(run);
    void report(run).catch(() => stopRun(run, '无法更新本地收集状态，已停止。请重新加载扩展后再试。'));
  }

  async function capture(run) {
    if (!check(run)) return { ready: false, handles: '' };
    const blocked = blockingMessage();
    if (blocked) { await stopRun(run, blocked); return { ready: false, handles: '' }; }
    if (typeof globalThis.XReviewReadPage !== 'function') throw new Error('页面读取器不可用。');
    const page = globalThis.XReviewReadPage();
    if (page.kind === 'unsupported' || (page.owner && page.owner.toLowerCase() !== run.owner.toLowerCase())) {
      await stopRun(run, '页面类型或账户无法确认；已停止收集。');
      return { ready: false, handles: '' };
    }
    const ready = page.kind === 'following' && Array.isArray(page.records)
      && !(page.warnings || []).some(warning => /未能识别关注列表区域/.test(warning));
    if (!ready) return { ready: false, handles: '' };
    const batch = new Map();
    const pageHandles = [];
    for (const record of page.records) {
      const handle = String(record.handle || '').replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue;
      const key = handle.toLowerCase();
      pageHandles.push(key);
      if (key === run.owner.toLowerCase() || run.seen.has(key) || batch.has(key)) continue;
      if (run.seen.size + batch.size >= MAX_HANDLES) break;
      batch.set(key, { ...record, handle });
    }
    if (batch.size) {
      // Native viewports normally contain only tens of rows. A large fixture or
      // non-virtualised page is split into the worker's maximum batch size.
      const entries = [...batch.entries()];
      for (let offset = 0; offset < entries.length; offset += 1000) {
        if (!check(run)) return { ready: true, handles: pageHandles.join(',') };
        const part = entries.slice(offset, offset + 1000);
        const data = await send({ type: 'SCAN_BATCH', runId: run.runId, owner: run.owner,
          records: part.map(([, record]) => record), observedAt: page.observedAt, warnings: page.warnings || [],
          steps: run.steps, collected: run.seen.size + part.length });
        // The worker returns its stopped state without saving cancelled batches.
        if (data && ((data.runId && data.runId !== run.runId) || data.phase === 'stopped')) {
          acceptRemoteState(run, data);
          return { ready: true, handles: pageHandles.join(',') };
        }
        // Count only acknowledged batches. Never scroll following an unacknowledged save.
        for (const [key] of part) run.seen.add(key);
        acceptRemoteState(run, data);
        render(run);
        if (run.phase === 'stopped') {
          try { await report(run); } catch { /* Retain accurate local counters. */ }
        }
      }
    }
    return { ready: true, handles: pageHandles.join(',') };
  }

  function viewport(run, handles) {
    const scrolling = document.scrollingElement || document.documentElement;
    const top = pageTop();
    const height = Math.max(scrolling.scrollHeight || 0, document.body ? document.body.scrollHeight : 0);
    return { atBottom: top + window.innerHeight >= height - 5,
      key: `${Math.round(top)}:${height}:${handles}` };
  }

  function schedule(run) {
    cancelTimer(run);
    if (!check(run)) return;
    run.timer = setTimeout(() => {
      run.timer = null;
      void cycle(run);
    }, INTERVAL_MS);
  }

  async function cycle(run) {
    if (!check(run) || run.busy) return;
    run.busy = true;
    try {
      const before = await capture(run);
      if (!check(run)) return;
      if (followingLoading()) {
        // A loading indicator is not an end-of-list signal. Require eight new
        // clear cycles after it disappears, without adding extra scrolling.
        run.bottomCycles = 0;
        run.stallCycles = 0;
        run.unreadCycles = 0;
        run.previousCount = run.seen.size;
        run.previousViewport = '';
        await report(run);
        return;
      }
      if (!before.ready) {
        run.bottomCycles = 0;
        run.stallCycles = 0;
        run.unreadCycles++;
        if (run.unreadCycles >= 8) {
          await stopRun(run, '等待后仍无法识别关注列表；已停止，请确认页面加载完成后重新开始。');
        }
        return;
      }
      run.unreadCycles = 0;
      if (run.needsTopReset) {
        if (!check(run)) return;
        // Confirm an acknowledged, readable capture at the actual page top.
        // Calling scrollTo alone does not prove that the page moved there.
        if (pageTop() <= 5) {
          run.startedFromTop = true;
          run.needsTopReset = false;
        } else {
          run.topResetAttempts++;
          if (run.topResetAttempts >= 3) {
            await stopRun(run, '无法确认已回到关注列表顶部；本次收集已停止，不能用于核对旧名单。');
            return;
          }
          window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        }
        run.previousCount = run.seen.size;
        await report(run);
        return;
      }
      if (run.steps >= MAX_STEPS) {
        await stopRun(run, '已达到本次 500 次滚动上限；本次结果不代表完整关注名单。');
        return;
      }
      const view = viewport(run, before.handles);
      const noNew = run.seen.size === run.previousCount;
      run.bottomCycles = view.atBottom && noNew ? run.bottomCycles + 1 : 0;
      run.stallCycles = noNew && view.key === run.previousViewport ? run.stallCycles + 1 : 0;
      run.previousCount = run.seen.size;
      run.previousViewport = view.key;
      if (run.bottomCycles >= 8) {
        if (run.startedFromTop && run.seen.size > 0) {
          await stopRun(run, '页面底部约 20 秒未加载新账户，正在确认本轮本地名单同步结果；本次加载不保证名单完整。', 'bottom-stable');
        } else {
          await stopRun(run, '页面未提供可保存的关注账户，已停止。本次不能用于核对旧名单，也不代表关注名单为空。');
        }
        return;
      }
      if (run.stallCycles >= 16) {
        await stopRun(run, '页面持续没有滚动或新增账户，已停止。本次结果不代表完整关注名单。');
        return;
      }
      // Check the saved session even when there is no new batch; clearing the
      // workspace or stopping elsewhere must halt before the next scroll.
      await report(run);
      if (!check(run)) return;
      window.scrollBy({ top: Math.max(160, Math.floor(window.innerHeight * 0.8)), left: 0, behavior: 'instant' });
      run.steps++;
      render(run);
      await capture(run);
      if (!check(run)) return;
      await report(run);
    } catch {
      await stopRun(run, '未收到本地保存确认，已停止滚动。请检查扩展状态后重新开始；已确认保存的数据仍然保留。');
    } finally {
      run.busy = false;
      if (isActive(run) && run.phase === 'running') schedule(run);
    }
  }

  function attach(run) {
    run.onVisibility = () => {
      if (!isActive(run)) return;
      if (!sameRoute(run)) {
        void stopRun(run, '页面地址或账户已改变；已停止，请在目标关注列表重新开始。');
        return;
      }
      if (document.hidden) { pause(run); return; }
      if (run.phase === 'paused') {
        run.phase = 'running';
        run.reason = '';
        render(run);
        void report(run).then(() => { if (!run.busy) schedule(run); })
          .catch(() => stopRun(run, '无法更新本地收集状态，已停止。请重新加载扩展后再试。'));
      }
    };
    run.onRouteChange = () => {
      if (isActive(run) && !sameRoute(run)) {
        void stopRun(run, '页面地址或账户已改变；已停止，请在目标关注列表重新开始。');
      }
    };
    run.onPageHide = () => { void stopRun(run, '页面已关闭或重新加载；本次收集已停止。'); };
    document.addEventListener('visibilitychange', run.onVisibility);
    window.addEventListener('pagehide', run.onPageHide);
    window.addEventListener('popstate', run.onRouteChange);
    window.addEventListener('hashchange', run.onRouteChange);
    let lastRouteCheck = 0;
    run.observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastRouteCheck < 200) return;
      lastRouteCheck = now;
      run.onRouteChange();
    });
    run.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function start(options = {}) {
    await globalThis.XReviewI18n?.ready;
    const owner = String(options.owner || '').replace(/^@/, '');
    const runId = String(options.runId || '');
    if (!runId || runId.length > 160 || !/^[A-Za-z0-9_]{1,15}$/.test(owner)) {
      throw new Error('缺少有效收集编号或账户名。');
    }
    if (current && isActive(current)) {
      if (current.runId === runId && current.owner.toLowerCase() === owner.toLowerCase()) return snapshot();
      throw new Error('此页面已有收集任务，请先停止。');
    }
    const route = followingRoute();
    if (!route || route.owner !== owner.toLowerCase()) throw new Error('请打开目标账户的 HTTPS X Following 页面。');
    if (typeof globalThis.XReviewReadPage !== 'function') throw new Error('页面读取器不可用。');
    const now = new Date().toISOString();
    const run = { runId, owner, url: route.url, phase: 'running', reason: '', stopCode: '', syncResult: null, stopPromise: null, steps: 0,
      seen: new Set(), startedAt: now, startedMs: Date.now(), updatedAt: now,
      timer: null, observer: null, busy: true, panel: null, needsTopReset: true, startedFromTop: false, topResetAttempts: 0,
      previousCount: 0, previousViewport: '', bottomCycles: 0, stallCycles: 0, unreadCycles: 0 };
    current = run;
    createPanel(run);
    attach(run);
    try {
      await report(run);
      const first = await capture(run);
      if (check(run)) {
        // Save the current visible rows before resetting to the beginning.
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        run.previousCount = run.seen.size;
        if (!first.ready) run.unreadCycles = 1;
      }
    } catch {
      await stopRun(run, '未收到本地保存确认，已停止。请检查扩展状态后重新开始。');
    } finally {
      run.busy = false;
      if (isActive(run) && run.phase === 'running') schedule(run);
    }
    return snapshot(run);
  }

  globalThis.XReviewAutoCollector = Object.freeze({
    start,
    stop(reason, expectedRunId) {
      if (expectedRunId && current && current.runId !== expectedRunId) return Promise.resolve(snapshot());
      const label = reason && !['user', 'manual', 'stopped'].includes(reason)
        ? String(reason).slice(0, 400) : '已手动停止，已保存的账户仍然保留。';
      return stopRun(current, label);
    },
    state() { return snapshot(); }
  });
})();
