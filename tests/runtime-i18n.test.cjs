'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../core.js');
async function translator() {
  const context = vm.createContext({navigator: {language: 'en-GB'}, localStorage: {getItem: () => 'en', setItem() {}}});
  for (const file of ['i18n.js', 'messages-runtime.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  await context.XReviewI18n.ready;
  return context.XReviewI18n;
}
test('classification explanations translate without modifying saved account evidence', async () => {
  const I = await translator();
  const now = new Date('2026-09-27T00:00:00Z');
  const evidence = {latestPostAt: '2025-01-01T00:00:00Z', observedAt: now.toISOString(), scope: 'manual'};
  const records = [{handle:'unknown'}, {handle:'keep',status:'keep'}, {handle:'done',status:'reviewed'}, {handle:'old',evidence},
    {handle:'recent',evidence:{...evidence,latestPostAt:now.toISOString()}},
    {handle:'stale',evidence:{...evidence,observedAt:'2026-01-01T00:00:00Z'}},
    {handle:'future',evidence:{...evidence,latestPostAt:'2028-01-01T00:00:00Z'}}];
  const before = JSON.stringify(records);
  for (const record of records) {
    const result = core.classify(record, 180, now);
    assert.doesNotMatch(I.t(result.reason), /\p{Script=Han}/u, result.reason);
  }
  assert.equal(JSON.stringify(records), before);
  await I.setLanguage('zh-CN');
  assert.equal(I.t(core.classify(records[0],180,now).reason),core.classify(records[0],180,now).reason);
});
test('previously stored completion reasons and nested failures render in English', async () => {
  const I = await translator();
  const samples = [
    '关注名单收集结束，已自动移除 3 条未见的本地旧记录，保留 2 条不确定记录。本次加载不保证完整。可在工作台撤销本次移除。',
    '本轮已自动移除 0 条未见的本地旧记录，保留 1 条身份、归属或改动情况不确定的旧记录。 上一轮已执行的移除仍可撤销。',
    '本轮检查已完成：2 个账户获得可用观察，1 个仍为未知，另跳过 4 个已处理或已删除账户。其中 1 个数字 ID 账户按同标签页跳转关联观察，该关联属于导航推断。请回到工作台复核候选。',
    '检查已停止：X 要求登录，已停止本轮自动检查。',
    '本轮本地自动清理失败：自动清理保存失败，原记录与此前已保存的名单已保留。；本次加载不保证名单完整。',
    '@review_owner · 已暂停 · 已保存 42 个账户',
    '活跃度阈值已改变，快速检查结果不再符合近期发帖条件；本轮已停止，请重新开始。',
    '无法核实控制页身份，任务已停止：Context lookup unavailable',
    '无法核实X 检查标签页，任务已停止：No tab with id: 2',
    '检查进度请求已失效，请重新打开控制页后开始。'
  ];
  for (const source of samples) assert.doesNotMatch(I.t(source), /\p{Script=Han}/u, source);
  assert.match(I.t(samples[5]), /@review_owner.*Paused.*42/);
});
test('import diagnostics translate row numbers and nested identity errors', async () => {
  const I = await translator();
  const parsed = core.parseImport('@valid_user\n@not-valid-name\n@valid_user','accounts.txt');
  assert.equal(parsed.records.length, 1);
  for (const source of parsed.warnings) assert.doesNotMatch(I.t(source), /\p{Script=Han}/u, source);
  for (const source of ['账户 ID 必须以完整数字字符串提供。','没有找到有效账户。 请检查文件是否包含关注账户。','第 2 条：日期格式无效，已保留账户并将其视为证据不足。']) {
    assert.doesNotMatch(I.t(source), /\p{Script=Han}/u, source);
  }
});
