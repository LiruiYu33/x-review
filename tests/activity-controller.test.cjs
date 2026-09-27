'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../activity.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function harness() {
  let now = 0, timerId = 0, current = null, languageChange;
  const timers = new Map(), elements = new Map(), pageEvents = new Map();
  const messages = [], pending = [];
  const schedule = (fn, delay, interval = false) => {
    const id = ++timerId;
    timers.set(id, {fn, due: now + delay, interval: interval ? delay : 0});
    return id;
  };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'activity-mode' ? 'missing' : id === 'activity-limit' ? '3' : '',
      listeners: new Map(), classList: {toggle() {}},
      addEventListener(type, fn) { this.listeners.set(type, fn); }
    });
    return elements.get(id);
  }
  const chrome = {
    permissions: {request: async () => true},
    tabs: {getCurrent: async () => ({id: 7}), update: async () => ({id: 7})},
    runtime: {id: 'test', sendMessage(message) {
      messages.push({...message, at: now});
      if (message.type === 'ACT_BEGIN') current = {
        phase: 'running', runId: 'run-1', controllerTabId: 7,
        total: 3, completed: 0, read: 0, unknown: 0, skipped: 0
      };
      if (message.type === 'ACT_NEXT') return new Promise(resolve => pending.push(resolve));
      if (message.type === 'ACT_STOP') current = {...current, phase: 'stopped'};
      return Promise.resolve({ok: true, data: current});
    }}
  };
  const context = vm.createContext({
    chrome, document: {getElementById: element},
    window: {addEventListener: (type, fn) => pageEvents.set(type, fn)},
    XReviewI18n: {t: value => value, apply() {}, bindLanguageSelect() {},
      onChange: fn => { languageChange = fn; }, ready: Promise.resolve()},
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id)
  });
  vm.runInContext(source, context);
  await flush();
  assert.equal(element('activity-start').disabled, false, 'The controller is ready');
  async function tick(ms) {
    const target = now + ms;
    for (let turns = 0; ; turns++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      assert(turns < 1000, 'Timer processing must settle');
      const [id, timer] = next;
      now = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else timers.delete(id);
      timer.fn();
      await flush();
    }
    now = target;
    await flush();
  }
  return {
    messages, timers, element, tick,
    calls: type => messages.filter(message => message.type === type),
    async click(id) { element(id).listeners.get('click')(); await flush(); },
    async page(type) { pageEvents.get(type)(); await flush(); },
    async language() { languageChange(); await flush(); },
    async finishNext(overrides = {}) {
      assert.equal(pending.length, 1, 'Exactly one account check is in flight');
      current = {...current, completed: current.completed + 1, ...overrides};
      pending.shift()({ok: true, data: current});
      await flush();
    }
  };
}

test('activity checks stay serial and the next account starts after a one-second gap', async () => {
  const h = await harness();
  await h.click('activity-start');
  await h.click('activity-start');
  await h.tick(5000);
  assert.equal(h.calls('ACT_BEGIN').length, 1);
  assert.equal(h.calls('ACT_NEXT').length, 1, 'Polling cannot start overlapping checks');
  await h.finishNext();
  await h.tick(999);
  assert.equal(h.calls('ACT_NEXT').length, 1, 'Do not navigate before the gap expires');
  await h.tick(1);
  assert.deepEqual(h.calls('ACT_NEXT').map(message => message.at), [0, 6000]);
  await h.tick(3000);
  assert.equal(h.calls('ACT_NEXT').length, 2, 'A slow second check remains the only in-flight check');
});

test('stopping during the gap cancels the scheduled next account', async () => {
  const h = await harness();
  await h.click('activity-start');
  await h.finishNext();
  await h.tick(200);
  await h.click('activity-stop');
  await h.tick(5000);
  assert.equal(h.calls('ACT_STOP').length, 1);
  assert.equal(h.calls('ACT_NEXT').length, 1);
  assert.equal(h.element('activity-start').disabled, false);
  assert.equal(h.element('activity-phase').textContent, '已停止');
});

test('leaving the control page cancels the gap, polling and run exactly once', async () => {
  const h = await harness();
  await h.click('activity-start');
  await h.finishNext();
  await h.tick(200);
  await h.page('pagehide');
  await h.page('unload');
  const statusCalls = h.calls('ACT_STATUS').length;
  await h.tick(5000);
  assert.equal(h.calls('ACT_STOP').length, 1);
  assert.equal(h.calls('ACT_NEXT').length, 1);
  assert.equal(h.calls('ACT_STATUS').length, statusCalls);
  assert.equal(h.timers.size, 0);
});

test('completion renders immediately without scheduling another account gap', async () => {
  const h = await harness();
  await h.click('activity-start');
  await h.finishNext({phase: 'complete', total: 1});
  assert.equal(h.element('activity-phase').textContent, '已完成');
  assert.equal(h.element('activity-results').hidden, false);
  assert.equal([...h.timers.values()].filter(timer => !timer.interval).length, 0);
  await h.tick(10000);
  assert.equal(h.calls('ACT_NEXT').length, 1);
});

test('changing language preserves the current check and its pending gap', async () => {
  const h = await harness();
  await h.click('activity-start');
  await h.language();
  assert.equal(h.calls('ACT_NEXT').length, 1);
  await h.finishNext();
  await h.tick(400);
  await h.language();
  await h.tick(599);
  assert.equal(h.calls('ACT_NEXT').length, 1);
  await h.tick(1);
  assert.deepEqual(h.calls('ACT_NEXT').map(message => message.at), [0, 1000]);
  assert.equal(h.calls('ACT_BEGIN').length, 1);
  assert.equal(h.calls('ACT_STOP').length, 0);
});
