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
  attachShadow() { return new Element('shadow'); }
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
  const button = node('button', { 'data-testid': '123-' + (initial === 'following' ? 'unfollow' : 'follow') });
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
    async setFollowing(following) { button.setAttribute('data-testid', '123-' + (following ? 'unfollow' : 'follow')); await change(); },
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
