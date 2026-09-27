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
  set textContent(value) { this.text = String(value); this.children = []; }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
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
function harness({ initial = 'following', owner = 'LocalOwner', ownerOffscreen = false, reply } = {}) {
  let now = 100000;
  let sequence = 0;
  const intervals = new Map();
  const observers = new Set();
  const messages = [];
  const document = node('document');
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
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    }
  });
  vm.runInContext(source, context);
  const watcher = context.XReviewUnfollowWatcher;
  const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
  const change = async () => { for (const observer of [...observers]) observer.callback([]); await flush(); };
  return {
    watcher, messages, document, main, name, button, boundary, profile, location, change, flush,
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

test('a trusted native confirmation needs two stable seconds before reporting removal', async () => {
  const h = harness();
  await h.start();
  assert.equal(h.state().phase, 'armed');
  await h.confirm(); await h.setFollowing(false);
  await h.advance(1750);
  assert.deepEqual(h.observations().map(message => message.phase), ['following']);
  await h.advance(250);
  const observed = h.observations();
  assert.deepEqual(observed.map(message => message.phase), ['following', 'confirmed']);
  assert.equal(observed[1].proof.trustedAction, true);
  assert.equal(observed[1].proof.observationKind, 'manual-unfollow');
  assert.ok(observed[1].proof.stableFor >= 2000);
  assert.equal(h.state().phase, 'removed');
});

test('a short missing profile header and button after native confirmation preserves the action', async () => {
  const h = harness(); await h.start(); await h.confirm();
  h.name.remove(); h.button.remove(); await h.change();
  await h.advance(4750);
  assert.equal(h.observations().length, 1);
  h.main.children.unshift(h.name, h.button); h.name.parentElement = h.main; h.button.parentElement = h.main;
  await h.setFollowing(false); await h.advance(2000);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).phase, 'confirmed');
  assert.equal(h.observations().at(-1).proof.trustedAction, true);
});

test('a rendered navigation profile outside the viewport still establishes the viewer', async () => {
  const h = harness({ ownerOffscreen: true }); await h.start();
  assert.equal(h.state().phase, 'armed');
  assert.equal(h.state().viewer, 'localowner');
  await h.confirm(); await h.setFollowing(false); await h.advance(2000);
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

test('cancelling the native dialog cannot authorise a later unrelated Follow state', async () => {
  const h = harness(); await h.start(); await h.click(h.button);
  const modal = await h.dialog(); await h.click(modal.cancel);
  modal.dialog.remove(); await h.change(); await h.setFollowing(false); await h.advance(5000);
  assert.equal(h.observations().length, 1);
  assert.notEqual(h.state().phase, 'removed');
  assert.equal(h.proof().trustedAction, false);
});

test('synthetic clicks after arming cannot authorise local removal', async () => {
  const h = harness(); await h.start(); await h.click(h.button, false);
  const modal = await h.dialog(); await h.click(modal.confirm, false);
  modal.dialog.remove(); await h.change(); await h.setFollowing(false); await h.advance(5000);
  assert.equal(h.observations().length, 1);
  assert.notEqual(h.state().phase, 'removed');
  assert.equal(h.proof().trustedAction, false);
});

test('an unrelated confirmation dialog after arming cannot authorise local removal', async () => {
  const h = harness(); await h.start(); await h.click(h.button);
  const modal = await h.dialog('TidalFox'); await h.click(modal.confirm);
  modal.dialog.remove(); await h.change(); await h.setFollowing(false); await h.advance(5000);
  assert.equal(h.observations().length, 1);
  assert.notEqual(h.state().phase, 'removed');
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

test('a persistently unreadable armed page ends with a visible reason rather than waiting indefinitely', async () => {
  const h = harness(); await h.start(); await h.confirm(); h.button.remove(); await h.change();
  await h.advance(31000);
  assert.equal(h.state().phase, 'stopped');
  assert.ok(h.state().reason);
  assert.equal(h.observations().length, 1);
  assert.ok(h.messages.some(message => message.type === 'UNFOLLOW_WATCH_STOPPED'));
});

test('five full seconds without a profile button invalidate the trusted action even if it later returns', async () => {
  const h = harness(); await h.start(); await h.confirm(); h.button.remove(); await h.change();
  await h.advance(5000);
  assert.equal(h.state().phase, 'stopped');
  h.main.children.unshift(h.button); h.button.parentElement = h.main;
  await h.setFollowing(false); await h.advance(2500);
  assert.equal(h.observations().length, 1);
});

test('a brief unknown state resets the complete two-second evidence window', async () => {
  const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false);
  await h.advance(1750);
  h.button.hidden = true; await h.change(); await h.advance(250);
  h.button.hidden = false; await h.change(); await h.advance(1750);
  assert.equal(h.observations().length, 1);
  await h.advance(250);
  assert.equal(h.state().phase, 'removed');
  assert.equal(h.observations().at(-1).proof.stableFor, 2000);
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
  await h.setFollowing(false); await h.advance(2000);
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
  const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false); await h.advance(1750);
  await h.setFollowing(true); await h.advance(5000);
  assert.equal(h.observations().length, 1);
  assert.equal(h.state().phase, 'armed');
  assert.equal(h.proof().stableFor, 0);
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
    const h = harness(); await h.start(); await h.confirm(); await h.setFollowing(false); await h.advance(1750);
    h.button.setAttribute(attribute, value); await h.change(); await h.advance(250);
    assert.equal(h.proof().state, 'unknown');
    assert.equal(h.proof().trustedAction, false);
    assert.equal(h.proof().stableFor, 0);
    h.button.removeAttribute(attribute); await h.change(); await h.advance(1750);
    assert.equal(h.observations().length, 1);
    await h.advance(250);
    assert.equal(h.state().phase, 'removed');
    assert.equal(h.observations().at(-1).phase, 'confirmed');
    assert.equal(h.observations().at(-1).proof.trustedAction, true);
    assert.equal(h.observations().at(-1).proof.stableFor, 2000);
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
    await h.confirm(); await layout.setFollowing(false); await h.advance(1750);
    assert.deepEqual(h.observations().map(message => message.phase), ['following']);
    await h.advance(250);
    assert.equal(h.state().phase, 'removed');
    assert.deepEqual(h.observations().map(message => message.phase), ['following', 'confirmed']);
    assert.equal(h.observations().at(-1).proof.trustedAction, true);
    assert.equal(h.observations().at(-1).proof.stableFor, 2000);
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

  test(locale + ': clicking Subscribe cannot authorise a native relationship change', async () => {
    const h = harness(); const layout = subscriptionLayout(h, { locale });
    await h.start(); await h.click(layout.subscription);
    // Even an otherwise matching confirmation cannot create intent unless the
    // preceding trusted click came from the real relationship control.
    const modal = await h.dialog(); await h.click(modal.confirm);
    modal.dialog.remove(); await h.change(); await layout.setFollowing(false); await h.advance(5000);
    assert.deepEqual(h.observations().map(message => message.phase), ['following']);
    assert.notEqual(h.state().phase, 'removed');
    assert.equal(h.proof().trustedAction, false);
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
  ['a mismatched handle', button => button.setAttribute('aria-label', 'Unfollow @TidalFox')],
  ['opposed visible and accessible labels', button => button.textContent = 'Follow'],
  ['an opposed numeric relation suffix', button => button.setAttribute('data-testid', '123-follow')]
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
    await h.confirm(); await layout.setFollowing(false); await h.advance(2000);
    assert.equal(h.state().phase, 'removed');
  });
}

test('cancelling an icon-only native unfollow retains the record with an adjacent subscription', async () => {
  const h = harness(); const layout = subscriptionLayout(h);
  await h.start(); await h.click(h.button);
  const modal = await h.dialog(); await h.click(modal.cancel);
  modal.dialog.remove(); await h.change(); await layout.setFollowing(false); await h.advance(5000);
  assert.deepEqual(h.observations().map(message => message.phase), ['following']);
  assert.notEqual(h.state().phase, 'removed');
  assert.equal(h.proof().trustedAction, false);
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
