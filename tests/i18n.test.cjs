'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8');
function boot(options = {}) {
  const values = new Map(Object.entries(options.values || {})), storageEvents = [], changes = [];
  const sandbox = {
    navigator: {language: options.locale || 'en-AU'},
    localStorage: {getItem: key => values.get(key), setItem: (key, value) => {values.set(key, value);}},
    addEventListener: (name, listener) => {if (name === 'storage') storageEvents.push(listener);},
    console, ...options.globals
  };
  if (options.extension) sandbox.chrome = {storage: {
    local: {get: async key => ({[key]: values.get(key)}), set: async object => {
      for (const [key, value] of Object.entries(object)) {values.set(key, value); changes.forEach(listener => listener({[key]: {newValue: value}}, 'local'));}
    }}, onChanged: {addListener: listener => changes.push(listener)}
  }};
  const context = vm.createContext(sandbox); vm.runInContext(source, context);
  return {i18n: context.XReviewI18n, values, storageEvents, changes, context};
}
test('stored language overrides browser default and persists a change', async () => {
  const {i18n, values} = boot({locale: 'en-AU', values: {xReviewLanguage: 'zh-CN'}});
  await i18n.ready; assert.equal(i18n.getLanguage(), 'zh-CN');
  await i18n.setLanguage('en'); assert.equal(values.get('xReviewLanguage'), 'en'); assert.equal(i18n.getLocale(), 'en-GB');
});
test('Chinese browser languages default to Chinese; unsupported preferences are ignored', async () => {
  const {i18n} = boot({locale: 'zh-TW', values: {xReviewLanguage: 'invalid'}});
  await i18n.ready; assert.equal(i18n.getLanguage(), 'zh-CN');
  await assert.rejects(i18n.setLanguage('fr'), /Unsupported/);
});
test('template arguments reorder, repeat, escape regex and support multiline content', async () => {
  const {i18n} = boot(); await i18n.ready;
  i18n.register([['结果 ({count})：{detail}', '{detail}\nTotal: {count}; repeated: {count}'], ['错误', 'Error']]);
  assert.equal(i18n.t('结果 (3)：错误\nother'), 'Error\nother\nTotal: 3; repeated: 3');
  assert.equal(i18n.t('结果 x3x：错误'), '结果 x3x：错误');
  i18n.register([['{account} 对应 {account}', '{account} matches itself']]);
  assert.equal(i18n.t('alice 对应 alice'), 'alice matches itself');
  assert.equal(i18n.t('alice 对应 bob'), 'alice 对应 bob');
});
test('compound service messages translate recognised sentences and preserve unknown values', async () => {
  const {i18n} = boot(); await i18n.ready;
  i18n.register([['已完成。', 'Completed.'], ['可撤销。', 'Undo is available.'], ['失败：{detail}', 'Failed: {detail}'], ['日期错误', 'Invalid date']]);
  assert.equal(i18n.t('已完成。可撤销。'), 'Completed. Undo is available.');
  assert.equal(i18n.t('失败：日期错误'), 'Failed: Invalid date');
  assert.equal(i18n.t('用户自定义名字'), '用户自定义名字');
  assert.equal(i18n.t('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  await i18n.setLanguage('zh-CN'); assert.equal(i18n.t('已完成。'), '已完成。');
});
test('extension storage changes propagate and reinjection keeps one listener', async () => {
  const {i18n, context, changes, values} = boot({extension: true}); await i18n.ready;
  let calls = 0; i18n.onChange(() => calls++);
  await i18n.setLanguage('zh-CN'); assert.equal(values.get('xReviewLanguage'), 'zh-CN'); assert.equal(calls, 1);
  changes[0]({xReviewLanguage: {newValue: 'en'}}, 'local'); assert.equal(i18n.getLanguage(), 'en');
  changes[0]({xReviewLanguage: {newValue: 'zh-CN'}}, 'sync'); assert.equal(i18n.getLanguage(), 'en');
  vm.runInContext(source, context); assert.equal(context.XReviewI18n, i18n); assert.equal(changes.length, 1);
});
test('standalone tabs receive preference changes without a reload', async () => {
  const {i18n, storageEvents} = boot(); await i18n.ready;
  storageEvents[0]({key: 'xReviewLanguage', newValue: 'zh-CN'}); assert.equal(i18n.getLanguage(), 'zh-CN');
});
test('worker and Node environments do not need browser or document globals', async () => {
  const context = vm.createContext({module: {exports: {}}}); vm.runInContext(source, context);
  const i18n = context.module.exports; await i18n.ready;
  i18n.register([['完成', 'Done']]); assert.equal(i18n.t('完成'), 'Done'); assert.doesNotThrow(() => i18n.apply());
});
test('explicit DOM translation preserves nested controls and unannotated content', async () => {
  const {i18n} = boot(); await i18n.ready; i18n.register([['完成', 'Done']]);
  const text = {nodeType: 3, textContent: '完成'}, input = {nodeType: 1, value: 'private'};
  const attributes = new Map([['data-i18n', ''], ['data-i18n-title', '完成']]);
  const element = {children: [input], childNodes: [text, input], hasAttribute: key => attributes.has(key), getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value)};
  const root = {querySelectorAll: () => [element]};
  i18n.apply(root); assert.equal(text.textContent, 'Done'); assert.equal(input.value, 'private'); assert.equal(attributes.get('title'), 'Done');
  await i18n.setLanguage('zh-CN'); i18n.apply(root); assert.equal(text.textContent, '完成');
});
