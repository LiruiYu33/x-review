/* Observe a user-performed native X unfollow. This script never activates X controls. */
(() => {
  'use strict';
  if (globalThis.XReviewUnfollowWatcher) return;
  const PANEL_ID = 'x-review-unfollow-panel';
  const EXCLUDED = 'article,[data-testid="tweet"],[data-testid="UserCell"],aside,nav,[role="navigation"],[role="dialog"],[role="alertdialog"],[data-testid="confirmationSheetDialog"]';
  const DIALOGS = '[role="dialog"],[role="alertdialog"],[data-testid="confirmationSheetDialog"]';
  const STABLE_MS = 2000, TRANSIENT_MS = 5000, INTENT_MS = 30000, MAX_MS = 10 * 60 * 1000;
  const t = value => globalThis.XReviewI18n?.t(value) ?? value;
  const handleOf = value => /^[A-Za-z0-9_]{1,15}$/.test(value || '') ? value.toLowerCase() : '';
  const idOf = value => /^\d+$/.test(value || '') ? String(value) : '';
  let current = null;

  function rendered(node) {
    if (!node || node.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0;
  }
  function visible(node) {
    if (!rendered(node)) return false;
    const rect = node.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  }
  const textOf = node => String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  function actionState(value) {
    if (/^(?:unfollow|following|取消关注|取消關注|正在关注|正在關注|已关注|已關注)$/i.test(value)) return 'following';
    if (/^(?:follow|关注|關注)$/i.test(value)) return 'follow';
    return '';
  }
  function controlEvidence(button, handle) {
    const label = String(button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const text = textOf(button), numeric = (button.getAttribute('data-testid') || '').match(/^(\d+)-(unfollow|follow)$/);
    const addressed = label.match(/^(.+?)\s+@([A-Za-z0-9_]{1,15})$/);
    const pending = /^(?:requested|pending|follow request (?:pending|sent)|cancel (?:follow )?request(?: to)?|已请求|已請求|请求中|請求中|取消(?:关注|關注)?请求|取消(?:关注|關注)?請求)$/i;
    // A pending request is not a not-following observation. During redraw X
    // may update visible text before its accessible label (or vice versa).
    if (pending.test(text) || pending.test(addressed ? addressed[1] : label)) {
      return {button, state: '', id: '', conflict: false, pending: true};
    }
    const labelAction = actionState(addressed ? addressed[1] : label), textAction = actionState(text);
    const subscription = /^(?:subscribe(?:d)?(?: to)?|订阅(?: 到| 至)?|訂閱(?: 到| 至)?|已订阅|已訂閱)$/i;
    const subscriptionLabel = subscription.test(addressed ? addressed[1] : label);
    const paid = subscriptionLabel || subscription.test(text);
    const addressedHandle = addressed ? handleOf(addressed[2]) : '';
    // X uses a numeric "-unfollow" test ID on its paid Subscribe button too.
    // It can establish identity only when explicitly addressed to this profile;
    // it can never establish a following relationship or a trusted native action.
    if (paid) return {button, state: '', id: numeric && subscriptionLabel && addressedHandle === handle ? numeric[1] : '',
      conflict: Boolean(labelAction || textAction || (numeric && addressedHandle && addressedHandle !== handle))};
    const state = labelAction || textAction;
    if (!state) return {button, state: '', id: '', conflict: false};
    const suffixState = numeric ? (numeric[2] === 'unfollow' ? 'following' : 'follow') : '';
    return {button, state, id: numeric ? numeric[1] : '', conflict: Boolean(
      (addressedHandle && addressedHandle !== handle) || (labelAction && textAction && labelAction !== textAction)
      || (suffixState && suffixState !== state)),
      // An icon-only control needs an explicit target-bound action label.
      identifiable: Boolean(numeric || (labelAction && addressedHandle === handle))};
  }
  function route() {
    if (location.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(location.hostname) || location.port) return '';
    return handleOf(location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]);
  }
  function viewerEvidence() {
    const handles = [...document.querySelectorAll('[data-testid="AppTabBar_Profile_Link"]')].filter(rendered).map(node => {
      try {
        const url = new URL(node.getAttribute('href'), location.origin);
        return url.origin === location.origin ? handleOf(url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]) : '';
      } catch { return ''; }
    }).filter(Boolean);
    const identities = new Set(handles);
    return {handle: identities.size === 1 ? handles[0] : '', conflict: identities.size > 1};
  }
  const viewer = () => viewerEvidence().handle;
  function blocked() {
    if ([...document.querySelectorAll('[data-testid="LoginForm_Login_Button"],input[autocomplete="current-password"],iframe[src*="arkoselabs"],iframe[title*="challenge" i]')].some(visible)) return true;
    const indicators = [...document.querySelectorAll('main [role="alert"],main [data-testid="error-detail"],main [data-testid="retry"],[data-testid="toast"]')]
      .filter(node => !node.closest('article,[data-testid="tweet"],[data-testid="UserCell"]') && visible(node));
    return indicators.some(node => /error|went wrong|unable|failed|try again|rate limit|too many requests|limit reached|sign in|log in|verify|出错|错误|錯誤|失败|失敗|重试|重試|稍后|稍後|登录|登入|验证|驗證|限制|频繁|頻繁/i.test(textOf(node)));
  }
  function read(run) {
    const handle = route(), identity = viewerEvidence(), owner = identity.handle;
    const unknown = {handle, id: '', viewer: owner, state: 'unknown', button: null, conflict: false};
    const conflict = reason => ({...unknown, conflict: true, reason});
    if (identity.conflict || (owner && run.viewer && owner !== run.viewer)) return conflict('登录账户证据不一致，本地记录未删除。');
    if ((handle && run.targetHandle && handle !== run.targetHandle) || (handle && run.handle && handle !== run.handle)) return conflict('主页地址与目标账户不一致，本地记录未删除。');
    if (!handle || blocked()) return unknown;
    const root = document.querySelector('main [data-testid="primaryColumn"],main[data-testid="primaryColumn"],main');
    if (!root) return unknown;
    const names = [...root.querySelectorAll('[data-testid="UserName"]')].filter(node => !node.closest(EXCLUDED) && visible(node));
    // A single visible profile identity prevents recommendation or stale-page attribution.
    if (names.length !== 1) return names.length > 1 ? conflict('页面显示多个账户标题，本地记录未删除。') : unknown;
    const namedHandles = new Set([...textOf(names[0]).matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)].map(match => match[1].toLowerCase()));
    if (namedHandles.size !== 1 || !namedHandles.has(handle)) return namedHandles.size ? conflict('账户标题与主页地址不一致，本地记录未删除。') : unknown;
    const name = names[0], boundary = root.querySelector('[role="tablist"],article,[data-testid="tweet"]');
    const buttons = [...root.querySelectorAll('button,[role="button"]')].filter(node => {
      if (!visible(node) || node.closest(EXCLUDED)) return false;
      if (boundary && !(node.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const rect = node.getBoundingClientRect(), nameRect = name.getBoundingClientRect();
      return Math.abs(rect.top - nameRect.top) < 600;
    });
    const controls = buttons.map(button => controlEvidence(button, handle));
    if (controls.some(control => control.conflict)) return conflict('关注控件的账户或状态证据不一致，本地记录未删除。');
    if (controls.some(control => control.pending)) return unknown;
    const relations = controls.filter(control => control.state);
    if (relations.length !== 1) return relations.length > 1 ? conflict('页面显示多个关注控件，本地记录未删除。') : unknown;
    const selected = relations[0], button = selected.button;
    if (!selected.identifiable) return unknown;
    // A native request still in progress cannot establish a stable follow state.
    if (button.getAttribute('disabled') !== null || button.getAttribute('aria-disabled') === 'true'
      || button.getAttribute('aria-busy') === 'true') return unknown;
    const ids = new Set(controls.map(control => control.id).filter(Boolean));
    if (ids.size > 1) return conflict('账户数字 ID 证据不一致，本地记录未删除。');
    if (!ids.size) return unknown;
    const id = [...ids][0];
    if ((run.targetId && id !== run.targetId) || (run.id && id !== run.id)) return conflict('账户数字 ID 与本地目标不一致，本地记录未删除。');
    if (!owner) return unknown;
    return {handle, id, viewer: owner, state: selected.state, button};
  }
  function dialogs() { return [...document.querySelectorAll(DIALOGS)].filter(visible); }
  function expectedDialog(run, node) {
    return Boolean(run.intent && node && new RegExp('@' + run.handle + '(?![A-Za-z0-9_])', 'i').test(textOf(node))
      && [...node.querySelectorAll('[data-testid="confirmationSheetConfirm"]')].some(visible));
  }
  function active(run) { return current === run && !['removed', 'retained', 'stopped', 'failed'].includes(run.phase); }
  function snapshot(run = current) {
    return run ? {runId: run.runId, handle: run.handle || run.targetHandle, id: run.id || run.targetId, viewer: run.viewer || '', phase: run.phase, reason: run.reason}
      : {phase: 'idle', reason: ''};
  }
  function clearIntent(run) { run.intent = null; run.followSince = 0; run.unknownSince = 0; }
  function resetReconciliation(run) { run.reconcileSince = 0; }
  function trustedIntent(run) {
    return Boolean(run.intent && Date.now() - run.intent.at <= INTENT_MS
      && (!run.intent.dialogSeen || run.intent.confirmed));
  }
  function verify() {
    const run = current;
    if (!run) return {state: 'unknown', trustedAction: false, stableFor: 0};
    const state = read(run);
    if (state.conflict) { clearIntent(run); run.identityConflict = true; run.identityConflictReason = state.reason; }
    const observable = active(run) && !run.identityConflict && state.state === 'follow' && !document.hidden && !dialogs().length;
    if (!observable) { run.followSince = 0; resetReconciliation(run); }
    const eligible = observable && run.armed && trustedIntent(run) && !run.unknownSince;
    const reconcile = observable && !run.armed && run.reconcileSince > 0;
    return {runId: run.runId, handle: state.handle, id: state.id, viewer: state.viewer, state: state.state,
      observationKind: reconcile ? 'already-not-following' : 'manual-unfollow', trustedAction: Boolean(eligible),
      stableFor: eligible && run.followSince ? Math.max(0, Date.now() - run.followSince)
        : reconcile ? Math.max(0, Date.now() - run.reconcileSince) : 0};
  }
  function detach(run) {
    clearInterval(run.timer); run.observer?.disconnect(); document.removeEventListener('click', run.onClick, true);
    document.removeEventListener('visibilitychange', run.onVisibility); window.removeEventListener('pagehide', run.onPageHide);
  }
  function end(run, phase, reason, notify = true) {
    run.phase = phase; run.reason = reason; detach(run); render(run);
    if (notify && phase === 'stopped') {
      void chrome.runtime.sendMessage({type: 'UNFOLLOW_WATCH_STOPPED', runId: run.runId, reason}).catch(() => {});
    }
    return snapshot(run);
  }
  function render(run) {
    if (!run.panel) return;
    const {host, title, status, detail, close} = run.panel;
    host.setAttribute('lang', globalThis.XReviewI18n?.getLanguage() || 'zh-CN');
    host.setAttribute('aria-label', t('X Review 手动取消关注'));
    title.textContent = t('X Review · 手动取消关注');
    status.textContent = t(run.reason);
    detail.textContent = t(['stopped', 'failed'].includes(run.phase)
      ? '检测已结束，继续等待不会更新记录。请回到工作台重新打开此账户以核实当前状态；无需重新关注。'
      : '等待检测就绪后，在 X 原生页面亲自确认取消关注；若已未关注，将核实当前账户与本地记录后同步。请保持窗口打开，直到显示核实结果。');
    detail.hidden = ['removed', 'retained'].includes(run.phase) || run.reconcileSince > 0;
    close.textContent = t(active(run) ? '停止检测' : '关闭提示');
  }
  function createPanel(run) {
    document.getElementById(PANEL_ID)?.remove();
    const host = document.createElement('aside'); host.id = PANEL_ID;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:calc(100vw - 32px)';
    const shadow = host.attachShadow({mode: 'closed'}), style = document.createElement('style');
    style.textContent = '*{box-sizing:border-box}.panel{width:330px;max-width:calc(100vw - 32px);padding:16px;border:1px solid #666;border-radius:12px;background:#17191b;color:#f4f4f4;font:13px/1.5 system-ui,sans-serif;box-shadow:0 5px 22px #0005}.title{font-weight:650;margin:0 0 8px}.status{margin:0;overflow-wrap:anywhere}.detail{color:#bfc3c6;font-size:12px}button{padding:7px 12px;color:inherit;background:#30363b;border:1px solid #747c83;border-radius:6px;font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #8fcaff;outline-offset:2px}[hidden]{display:none!important}';
    const panel = document.createElement('div'); panel.className = 'panel';
    const title = document.createElement('p'); title.className = 'title';
    const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const detail = document.createElement('p'); detail.className = 'detail';
    const close = document.createElement('button'); close.type = 'button';
    close.addEventListener('click', () => { if (active(run)) end(run, 'stopped', '已停止检测，本地记录未删除。'); else host.remove(); });
    panel.append(title, status, detail, close); shadow.append(style, panel); (document.body || document.documentElement).append(host);
    run.panel = {host, title, status, detail, close}; render(run);
  }
  async function report(run, phase) {
    const reply = await chrome.runtime.sendMessage({type: 'UNFOLLOW_OBSERVED', runId: run.runId, handle: run.handle, id: run.id, viewer: run.viewer, phase});
    if (!reply || reply.ok !== true) throw new Error(reply?.error || '扩展尚未确认保存，本地删除结果未知。');
    const data = reply.data;
    if (!data || data.runId !== run.runId || data.handle !== run.handle || data.id !== run.id || data.viewer !== run.viewer) throw new Error('检测会话不匹配，本地记录未确认删除。');
    return data;
  }
  function clicked(run, event) {
    if (!active(run) || !run.armed || !event.isTrusted || document.hidden || run.busy) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const button = target?.closest('button,[role="button"]');
    const dialog = button?.closest(DIALOGS);
    if (dialog) {
      const owner = viewer();
      if (!run.intent || Date.now() - run.intent.at > INTENT_MS || route() !== run.handle || viewerEvidence().conflict || (owner && owner !== run.viewer) || blocked()) { clearIntent(run); return; }
      // Native modals may aria-hide the background header and navigation. The
      // preceding trusted header click already bound the target and viewer.
      if (button.matches('[data-testid="confirmationSheetConfirm"]') && visible(button) && expectedDialog(run, dialog)) {
        run.intent.dialogSeen = true; run.intent.confirmed = true; run.intent.at = Date.now();
      } else if (button.matches('[data-testid="confirmationSheetCancel"]')) {
        clearIntent(run); run.reason = '操作已取消，本地记录保留。你可以再次手动取消关注。'; render(run);
      }
      return;
    }
    const state = read(run);
    if (state.state === 'unknown') {
      clearIntent(run);
      if (state.conflict) end(run, 'stopped', state.reason || '账户身份发生变化或存在冲突，本地记录未删除。');
      return;
    }
    if (button === state.button && state.state === 'following' && !dialogs().length) {
      run.intent = {at: Date.now(), dialogSeen: false, confirmed: false}; run.followSince = 0; run.unknownSince = 0;
      run.reason = '等待你完成 X 的取消关注操作…'; render(run); return;
    }
  }
  async function tick(run) {
    if (!active(run) || run.busy) return;
    if (run.identityConflict) return end(run, 'stopped', run.identityConflictReason || '账户身份发生变化或存在冲突，本地记录未删除。');
    if (Date.now() - run.startedAt > MAX_MS) return end(run, 'stopped', '检测已超时，本地记录未删除。请从工作台重新打开。');
    if (run.handle && route() !== run.handle) return end(run, 'stopped', '已离开目标账户主页，本地记录未删除。');
    const owner = viewer();
    if (viewerEvidence().conflict) return end(run, 'stopped', '登录账户证据不一致，本地记录未删除。');
    if (run.viewer && owner && owner !== run.viewer) return end(run, 'stopped', '当前登录账户已改变，本地记录未删除。');
    if (blocked()) return end(run, 'stopped', 'X 显示登录、验证或错误提示，本地记录未删除。');
    if (document.hidden) { run.followSince = 0; resetReconciliation(run); return; }
    if (run.intent && Date.now() - run.intent.at > INTENT_MS) clearIntent(run);
    const openDialogs = dialogs();
    if (openDialogs.length) {
      run.followSince = 0; resetReconciliation(run);
      if (run.intent && openDialogs.every(dialog => expectedDialog(run, dialog))) run.intent.dialogSeen = true;
      else clearIntent(run);
      return;
    }
    const state = read(run);
    if (state.state === 'unknown') {
      run.followSince = 0; resetReconciliation(run);
      if (state.conflict) return end(run, 'stopped', state.reason || '账户身份发生变化或存在冲突，本地记录未删除。');
      // X may briefly remove its profile controls while applying the native action.
      // Missing elements pause evidence; contradictory identities invalidate it.
      if (run.armed && trustedIntent(run)) {
        if (!run.unknownSince) run.unknownSince = Date.now();
        if (Date.now() - run.unknownSince >= TRANSIENT_MS) {
          clearIntent(run);
          return end(run, 'stopped', '取消关注后页面状态持续无法识别，本地记录已保留。请从工作台重新打开以核实当前状态。');
        }
      } else clearIntent(run);
      if (!run.armed && Date.now() - run.startedAt > 25000) return end(run, 'stopped', '未能识别账户主页或关注状态，本地记录已保留。请从工作台重新打开。');
      run.reason = '等待可识别的账户主页、登录账户和关注按钮；尚未删除本地记录。'; render(run); return;
    }
    if (run.unknownSince && Date.now() - run.unknownSince >= TRANSIENT_MS) {
      clearIntent(run);
      return end(run, 'stopped', '取消关注后页面状态持续无法识别，本地记录已保留。请从工作台重新打开以核实当前状态。');
    }
    run.unknownSince = 0;
    if (!run.armed) {
      // Pin identity before either initial-state reconciliation or the async arm
      // handshake. A later mismatch must never restart under a different identity.
      run.handle = state.handle; run.id = state.id; run.viewer = state.viewer;
      if (state.state === 'follow') {
        if (!run.reconcileSince) run.reconcileSince = Date.now();
        run.reason = '页面显示已未关注，正在核实账户身份并同步本地记录…'; render(run);
        if (Date.now() - run.reconcileSince < STABLE_MS || Date.now() < run.retryAt) return;
        run.busy = true; run.phase = 'verifying';
        try {
          const data = await report(run, 'reconcile');
          if (!active(run)) return;
          if (data.phase === 'removed') end(run, 'removed', data.reason || '已核实当前未关注，本地记录已移除。现在可以关闭窗口。');
          else if (['retained', 'cancelled', 'failed'].includes(data.phase)) end(run, data.phase === 'retained' ? 'retained' : 'failed', data.reason || '本地记录未删除，请回到工作台检查。');
          else throw new Error('扩展尚未确认保存，本地删除结果未知。');
        } catch (error) {
          if (active(run)) { resetReconciliation(run); run.phase = 'watching'; run.reason = '尚未确认本地更新：' + error.message; run.retryAt = Date.now() + 3000; render(run); }
        } finally { run.busy = false; }
        return;
      }
      resetReconciliation(run);
      if (Date.now() < run.retryAt) return;
      run.busy = true;
      try {
        const data = await report(run, 'following');
        if (!active(run)) return;
        if (data.phase !== 'armed') return end(run, data.phase === 'retained' ? 'retained' : 'failed', data.reason || '检测未能开始，本地记录未删除。');
        const fresh = read(run);
        if (fresh.conflict) return end(run, 'stopped', fresh.reason || '账户身份发生变化或存在冲突，本地记录未删除。');
        if (fresh.state !== 'following' || document.hidden || dialogs().length) {
          run.phase = 'watching'; run.reason = '关注状态在检测准备期间发生变化，正在重新核实当前状态…'; render(run); return;
        }
        run.armed = true; run.phase = 'armed'; run.reason = '检测已就绪，请在 X 页面手动取消关注。'; render(run);
      } catch (error) {
        if (active(run)) { run.reason = '检测未能开始：' + error.message; run.retryAt = Date.now() + 3000; render(run); }
      } finally { run.busy = false; }
      return;
    }
    if (state.state === 'following') {
      run.followSince = 0;
      if (run.intent?.dialogSeen && !run.intent.confirmed) {
        clearIntent(run); run.reason = '操作已取消，本地记录保留。你可以再次手动取消关注。'; render(run);
      }
      return;
    }
    if (!trustedIntent(run)) {
      clearIntent(run);
      return end(run, 'stopped', '页面已显示未关注，但未能完整确认本次操作。本地记录已保留；请从工作台重新打开以核实当前状态。');
    }
    if (!run.followSince) run.followSince = Date.now();
    if (Date.now() - run.followSince < STABLE_MS || Date.now() < run.retryAt) return;
    run.busy = true; run.phase = 'verifying'; run.reason = '已观察到取消关注，正在确认并更新本地记录…'; render(run);
    try {
      const data = await report(run, 'confirmed');
      if (!active(run)) return;
      if (data.phase === 'removed') end(run, 'removed', data.reason || '已确认取消关注，本地记录已移除。现在可以关闭窗口。');
      else if (['retained', 'cancelled', 'failed'].includes(data.phase)) end(run, data.phase === 'retained' ? 'retained' : 'failed', data.reason || '本地记录未删除，请回到工作台检查。');
      else throw new Error('扩展尚未确认保存，本地删除结果未知。');
    } catch (error) {
      if (active(run)) { run.phase = 'armed'; run.reason = '尚未确认本地更新：' + error.message; run.retryAt = Date.now() + 3000; render(run); }
    } finally { run.busy = false; }
  }
  async function start(options = {}) {
    if (current && active(current)) return snapshot(current);
    const targetHandle = handleOf(options.handle), targetId = idOf(options.id);
    if (!options.runId || (!targetHandle && !targetId)) throw new Error('缺少有效的取消关注检测目标。');
    await globalThis.XReviewI18n?.ready;
    const run = {runId: String(options.runId), targetHandle, targetId, handle: '', id: '', viewer: '', phase: 'watching',
      reason: '正在准备取消关注检测…', startedAt: Date.now(), armed: false, intent: null, followSince: 0, unknownSince: 0, reconcileSince: 0, retryAt: 0, busy: false};
    current = run; createPanel(run);
    run.onClick = event => clicked(run, event);
    run.onVisibility = () => { run.followSince = 0; resetReconciliation(run); };
    run.onPageHide = () => { if (active(run)) end(run, 'stopped', '页面已关闭或刷新，本地记录未删除。'); };
    document.addEventListener('click', run.onClick, true); document.addEventListener('visibilitychange', run.onVisibility); window.addEventListener('pagehide', run.onPageHide);
    // Mutation records may contain an entire React subtree. Re-read bounded header selectors only.
    run.observer = new MutationObserver(() => { void tick(run); });
    run.observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['data-testid', 'aria-label', 'hidden', 'aria-hidden', 'disabled', 'aria-disabled', 'aria-busy']});
    run.timer = setInterval(() => { void tick(run); }, 250);
    await tick(run); return snapshot(run);
  }
  globalThis.XReviewI18n?.onChange(() => { if (current) render(current); });
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    const run = current, remote = changes.manualUnfollow?.newValue;
    if (area !== 'local' || !run || !active(run) || remote?.runId !== run.runId) return;
    if (['removed', 'retained', 'cancelled', 'failed'].includes(remote.phase)) {
      end(run, remote.phase === 'cancelled' ? 'stopped' : remote.phase, remote.reason || '本地记录未删除，请回到工作台检查。', false);
    }
  });
  globalThis.XReviewUnfollowWatcher = {start, state: () => snapshot(), verify, stop: () => current ? end(current, 'stopped', '已停止检测，本地记录未删除。') : snapshot()};
})();
