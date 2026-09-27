const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../unfollow-watcher.js'), 'utf8');

// Exercise the production watcher with the DOM, timer and message interfaces
// it actually uses. No X requests, browser installation or user data are needed.
class Element {
  constructor(tag, attributes = {}, text = '') {
    Object.assign(this, { tag, attributes, text, children: [], parentElement: null,
      style: {}, listeners: new Map(), rect: { top: 80, bottom: 110, left: 20, right: 220, width: 200, height: 30 } });
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get hidden() { return this.getAttribute('hidden') !== null; }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get textContent() { return [this.text, ...this.children.map(child => child.textContent)].filter(Boolean).join(' '); }
  set textContent(value) {
    const removedNodes = this.children;
    this.text = String(value); this.children = [];
    for (const child of removedNodes) child.parentElement = null;
    this.notifyMutation({ type: 'childList', target: this, addedNodes: [], removedNodes });
  }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) {
    const oldValue = this.getAttribute(name);
    this.attributes[name] = String(value);
    // Browsers enqueue an attribute record even when setAttribute repeats the
    // existing value. Suppressing that write here would conceal render loops.
    this.notifyMutation({ type: 'attributes', target: this, attributeName: name, oldValue });
  }
  removeAttribute(name) {
    const oldValue = this.getAttribute(name);
    delete this.attributes[name];
    if (oldValue !== null) this.notifyMutation({ type: 'attributes', target: this, attributeName: name, oldValue });
  }
  notifyMutation(record) {
    let root = this;
    while (root.parentElement) root = root.parentElement;
    root.fixtureMutation?.(record);
  }
  append(...nodes) {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
    this.notifyMutation({ type: 'childList', target: this, addedNodes: nodes, removedNodes: [] });
  }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter(node => node !== this);
    this.parentElement = null;
    parent?.notifyMutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector) {
    return selector.split(',').some(part => {
      const pieces = part.trim().split(/\s+(?![^\[]*\])/);
      const simple = pieces.pop();
      const match = simple.match(/^([a-z][a-z0-9]*)?(?:\[([a-z-]+)(?:(\^=|\$=|\*=|=)"([^"]*)"(?:\s+(i))?)?\])?$/i);
      assert.ok(match, 'Fixture supports production selector: ' + simple);
      if (match[1] && match[1] !== this.tag) return false;
      if (match[2]) {
        let value = this.getAttribute(match[2]);
        let expected = match[4];
        if (value === null) return false;
        if (match[5]) { value = value.toLowerCase(); expected = expected.toLowerCase(); }
        if (match[3] && !({ '=': () => value === expected, '^=': () => value.startsWith(expected),
          '$=': () => value.endsWith(expected), '*=': () => value.includes(expected) }[match[3]]())) return false;
      }
      return !pieces.length || Boolean(this.parentElement?.closest(pieces.join(' ')));
    });
  }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(node) { return node === this || this.descendants().includes(node); }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [this.rect]; }
  compareDocumentPosition(other) {
    let root = this;
    while (root.parentElement) root = root.parentElement;
    const order = [root, ...root.descendants()];
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
  attachShadow() { this.fixtureShadow = new Element('shadow'); return this.fixtureShadow; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event); }
}

const node = (tag, attributes, text) => new Element(tag, attributes, text);
function harness({ initial = 'following', owner = 'LocalOwner', ownerOffscreen = false, reply, autoMutations = false } = {}) {
  let now = 100000;
  let sequence = 0;
  const intervals = new Map();
  const observers = new Set();
  const messages = [];
  const deliveredMutations = [];
  const document = node('document');
  document.fixtureMutation = record => {
    if (!autoMutations) return;
    for (const observer of observers) {
      const { target, options } = observer;
      if (record.target !== target && (!options.subtree || !target.contains(record.target))) continue;
      if (record.type === 'attributes' && (!options.attributes || (options.attributeFilter && !options.attributeFilter.includes(record.attributeName)))) continue;
      if (record.type === 'childList' && !options.childList) continue;
      observer.records.push(record);
    }
  };
  const html = node('html');
  const body = node('body');
  const main = node('main', { 'data-testid': 'primaryColumn' });
  const name = node('div', { 'data-testid': 'UserName' }, 'Fictional account @FableBirch');
  const button = node('button', { 'data-testid': '123-' + (initial === 'following' ? 'unfollow' : 'follow') }, initial === 'following' ? 'Following' : 'Follow');
  const boundary = node('div', { role: 'tablist' });
  const nav = node('nav');
  const profile = node('a', { 'data-testid': 'AppTabBar_Profile_Link', href: '/' + owner });
  if (ownerOffscreen) profile.rect = { top: 900, bottom: 930, left: 20, right: 220, width: 200, height: 30 };
  nav.append(profile); main.append(name, button, boundary); body.append(nav, main); html.append(body); document.append(html);
  Object.assign(document, { body, documentElement: html, hidden: false,
    createElement: tag => node(tag), getElementById: id => document.descendants().find(item => item.id === id) || null });
  const window = node('window');
  const location = new URL('https://x.com/FableBirch');
  const clone = value => JSON.parse(JSON.stringify(value));
  let context;
  const chrome = {
    runtime: { sendMessage: async message => {
      messages.push({ ...clone(message), proof: clone(context.XReviewUnfollowWatcher.verify()) });
      if (message.type !== 'UNFOLLOW_OBSERVED') return { ok: true };
      const phase = message.phase === 'following' ? 'armed' : 'removed';
      return reply ? reply(message, context.XReviewUnfollowWatcher) : { ok: true, data: { ...message, phase } };
    } },
    storage: { onChanged: { addListener() {} } }
  };
  class Clock extends Date { static now() { return now; } }
  context = vm.createContext({ document, window, location, URL, Element, Date: Clock, chrome,
    innerHeight: 800, innerWidth: 1200, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    getComputedStyle: item => ({ display: item.style.display || 'block', visibility: item.style.visibility || 'visible', opacity: item.style.opacity ?? '1' }),
    setInterval: (callback, delay) => { const id = ++sequence; intervals.set(id, { callback, delay, next: now + delay }); return id; },
    clearInterval: id => intervals.delete(id),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; }
      observe(target, options) { this.target = target; this.options = options; observers.add(this); }
      disconnect() { observers.delete(this); this.records = []; }
    }
  });
  vm.runInContext(source, context);
  const watcher = context.XReviewUnfollowWatcher;
  const flush = async () => {
    let deliveries = 0;
    for (let settled = 0; settled < 12; settled++) {
      await Promise.resolve();
      for (const observer of [...observers]) {
        if (!observer.records.length) continue;
        assert.ok(++deliveries <= 100, 'MutationObserver must yield before 100 consecutive deliveries; an extension render loop would starve profile loading');
        const records = observer.records.splice(0);
        deliveredMutations.push(...records);
        observer.callback(records);
        settled = -1;
      }
    }
  };
  const change = async () => {
    for (const observer of [...observers]) observer.callback([{ type: 'childList', target: main, addedNodes: [], removedNodes: [] }]);
    await flush();
  };
  return {
    watcher, messages, document, main, name, button, boundary, profile, location, change, flush, deliveredMutations,
    start: () => watcher.start({ runId: 'fixture-run', handle: 'FableBirch', id: '123' }),
    state: () => clone(watcher.state()),
    proof: () => clone(watcher.verify()),
    observations: () => messages.filter(message => message.type === 'UNFOLLOW_OBSERVED'),
    panel: () => document.getElementById('x-review-unfollow-panel').fixtureShadow.descendants(),
    async advance(milliseconds) {
      const end = now + milliseconds;
      while (now < end) {
        now = Math.min(end, ...[...intervals.values()].map(timer => timer.next));
        for (const [id, timer] of [...intervals]) {
          if (intervals.has(id) && timer.next <= now) { timer.next += timer.delay; timer.callback(); }
        }
        await flush();
      }
    },
    async setFollowing(following) {
      button.setAttribute('data-testid', '123-' + (following ? 'unfollow' : 'follow'));
      button.textContent = following ? 'Following' : 'Follow';
      await change();
    },
    async click(target, isTrusted = true) { document.dispatch('click', { target, isTrusted }); await flush(); },
    async dialog(handle = 'FableBirch') {
      const dialog = node('div', { role: 'dialog' }, 'Unfollow @' + handle + '?');
      const confirm = node('button', { 'data-testid': 'confirmationSheetConfirm' }, 'Unfollow');
      const cancel = node('button', { 'data-testid': 'confirmationSheetCancel' }, 'Cancel');
      dialog.append(confirm, cancel); body.append(dialog); await change();
      return { dialog, confirm, cancel };
    },
    async confirm() {
      await this.click(button);
      const modal = await this.dialog();
      await this.click(modal.confirm);
      modal.dialog.remove(); await change();
    }
  };
}

test('a trusted native confirmation needs 500 stable milliseconds before reporting removal', async () => {
  const h = harness();
  await h.start();
  assert.equal(h.state().phase, 'armed');
  await h.confirm(); await h.setFollowing(false);
  assert.equal(h.state().phase, 'armed');
  assert.match(h.state().reason, /已观察到取消关注/);
  assert.match(h.panel().find(element => element.className === 'status').textContent, /已观察到取消关注/);
  await h.advance(499);
  assert.deepEqual(h.observations().map(message => message.phase), ['following']);
  await h.advance(1);
  const observed = h.observations();
  assert.deepEqual(observed.map(message => message.phase), ['following', 'confirmed']);
  assert.equal(observed[1].proof.trustedAction, true);
  assert.equal(observed[1].proof.observationKind, 'manual-unfollow');
  assert.equal(observed[1].proof.stableFor, 500);
  assert.equal(h.state().phase, 'removed');
});

test('a short missing profile header and button after native confirmation preserves the action', async () => {
  const h = harness(); await h.start(); await h.confirm();
  h.name.remove(); h.button.remove(); await h.change();
  await h.advance(4750);
  assert.equal(h.observations().length, 1);
  h.main.children.unshift(h.name, h.button); h.name.parentElement = h.main; h.button.parentElement = h.main;
  await h.setFollowing(false); await h.advance(500);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).phase, 'confirmed');
  assert.equal(h.observations().at(-1).proof.trustedAction, true);
});

test('a rendered navigation profile outside the viewport still establishes the viewer', async () => {
  const h = harness({ ownerOffscreen: true }); await h.start();
  assert.equal(h.state().phase, 'armed');
  assert.equal(h.state().viewer, 'localowner');
  await h.confirm(); await h.setFollowing(false); await h.advance(500);
  assert.equal(h.state().phase, 'removed');
});

test('an initial Follow state reconciles only after two stable seconds without claiming a trusted action', async () => {
  const h = harness({ initial: 'follow' }); await h.start();
  await h.advance(1750);
  assert.equal(h.observations().length, 0);
  await h.advance(250);
  assert.equal(h.state().phase, 'removed');
  const observed = h.observations()[0];
  assert.equal(observed.phase, 'reconcile');
  assert.equal(observed.proof.trustedAction, false);
  assert.equal(observed.proof.observationKind, 'already-not-following');
  assert.ok(observed.proof.stableFor >= 2000);
});

test('an ownerless local record stays retained when the backend rejects initial-state reconciliation', async () => {
  const h = harness({ initial: 'follow', reply: async message => ({ ok: true,
    data: { ...message, phase: 'retained', reason: 'Local ownership is unknown; record retained.' } }) });
  await h.start(); await h.advance(2000);
  assert.equal(h.state().phase, 'retained');
  assert.match(h.state().reason, /ownership/);
  assert.equal(h.observations().length, 1);
});

test('a completed unfollow during the arming handshake is reconciled instead of stopping', async () => {
  let release;
  const h = harness({ reply: message => message.phase === 'following'
    ? new Promise(resolve => { release = () => resolve({ ok: true, data: { ...message, phase: 'armed' } }); })
    : Promise.resolve({ ok: true, data: { ...message, phase: 'removed' } }) });
  const started = h.start(); await h.flush();
  assert.equal(typeof release, 'function');
  await h.setFollowing(false); release(); await started;
  await h.advance(2250);
  assert.equal(h.state().phase, 'removed');
  assert.deepEqual(h.observations().map(message => message.phase), ['following', 'reconcile']);
  assert.equal(h.observations().at(-1).proof.trustedAction, false);
});

test('cancelling the native dialog cannot count as a trusted action; a later stable Follow state reconciles', async () => {
  const h = harness(); await h.start(); await h.click(h.button);
  const modal = await h.dialog(); await h.click(modal.cancel);
  modal.dialog.remove(); await h.change(); await h.setFollowing(false); await h.advance(1999);
  assert.equal(h.observations().length, 1);
  assert.notEqual(h.state().phase, 'removed');
  await h.advance(1);
  assert.deepEqual(h.observations().map(message => message.phase), ['following', 'reconcile']);
  assert.equal(h.observations().at(-1).proof.trustedAction, false);
  assert.equal(h.observations().at(-1).proof.observationKind, 'already-not-following');
  assert.equal(h.observations().at(-1).proof.stableFor, 2000);
  assert.equal(h.proof().trustedAction, false);
});

test('synthetic clicks cannot count as a trusted action; a later stable Follow state reconciles', async () => {
  const h = harness(); await h.start(); await h.click(h.button, false);
  const modal = await h.dialog(); await h.click(modal.confirm, false);
  modal.dialog.remove(); await h.change(); await h.setFollowing(false); await h.advance(1999);
  assert.equal(h.observations().length, 1);
  assert.notEqual(h.state().phase, 'removed');
  await h.advance(1);
  assert.deepEqual(h.observations().map(message => message.phase), ['following', 'reconcile']);
  assert.equal(h.observations().at(-1).proof.trustedAction, false);
  assert.equal(h.observations().at(-1).proof.observationKind, 'already-not-following');
  assert.equal(h.observations().at(-1).proof.stableFor, 2000);
  assert.equal(h.proof().trustedAction, false);
});

test('an unrelated confirmation cannot count as a trusted action; a later stable Follow state reconciles', async () => {
  const h = harness(); await h.start(); await h.click(h.button);
  const modal = await h.dialog('TidalFox'); await h.click(modal.confirm);
  modal.dialog.remove(); await h.change(); await h.setFollowing(false); await h.advance(1999);
  assert.equal(h.observations().length, 1);
  assert.notEqual(h.state().phase, 'removed');
  await h.advance(1);
  assert.deepEqual(h.observations().map(message => message.phase), ['following', 'reconcile']);
  assert.equal(h.observations().at(-1).proof.trustedAction, false);
  assert.equal(h.observations().at(-1).proof.observationKind, 'already-not-following');
  assert.equal(h.observations().at(-1).proof.stableFor, 2000);
});

for (const [label, change] of [
  ['route', h => { h.location.pathname = '/TidalFox'; }],
  ['viewer', h => { h.profile.setAttribute('href', '/OtherOwner'); }],
  ['numeric account identity', h => { h.button.setAttribute('data-testid', '456-follow'); }],
  ['profile header identity', h => { h.name.textContent = 'Another profile @TidalFox'; }]
]) {
  test('a conflicting ' + label + ' ends the session without deleting the record', async () => {
    const h = harness(); await h.start(); await h.confirm(); change(h); await h.change(); await h.advance(250);
    assert.equal(h.state().phase, 'stopped');
    assert.equal(h.observations().length, 1);
    assert.ok(h.messages.some(message => message.type === 'UNFOLLOW_WATCH_STOPPED'));
  });
}

for (const [label, pathname] of [
  ['Posts', '/FableBirch'], ['Replies', '/FableBirch/with_replies'],
  ['Reposts', '/FableBirch/reposts'], ['Videos', '/FableBirch/media']
]) {
  test('the same-account ' + label + ' tab supports arming and a verified manual unfollow', async () => {
    const h = harness(); h.location.pathname = pathname;
    await h.start(); assert.equal(h.state().phase, 'armed');
    assert.equal(h.proof().handle, 'fablebirch'); assert.equal(h.proof().id, '123');
    await h.confirm(); await h.setFollowing(false); await h.advance(499);
    assert.deepEqual(h.observations().map(message => message.phase), ['following']);
    await h.advance(1);
    assert.equal(h.state().phase, 'removed');
    assert.deepEqual(h.observations().map(message => message.phase), ['following', 'confirmed']);
    const proof = h.observations().at(-1).proof;
    assert.equal(proof.trustedAction, true); assert.equal(proof.stableFor, 500);
    assert.equal(proof.handle, 'fablebirch'); assert.equal(proof.viewer, 'localowner');
    assert.equal(h.messages.some(message => message.type === 'UNFOLLOW_WATCH_STOPPED'), false);
  });
}

test('armed monitoring survives same-account tab transitions and reconciles Follow on the final tab', async () => {
  const h = harness(); await h.start();
  for (const pathname of ['/FableBirch/with_replies/', '/fablebirch/reposts', '/FableBirch/', '/FableBirch/media/']) {
    h.location.pathname = pathname; h.location.search = '?lang=en'; h.location.hash = '#profile';
    await h.change(); await h.advance(250);
    assert.equal(h.state().phase, 'armed', pathname);
    assert.equal(h.proof().state, 'following', pathname);
    assert.deepEqual(h.observations().map(message => message.phase), ['following'], 'Tab changes do not create a new session');
  }
  await h.setFollowing(false); await h.advance(1999);
  assert.equal(h.observations().length, 1);
  await h.advance(1);
  assert.equal(h.state().phase, 'removed');
  const observed = h.observations().at(-1);
  assert.equal(observed.phase, 'reconcile'); assert.equal(observed.proof.stableFor, 2000);
  assert.equal(observed.proof.trustedAction, false);
  assert.equal(observed.proof.observationKind, 'already-not-following');
  assert.equal(h.messages.some(message => message.type === 'UNFOLLOW_WATCH_STOPPED'), false);
});

test('a same-account tab redraw pauses evidence until its bound profile controls return', async () => {
  const h = harness(); await h.start();
  h.location.pathname = '/FableBirch/media'; h.name.hidden = true; h.button.hidden = true;
  await h.change(); await h.advance(1000);
  assert.equal(h.state().phase, 'armed'); assert.equal(h.proof().state, 'unknown');
  assert.equal(h.observations().length, 1);
  h.name.hidden = false; h.button.hidden = false; await h.change();
  assert.equal(h.state().phase, 'armed'); assert.equal(h.proof().state, 'following');
  await h.confirm(); await h.setFollowing(false); await h.advance(500);
  assert.equal(h.state().phase, 'removed'); assert.equal(h.observations().at(-1).phase, 'confirmed');
});

test('a confirmed Follow observation remains bound to the same account when switching profile tabs', async () => {
  const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false);
  await h.advance(250); h.location.pathname = '/FableBirch/reposts'; await h.change();
  assert.equal(h.state().phase, 'armed'); assert.equal(h.proof().state, 'follow');
  assert.equal(h.proof().trustedAction, true); assert.equal(h.observations().length, 1);
  await h.advance(500);
  assert.equal(h.state().phase, 'removed'); assert.equal(h.observations().at(-1).phase, 'confirmed');
  assert.equal(h.observations().at(-1).proof.id, '123');
});

test('a direct verification after a profile-tab switch resets the complete 500-millisecond stability window', async () => {
  const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false);
  await h.advance(250); assert.equal(h.proof().stableFor, 250);
  h.location.pathname = '/FableBirch/media';
  // The service can request proof before a mutation callback or timer tick.
  const fresh = h.proof();
  assert.equal(fresh.state, 'follow'); assert.equal(fresh.trustedAction, true);
  assert.equal(fresh.stableFor, 0, 'Do not reuse stability from the previous profile tab');
  assert.equal(h.observations().length, 1);
  await h.change(); await h.advance(499);
  assert.equal(h.state().phase, 'armed'); assert.equal(h.observations().length, 1);
  assert.equal(h.proof().stableFor, 499);
  await h.advance(1);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).phase, 'confirmed');
  assert.equal(h.observations().at(-1).proof.stableFor, 500);
});

test('non-profile and foreign-account routes still terminate an armed session without a removal report', async () => {
  for (const pathname of [
    '/TidalFox', '/TidalFox/with_replies', '/TidalFox/reposts', '/TidalFox/media',
    '/FableBirch/following', '/FableBirch/status/123', '/FableBirch/status/123/video/1',
    '/FableBirch/about', '/FableBirch/unknown', '/FableBirch/media/extra', '/FableBirch//media'
  ]) {
    const h = harness(); await h.start(); await h.confirm();
    h.location.pathname = pathname; await h.change(); await h.setFollowing(false); await h.advance(2500);
    assert.equal(h.state().phase, 'stopped', pathname);
    assert.equal(h.proof().trustedAction, false, pathname);
    assert.deepEqual(h.observations().map(message => message.phase), ['following'], pathname);
    assert.equal(h.messages.filter(message => message.type === 'UNFOLLOW_WATCH_STOPPED').length, 1, pathname);
  }
});

test('profile-tab suffixes do not permit a non-X origin, insecure protocol, custom port or URL credentials', async () => {
  for (const url of [
    'https://example.test/FableBirch/media', 'http://x.com/FableBirch/reposts',
    'https://x.com:444/FableBirch/with_replies', 'https://fixture@x.com/FableBirch/media',
    'https://:fixture@x.com/FableBirch/reposts'
  ]) {
    const h = harness(); await h.start(); await h.confirm();
    h.location.href = url; await h.change(); await h.setFollowing(false); await h.advance(2500);
    assert.equal(h.state().phase, 'stopped', url);
    assert.deepEqual(h.observations().map(message => message.phase), ['following'], url);
    assert.equal(h.proof().trustedAction, false, url);
  }
});

test('an unreadable armed page remains recoverable before the existing ten-minute session deadline', async () => {
  const h = harness(); await h.start(); await h.confirm(); h.button.remove(); await h.change();
  await h.advance(31000);
  assert.notEqual(h.state().phase, 'stopped');
  assert.equal(h.proof().trustedAction, false);
  await h.advance(570000);
  assert.equal(h.state().phase, 'stopped');
  assert.ok(h.state().reason);
  assert.equal(h.observations().length, 1);
  assert.ok(h.messages.some(message => message.type === 'UNFOLLOW_WATCH_STOPPED'));
});

test('five full seconds without a profile button expire the trusted action but later Follow can reconcile', async () => {
  const h = harness(); await h.start(); await h.confirm(); h.button.remove(); await h.change();
  await h.advance(5000);
  assert.notEqual(h.state().phase, 'stopped');
  assert.equal(h.proof().trustedAction, false);
  h.main.children.unshift(h.button); h.button.parentElement = h.main;
  await h.setFollowing(false); await h.advance(1999);
  assert.equal(h.observations().length, 1);
  await h.advance(1);
  assert.deepEqual(h.observations().map(message => message.phase), ['following', 'reconcile']);
  assert.equal(h.observations().at(-1).proof.trustedAction, false);
  assert.equal(h.observations().at(-1).proof.stableFor, 2000);
});

test('a brief unknown state resets the complete 500-millisecond evidence window', async () => {
  const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false);
  await h.advance(250);
  h.button.hidden = true; await h.change(); await h.advance(250);
  h.button.hidden = false; await h.change(); await h.advance(499);
  assert.equal(h.observations().length, 1);
  await h.advance(1);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).proof.stableFor, 500);
});

test('initial reconciliation restarts its evidence window after the tab becomes hidden', async () => {
  const h = harness({ initial: 'follow' }); await h.start(); await h.advance(1750);
  h.document.hidden = true; h.document.dispatch('visibilitychange'); await h.advance(1000);
  assert.equal(h.observations().length, 0);
  h.document.hidden = false; h.document.dispatch('visibilitychange'); await h.change(); await h.advance(1750);
  assert.equal(h.observations().length, 0);
  await h.advance(250);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).proof.stableFor, 2000);
});

test('a hidden viewer link cannot authorise reconciliation and unreadable startup eventually stops', async () => {
  const h = harness({ initial: 'follow' }); h.profile.hidden = true; await h.start(); await h.advance(26000);
  assert.equal(h.state().phase, 'stopped');
  assert.equal(h.observations().length, 0);
});

test('a native confirmation remains attributable while X aria-hides the background', async () => {
  const h = harness(); await h.start(); await h.click(h.button);
  const modal = await h.dialog(); h.main.setAttribute('aria-hidden', 'true'); h.profile.setAttribute('aria-hidden', 'true');
  await h.change(); await h.click(modal.confirm);
  modal.dialog.remove(); await h.change(); await h.advance(500);
  h.main.removeAttribute('aria-hidden'); h.profile.removeAttribute('aria-hidden');
  await h.setFollowing(false); await h.advance(500);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).proof.trustedAction, true);
});

test('conflicting rendered viewer links cannot reconcile an initially unfollowed account', async () => {
  const h = harness({ initial: 'follow' });
  h.profile.parentElement.append(node('a', { 'data-testid': 'AppTabBar_Profile_Link', href: '/OtherOwner' }));
  await h.start(); await h.advance(2500);
  assert.equal(h.state().phase, 'stopped');
  assert.equal(h.observations().length, 0);
});

test('re-following during the evidence window prevents the pending local deletion', async () => {
  const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false); await h.advance(250);
  await h.setFollowing(true);
  assert.match(h.state().reason, /恢复为正在关注/);
  await h.advance(5000);
  assert.equal(h.observations().length, 1);
  assert.equal(h.state().phase, 'armed');
  assert.equal(h.proof().stableFor, 0);
  await h.setFollowing(false); await h.advance(499);
  assert.equal(h.observations().length, 1);
  await h.advance(1);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).proof.stableFor, 500);
});

for (const [attribute, value] of [['disabled', ''], ['aria-disabled', 'true'], ['aria-busy', 'true']]) {
  test('initial Follow with ' + attribute + ' waits for two fresh seconds after the control becomes ready', async () => {
    const h = harness({ initial: 'follow' });
    h.button.setAttribute(attribute, value); await h.start(); await h.advance(3000);
    assert.equal(h.observations().length, 0);
    assert.equal(h.proof().state, 'unknown');
    assert.equal(h.proof().stableFor, 0);
    h.button.removeAttribute(attribute); await h.change(); await h.advance(1750);
    assert.equal(h.observations().length, 0);
    await h.advance(250);
    assert.equal(h.state().phase, 'removed');
    assert.equal(h.observations()[0].phase, 'reconcile');
    assert.equal(h.observations()[0].proof.stableFor, 2000);
  });

  test('a briefly ' + attribute + ' control resets trusted confirmation evidence before succeeding', async () => {
    const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false); await h.advance(250);
    h.button.setAttribute(attribute, value); await h.change(); await h.advance(250);
    assert.equal(h.proof().state, 'unknown');
    assert.equal(h.proof().trustedAction, false);
    assert.equal(h.proof().stableFor, 0);
    h.button.removeAttribute(attribute); await h.change(); await h.advance(499);
    assert.equal(h.observations().length, 1);
    await h.advance(1);
    assert.equal(h.state().phase, 'removed');
    assert.equal(h.observations().at(-1).phase, 'confirmed');
    assert.equal(h.observations().at(-1).proof.trustedAction, true);
    assert.equal(h.observations().at(-1).proof.stableFor, 500);
  });
}

const relationshipLabels = {
  English: { following: 'Unfollow @FableBirch', follow: 'Follow @FableBirch', followText: 'Follow', subscription: 'Subscribe to @FableBirch', subscriptionText: 'Subscribe' },
  'Simplified Chinese': { following: '取消关注 @FableBirch', follow: '关注 @FableBirch', followText: '关注', subscription: '订阅 到 @FableBirch', subscriptionText: '订阅' },
  'Traditional Chinese': { following: '取消關注 @FableBirch', follow: '關注 @FableBirch', followText: '關注', subscription: '訂閱 到 @FableBirch', subscriptionText: '訂閱' }
};

// X can render an icon-only relationship button beside a subscription button
// whose misleading numeric test ID ends in "-unfollow". Only the former changes
// the follow relationship; the latter can contribute a bound account ID only.
function subscriptionLayout(h, { locale = 'Simplified Chinese', initial = 'following' } = {}) {
  const labels = relationshipLabels[locale];
  const subscription = node('button', { 'data-testid': '123-unfollow', 'aria-label': labels.subscription }, labels.subscriptionText);
  h.main.append(subscription, h.boundary);
  function relationship(following) {
    h.button.setAttribute('aria-label', following ? labels.following : labels.follow);
    if (following) h.button.removeAttribute('data-testid');
    else h.button.setAttribute('data-testid', '123-follow');
    h.button.textContent = following ? '' : labels.followText;
  }
  relationship(initial === 'following');
  return { subscription, async setFollowing(following) { relationship(following); await h.change(); } };
}

for (const locale of Object.keys(relationshipLabels)) {
  test(locale + ': an icon-only native relationship control survives an unchanged subscription control through unfollow', async () => {
    const h = harness(); const layout = subscriptionLayout(h, { locale });
    await h.start();
    assert.equal(h.state().phase, 'armed');
    assert.equal(h.state().id, '123');
    assert.equal(h.proof().state, 'following');
    assert.equal(h.proof().id, '123');
    await h.confirm(); await layout.setFollowing(false); await h.advance(499);
    assert.deepEqual(h.observations().map(message => message.phase), ['following']);
    await h.advance(1);
    assert.equal(h.state().phase, 'removed');
    assert.deepEqual(h.observations().map(message => message.phase), ['following', 'confirmed']);
    assert.equal(h.observations().at(-1).proof.trustedAction, true);
    assert.equal(h.observations().at(-1).proof.stableFor, 500);
    assert.equal(layout.subscription.getAttribute('data-testid'), '123-unfollow');
    assert.equal(layout.subscription.textContent, relationshipLabels[locale].subscriptionText);
  });

  test(locale + ': an initial native Follow control reconciles beside a subscription with the same numeric ID', async () => {
    const h = harness({ initial: 'follow' }); subscriptionLayout(h, { locale, initial: 'follow' });
    await h.start(); await h.advance(1750);
    assert.equal(h.observations().length, 0);
    await h.advance(250);
    assert.equal(h.state().phase, 'removed');
    assert.equal(h.observations()[0].phase, 'reconcile');
    assert.equal(h.observations()[0].proof.observationKind, 'already-not-following');
    assert.equal(h.observations()[0].proof.trustedAction, false);
    assert.equal(h.observations()[0].proof.id, '123');
  });

  test(locale + ': clicking Subscribe cannot create trusted intent; independent Follow evidence requires reconciliation', async () => {
    const h = harness(); const layout = subscriptionLayout(h, { locale });
    await h.start(); await h.click(layout.subscription);
    // Even an otherwise matching confirmation cannot create intent unless the
    // preceding trusted click came from the real relationship control.
    const modal = await h.dialog(); await h.click(modal.confirm);
    modal.dialog.remove(); await h.change(); await layout.setFollowing(false); await h.advance(1999);
    assert.deepEqual(h.observations().map(message => message.phase), ['following']);
    assert.notEqual(h.state().phase, 'removed');
    assert.equal(h.proof().trustedAction, false);
    await h.advance(1);
    assert.deepEqual(h.observations().map(message => message.phase), ['following', 'reconcile']);
    assert.equal(h.observations().at(-1).proof.trustedAction, false);
    assert.equal(h.observations().at(-1).proof.stableFor, 2000);
  });
}

for (const suffix of ['follow', 'unfollow']) {
  test('a subscription-only ' + suffix + ' test ID cannot arm or reconcile a missing relationship control', async () => {
    const h = harness(); const layout = subscriptionLayout(h);
    h.button.remove(); layout.subscription.setAttribute('data-testid', '123-' + suffix);
    await h.start(); await h.click(layout.subscription); await h.advance(26000);
    assert.equal(h.observations().length, 0);
    assert.equal(h.state().phase, 'stopped');
    assert.equal(h.proof().state, 'unknown');
    assert.equal(h.proof().trustedAction, false);
  });
}

for (const [description, change] of [
  ['another account handle', subscription => subscription.setAttribute('aria-label', '订阅 到 @TidalFox')],
  ['no account-bound accessible label', subscription => subscription.removeAttribute('aria-label')],
  ['an unrecognised accessible label', subscription => subscription.setAttribute('aria-label', 'Something about @FableBirch')],
  ['no numeric account ID', subscription => subscription.removeAttribute('data-testid')]
]) {
  test('an icon-only relationship control cannot borrow identity from a subscription with ' + description, async () => {
    const h = harness(); const layout = subscriptionLayout(h); change(layout.subscription);
    await h.start(); await h.advance(26000);
    assert.equal(h.observations().length, 0);
    assert.notEqual(h.state().phase, 'armed');
    assert.notEqual(h.state().phase, 'removed');
  });
}

for (const initial of ['following', 'follow']) {
  test('a subscription ID contradicting the expected account prevents ' + initial + ' attribution', async () => {
    const h = harness({ initial }); const layout = subscriptionLayout(h, { initial });
    layout.subscription.setAttribute('data-testid', '456-unfollow');
    await h.start(); await h.advance(2500);
    assert.equal(h.state().phase, 'stopped');
    assert.equal(h.observations().length, 0);
  });
}

test('conflicting numeric IDs on two bound subscriptions cannot identify an icon-only native control', async () => {
  const h = harness(); subscriptionLayout(h);
  h.main.append(node('button', { 'data-testid': '456-unfollow', 'aria-label': 'Subscribe to @FableBirch' }, 'Subscribe'), h.boundary);
  await h.start(); await h.advance(2500);
  assert.equal(h.state().phase, 'stopped');
  assert.equal(h.observations().length, 0);
});

for (const [description, change] of [
  ['a mismatched handle', button => button.setAttribute('aria-label', 'Unfollow @TidalFox')]
]) {
  test('a native relationship control with ' + description + ' fails closed despite a valid subscription ID', async () => {
    const h = harness(); subscriptionLayout(h); change(h.button);
    await h.start(); await h.advance(2500);
    assert.equal(h.state().phase, 'stopped');
    assert.equal(h.observations().length, 0);
  });
}

test('a numeric button without a relationship label cannot establish following or authorise reconciliation', async () => {
  for (const initial of ['following', 'follow']) {
    const h = harness({ initial }); h.button.textContent = '';
    await h.start(); await h.advance(26000);
    assert.equal(h.observations().length, 0);
    assert.equal(h.state().phase, 'stopped');
  }
});

for (const label of ['Requested', 'Pending', '已请求', '已請求', '請求中']) {
  test('a pending relationship labelled ' + label + ' cannot reconcile through a numeric follow ID or subscription', async () => {
    const h = harness({ initial: 'follow' }); subscriptionLayout(h, { initial: 'follow' });
    h.button.textContent = label; h.button.setAttribute('aria-label', label + ' @FableBirch');
    await h.start(); await h.advance(26000);
    assert.equal(h.observations().length, 0);
    assert.notEqual(h.state().phase, 'removed');
  });
}

for (const [text, label] of [['Requested', 'Follow @FableBirch'], ['Follow', 'Requested @FableBirch'], ['Follow', 'Cancel follow request @FableBirch']]) {
  test('mixed pending evidence (' + text + ' / ' + label + ') cannot reconcile via stale Follow evidence', async () => {
    const h = harness({ initial: 'follow' }); subscriptionLayout(h, { initial: 'follow' });
    h.button.textContent = text; h.button.setAttribute('aria-label', label);
    await h.start(); await h.advance(26000);
    assert.equal(h.observations().length, 0);
    assert.notEqual(h.state().phase, 'removed');
    assert.equal(h.proof().trustedAction, false);
  });
}

test('mixed pending and Follow evidence cannot complete an otherwise trusted native unfollow', async () => {
  const h = harness(); const layout = subscriptionLayout(h);
  await h.start(); await h.confirm(); await layout.setFollowing(false);
  h.button.textContent = 'Requested'; await h.change(); await h.advance(5500);
  assert.deepEqual(h.observations().map(message => message.phase), ['following']);
  assert.notEqual(h.state().phase, 'removed');
  assert.equal(h.proof().trustedAction, false);
});

for (const [attribute, value] of [['disabled', ''], ['aria-disabled', 'true'], ['aria-busy', 'true']]) {
  test('a ' + attribute + ' icon-only relationship button cannot fall back to an enabled subscription', async () => {
    const h = harness(); const layout = subscriptionLayout(h);
    h.button.setAttribute(attribute, value); await h.start(); await h.advance(3000);
    assert.equal(h.observations().length, 0);
    assert.equal(h.proof().state, 'unknown');
    h.button.removeAttribute(attribute); await h.change();
    assert.equal(h.state().phase, 'armed');
    await h.confirm(); await layout.setFollowing(false); await h.advance(500);
    assert.equal(h.state().phase, 'removed');
  });
}

test('cancelling an icon-only native unfollow permits only later independent two-second reconciliation', async () => {
  const h = harness(); const layout = subscriptionLayout(h);
  await h.start(); await h.click(h.button);
  const modal = await h.dialog(); await h.click(modal.cancel);
  modal.dialog.remove(); await h.change(); await layout.setFollowing(false); await h.advance(1999);
  assert.deepEqual(h.observations().map(message => message.phase), ['following']);
  assert.notEqual(h.state().phase, 'removed');
  assert.equal(h.proof().trustedAction, false);
  await h.advance(1);
  assert.deepEqual(h.observations().map(message => message.phase), ['following', 'reconcile']);
  assert.equal(h.observations().at(-1).proof.trustedAction, false);
});

for (const outcome of ['stopped', 'failed']) {
  test('a terminal ' + outcome + ' panel does not tell the user to keep waiting with the window open', async () => {
    const h = harness({ reply: message => ({ ok: true, data: { ...message, phase: outcome === 'failed' ? 'failed' : 'armed' } }) });
    await h.start();
    if (outcome === 'stopped') h.watcher.stop();
    assert.equal(h.state().phase, outcome);
    const detail = h.panel().find(element => element.className === 'detail');
    const status = h.panel().find(element => element.className === 'status');
    assert.ok(detail.hidden || !/保持窗口打开|keep.*(?:window|open)/i.test(detail.textContent));
    assert.ok(status.textContent);
  });
}


test('observed panel writes yield while a delayed native profile is still loading', async () => {
  const h = harness({ autoMutations: true });
  h.name.remove(); h.button.remove();
  await h.start(); await h.flush();
  assert.equal(h.state().phase, 'watching');
  assert.equal(h.observations().length, 0);
  // Each interval renders the waiting state. Same-value host writes still
  // produce real mutation records, so a self-observer loop fails the budget.
  await h.advance(1000);
  assert.equal(h.state().phase, 'watching');
  h.main.append(h.name, h.button, h.boundary);
  await h.flush();
  assert.equal(h.state().phase, 'armed');
  assert.deepEqual(h.observations().map(message => message.phase), ['following']);
  assert.ok(h.deliveredMutations.some(record => record.type === 'childList' && record.target === h.main));
});

test('same-value observed attributes on the extension panel do not trigger a native-page reread', async () => {
  const h = harness({ autoMutations: true });
  h.name.remove(); h.button.remove();
  await h.start(); await h.flush();
  const host = h.document.getElementById('x-review-unfollow-panel');
  const query = h.document.querySelector.bind(h.document);
  let reads = 0;
  h.document.querySelector = selector => { reads++; return query(selector); };
  const previous = h.deliveredMutations.length;
  host.setAttribute('aria-label', host.getAttribute('aria-label'));
  await h.flush();
  const delivered = h.deliveredMutations.slice(previous);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].target, host);
  assert.equal(delivered[0].attributeName, 'aria-label');
  assert.equal(reads, 0);
  assert.equal(h.state().phase, 'watching');
});

test('a native aria-label-only change is observed immediately despite filtering extension panel mutations', async () => {
  const h = harness({ autoMutations: true }); subscriptionLayout(h);
  await h.start(); await h.flush(); await h.confirm();
  assert.equal(h.button.getAttribute('data-testid'), null);
  assert.equal(h.button.textContent, '');
  const previous = h.deliveredMutations.length;
  h.button.setAttribute('aria-label', '关注 @FableBirch');
  await h.flush();
  assert.ok(h.deliveredMutations.slice(previous).some(record => record.target === h.button && record.attributeName === 'aria-label'));
  await h.advance(499);
  assert.equal(h.proof().stableFor, 499);
  assert.deepEqual(h.observations().map(message => message.phase), ['following']);
  await h.advance(1);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).phase, 'confirmed');
});


test('a hidden tab resets the full 500-millisecond manual evidence window', async () => {
  const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false);
  await h.advance(250);
  h.document.hidden = true; h.document.dispatch('visibilitychange'); await h.advance(1000);
  assert.equal(h.observations().length, 1);
  assert.equal(h.proof().trustedAction, false);
  h.document.hidden = false; h.document.dispatch('visibilitychange'); await h.change();
  await h.advance(499);
  assert.equal(h.observations().length, 1);
  await h.advance(1);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).proof.stableFor, 500);
});

for (const placement of ['timeline tweet', 'recommended user cell', 'navigation', 'after the profile tabs']) {
  test('relationship detection skips geometry for controls in ' + placement, async () => {
    const h = harness();
    const irrelevant = node('button', { 'data-testid': '999-unfollow', 'aria-label': 'Unfollow @TidalFox' }, 'Following');
    irrelevant.getBoundingClientRect = () => { throw new Error('Excluded controls must not force layout measurement'); };
    if (placement === 'after the profile tabs') h.main.append(irrelevant);
    else {
      const container = placement === 'timeline tweet' ? node('article', { 'data-testid': 'tweet' })
        : placement === 'recommended user cell' ? node('div', { 'data-testid': 'UserCell' }) : node('nav');
      container.append(irrelevant); h.main.append(container);
    }
    await h.start();
    assert.equal(h.state().phase, 'armed');
    await h.confirm(); await h.setFollowing(false); await h.advance(500);
    assert.equal(h.state().phase, 'removed');
    assert.deepEqual(h.observations().map(message => message.phase), ['following', 'confirmed']);
    assert.equal(h.observations().at(-1).proof.id, '123');
  });
}


const offscreen = element => { element.rect = {...element.rect,top:-1500,bottom:-1470}; };
function stickyHeader(h,{state='following',id='123',handle='FableBirch',withName=true}={}){
  const header=node('div');
  const name=node('div',{'data-testid':'UserName'},'Fictional account @'+handle);
  const button=node('button',{'data-testid':id+'-'+(state==='following'?'unfollow':'follow'),'aria-label':(state==='following'?'Unfollow':'Follow')+' @'+handle},state==='following'?'Following':'Follow');
  if(withName)header.append(name);
  header.append(button);h.main.append(header,h.boundary);
  return {header,name,button,async setFollowing(following){
    button.setAttribute('data-testid',id+'-'+(following?'unfollow':'follow'));
    button.setAttribute('aria-label',(following?'Unfollow':'Follow')+' @'+handle);
    button.textContent=following?'Following':'Follow';await h.change();
  }};
}
async function confirmFrom(h,button){
  await h.click(button);const modal=await h.dialog();await h.click(modal.confirm);
  modal.dialog.remove();await h.change();
}

for(const initial of ['following','follow']){
  test('rendered offscreen profile identity and '+initial+' control remain readable after scrolling',async()=>{
    const h=harness({initial});offscreen(h.name);offscreen(h.button);await h.start();
    if(initial==='following'){
      assert.equal(h.state().phase,'armed');
      // Scrolling after the manual click must not make the bound profile vanish.
      h.button.rect={...h.button.rect,top:80,bottom:110};await h.confirm();offscreen(h.button);
      await h.setFollowing(false);await h.advance(500);
      assert.equal(h.observations().at(-1).phase,'confirmed');
    }else{
      await h.advance(1999);assert.equal(h.observations().length,0);
      await h.advance(1);assert.equal(h.observations().length,1);assert.equal(h.observations().at(-1).phase,'reconcile');
    }
    assert.equal(h.state().phase,'removed');
  });
}

for(const clicked of ['main','sticky']){
  test('same-target duplicate headers and controls accept a trusted click on the '+clicked+' control',async()=>{
    const h=harness();const sticky=stickyHeader(h);await h.start();
    assert.equal(h.state().phase,'armed');assert.equal(h.proof().id,'123');
    await confirmFrom(h,clicked==='main'?h.button:sticky.button);
    await h.setFollowing(false);await sticky.setFollowing(false);await h.advance(499);
    assert.deepEqual(h.observations().map(message=>message.phase),['following']);
    await h.advance(1);assert.equal(h.state().phase,'removed');
    assert.equal(h.observations().at(-1).phase,'confirmed');
    assert.equal(h.observations().at(-1).proof.trustedAction,true);
  });
}

test('a visible sticky Follow state wins over the old offscreen Following control',async()=>{
  const h=harness();offscreen(h.name);offscreen(h.button);const sticky=stickyHeader(h);await h.start();
  assert.equal(h.state().phase,'armed');await confirmFrom(h,sticky.button);
  await sticky.setFollowing(false);await h.advance(500);
  assert.equal(h.button.textContent,'Following');
  assert.equal(h.state().phase,'removed');assert.equal(h.observations().at(-1).phase,'confirmed');
  assert.equal(h.observations().at(-1).proof.state,'follow');
});

test('contradictory visible relationship states pause evidence and recover without ending the session',async()=>{
  const h=harness();const sticky=stickyHeader(h);await h.start();await h.confirm();
  await h.setFollowing(false);await h.advance(2500);
  assert.equal(h.proof().state,'unknown');assert.notEqual(h.state().phase,'stopped');
  assert.deepEqual(h.observations().map(message=>message.phase),['following']);
  await sticky.setFollowing(false);await h.advance(499);
  assert.equal(h.observations().length,1);await h.advance(1);
  assert.equal(h.state().phase,'removed');assert.equal(h.observations().at(-1).phase,'confirmed');
});

for(const [label,change] of [
  ['opposed visible and accessible labels',button=>{button.textContent='Follow';}],
  ['opposed numeric relationship suffix',button=>{button.setAttribute('data-testid','123-follow');}]
]){
  test('one control with '+label+' pauses until consistent state can be read',async()=>{
    const h=harness();const layout=subscriptionLayout(h);change(h.button);
    await h.start();await h.advance(2500);
    assert.equal(h.proof().state,'unknown');assert.notEqual(h.state().phase,'stopped');
    assert.equal(h.observations().length,0);
    await layout.setFollowing(false);await h.advance(1999);assert.equal(h.observations().length,0);
    await h.advance(1);assert.equal(h.state().phase,'removed');
    assert.equal(h.observations()[0].phase,'reconcile');assert.equal(h.observations()[0].proof.trustedAction,false);
  });
}

test('a previously bound numeric ID cannot replace missing current page ID evidence',async()=>{
  const h=harness();await h.start();await h.confirm();
  h.button.removeAttribute('data-testid');h.button.setAttribute('aria-label','Follow @FableBirch');h.button.textContent='Follow';
  await h.change();await h.advance(3000);
  assert.equal(h.proof().state,'unknown');assert.equal(h.proof().id,'');assert.equal(h.observations().length,1);
  h.button.setAttribute('data-testid','123-follow');await h.change();await h.advance(500);
  assert.equal(h.state().phase,'removed');assert.equal(h.observations().at(-1).proof.id,'123');
});

for(const [label,options] of [['another numeric ID',{id:'456'}],['another handle',{handle:'TidalFox'}]]){
  test('a duplicate header carrying '+label+' is a fatal identity conflict even when offscreen',async()=>{
    const h=harness();const sticky=stickyHeader(h,options);offscreen(sticky.name);offscreen(sticky.button);
    await h.start();await h.advance(2500);
    assert.equal(h.state().phase,'stopped');assert.equal(h.observations().length,0);
  });
}

test('a visible subscription-only sticky header cannot invent a follow relationship',async()=>{
  const h=harness();const layout=subscriptionLayout(h);offscreen(h.name);h.button.remove();
  await h.start();await h.click(layout.subscription);await h.advance(26000);
  assert.equal(h.observations().length,0);assert.equal(h.proof().state,'unknown');
  assert.notEqual(h.state().phase,'removed');
});

test('an armed missed click uses two-second reconciliation without reopening the window',async()=>{
  const h=harness();await h.start();await h.setFollowing(false);await h.advance(1999);
  assert.deepEqual(h.observations().map(message=>message.phase),['following']);
  assert.equal(h.proof().trustedAction,false);await h.advance(1);
  assert.equal(h.state().phase,'removed');
  const observed=h.observations().at(-1);
  assert.equal(observed.phase,'reconcile');assert.equal(observed.proof.observationKind,'already-not-following');
  assert.equal(observed.proof.trustedAction,false);assert.equal(observed.proof.stableFor,2000);
});

test('the armed missed-click fallback retains ownerless data when the service rejects reconciliation',async()=>{
  const h=harness({reply:message=>({ok:true,data:{...message,phase:message.phase==='following'?'armed':'retained',reason:'Local ownership is unknown; record retained.'}})});
  await h.start();await h.setFollowing(false);await h.advance(2000);
  assert.equal(h.state().phase,'retained');assert.deepEqual(h.observations().map(message=>message.phase),['following','reconcile']);
  assert.equal(h.observations().at(-1).proof.trustedAction,false);
});

test('cancelled or synthetic interactions alone never remove a record that still shows Following',async()=>{
  for(const action of ['cancel','synthetic','subscription']){
    const h=harness();const layout=subscriptionLayout(h);await h.start();
    if(action==='subscription')await h.click(layout.subscription);
    else{
      await h.click(h.button,action!=='synthetic');const modal=await h.dialog();
      await h.click(action==='cancel'?modal.cancel:modal.confirm,action!=='synthetic');
      modal.dialog.remove();await h.change();
    }
    await h.advance(3000);assert.equal(h.proof().state,'following');
    assert.deepEqual(h.observations().map(message=>message.phase),['following']);
    assert.notEqual(h.state().phase,'removed');
  }
});

test('a sticky subscription does not override the rendered offscreen native relationship state',async()=>{
  const h=harness();const layout=subscriptionLayout(h);offscreen(h.name);offscreen(h.button);
  await h.start();assert.equal(h.state().phase,'armed');
  await layout.setFollowing(false);await h.advance(1999);
  assert.equal(h.observations().length,1);await h.advance(1);
  assert.equal(layout.subscription.getAttribute('data-testid'),'123-unfollow');
  assert.equal(h.state().phase,'removed');assert.equal(h.observations().at(-1).phase,'reconcile');
  assert.equal(h.observations().at(-1).proof.trustedAction,false);
});

for(const [label,attributes] of [
  ['another numeric ID',{'data-testid':'456-follow','aria-label':'Requested @FableBirch'}],
  ['another addressed handle',{'data-testid':'123-follow','aria-label':'Requested @TidalFox'}]
]){
  test('offscreen pending evidence for '+label+' remains fatal beside a valid visible sticky control',async()=>{
    const h=harness();stickyHeader(h);offscreen(h.name);offscreen(h.button);
    for(const [key,value] of Object.entries(attributes))h.button.setAttribute(key,value);
    h.button.textContent='Requested';await h.start();await h.advance(2500);
    assert.equal(h.state().phase,'stopped');assert.equal(h.observations().length,0);
    assert.equal(h.proof().trustedAction,false);
  });
}

test('a readable Following state restores the ready prompt after a temporary evidence gap',async()=>{
  const h=harness();await h.start();
  h.button.hidden=true;await h.change();await h.advance(750);
  assert.match(h.state().reason,/等待可识别/);
  h.button.hidden=false;await h.change();
  assert.equal(h.state().phase,'armed');assert.equal(h.proof().state,'following');
  assert.match(h.state().reason,/检测已就绪/);
  const status=h.panel().find(element=>element.className==='status').textContent;
  assert.match(status,/检测已就绪/);assert.doesNotMatch(status,/等待可识别/);
  await h.advance(2000);
  assert.deepEqual(h.observations().map(message=>message.phase),['following']);
  assert.equal(h.state().phase,'armed');assert.equal(h.proof().trustedAction,false);
});
