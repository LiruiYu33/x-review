const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../reader.js'), 'utf8');

// The reader only needs this small, explicit DOM surface. These fixtures run
// the production injection, without adding a browser or third-party dependency.
class Element {
  constructor(tag, attributes = {}, text = '', children = []) {
    Object.assign(this, { tag, attributes, text, children, parentElement: null });
    for (const child of children) child.parentElement = this;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get textContent() { return [this.text, ...this.children.map(child => child.textContent)].filter(Boolean).join(' '); }
  get innerText() { return this.textContent; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector) {
    return selector.split(',').some(part => {
      const match = part.trim().match(/^([a-z][a-z0-9]*)?(?:\[([a-z-]+)(?:(\^?=)"([^"]*)")?\])?$/i);
      if (!match || (match[1] && match[1] !== this.tag)) return false;
      if (!match[2]) return true;
      const value = this.getAttribute(match[2]);
      return value !== null && (!match[3] || (match[3] === '^=' ? value.startsWith(match[4]) : value === match[4]));
    });
  }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(node) { return node === this || this.descendants().includes(node); }
  getClientRects() { return this.closest('[hidden], [aria-hidden="true"]') ? [] : [{}]; }
  compareDocumentPosition(other) {
    let root = this;
    while (root.parentElement) root = root.parentElement;
    const order = [root, ...root.descendants()];
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
}
const node = (tag, attributes = {}, text = '', children = []) => new Element(tag, attributes, text, children);
const link = (handle, text) => node('a', { href: '/' + handle }, text);
const avatar = (handle, destination = handle) => node('div', { 'data-testid': 'UserAvatar-Container-' + handle }, '', [link(destination, '')]);
function row(handle, { mention = [], legacy = false, avatarNode, showHandle = true } = {}) {
  const children = [];
  if (!legacy) children.push(avatarNode || avatar(handle));
  children.push(node('div', {}, '', [link(handle, 'Fictional account'),
    showHandle ? link(handle, '@' + handle) : node('span', {}, '@' + handle)]));
  children.push(node('div', { 'data-testid': 'UserDescription' }, 'Fictional biography', mention.map(value => link(value, '@' + value))));
  return node('div', { 'data-testid': 'UserCell' }, '', children);
}
function read(children, { owner = 'LocalOwner', label = 'Timeline: Following' } = {}) {
  const scope = node('section', { 'aria-label': label }, '', children);
  const root = node('main', { 'data-testid': 'primaryColumn' }, '', [scope]);
  const document = {
    querySelector(selector) {
      assert.equal(selector, 'main [data-testid="primaryColumn"], main[data-testid="primaryColumn"]');
      return root;
    },
    getElementById(id) { return root.descendants().find(value => value.getAttribute('id') === id) || null; }
  };
  const window = { document, location: new URL('https://x.com/' + owner + '/following'),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  const context = vm.createContext({ document, window, URL, Date });
  vm.runInContext(source, context);
  return JSON.parse(JSON.stringify(context.XReviewReadPage()));
}
const handles = result => result.records.map(record => record.handle);

test('avatar identity preserves following rows whose biographies link other accounts', () => {
  const result = read([row('FableBirch', { mention: ['PineStudio', 'TidalFox'] })]);
  assert.deepEqual(handles(result), ['FableBirch']);
  assert.equal(result.records[0].name, 'Fictional account');
  assert.equal(result.records[0].source, 'visible-following');
});

test('a biography profile link before the avatar cannot become the row identity', () => {
  const cell = row('FableBirch', { mention: ['PineStudio'] });
  const earlierMention = link('TidalFox', '@TidalFox');
  earlierMention.parentElement = cell;
  cell.children.unshift(earlierMention);
  assert.deepEqual(handles(read([cell])), ['FableBirch']);
});

test('a mixed fictional list retains every identity rather than dropping mention-bearing rows', () => {
  const cells = Array.from({ length: 178 }, (_, index) => row('Fable' + index,
    { mention: index < 36 ? ['PineStudio'] : [] }));
  const result = read(cells);
  assert.equal(result.records.length, 178);
  assert.equal(new Set(handles(result)).size, 178);
  assert.ok(!handles(result).includes('PineStudio'));
});

test('conflicting avatar suffix and profile destination are rejected', () => {
  assert.deepEqual(handles(read([row('FableBirch', { avatarNode: avatar('FableBirch', 'TidalFox') })])), []);
});

test('conflicting profile destinations inside an avatar are rejected', () => {
  const conflicting = node('div', { 'data-testid': 'UserAvatar-Container-FableBirch' }, '',
    [link('FableBirch', ''), link('TidalFox', '')]);
  assert.deepEqual(handles(read([row('FableBirch', { avatarNode: conflicting })])), []);
});

test('multiple avatar identities are rejected even when one has a matching handle link', () => {
  const cell = row('FableBirch');
  const conflicting = avatar('TidalFox');
  conflicting.parentElement = cell;
  cell.children.push(conflicting);
  assert.deepEqual(handles(read([cell])), []);
});

test('malformed avatar metadata cannot fall back to an otherwise readable row', () => {
  assert.deepEqual(handles(read([row('FableBirch', { avatarNode: avatar('not.valid', 'FableBirch') })])), []);
});

test('avatar-backed identity requires a separate exact displayed handle profile link', () => {
  assert.deepEqual(handles(read([row('FableBirch', { showHandle: false })])), []);
  const cell = row('FableBirch');
  cell.children[1].children[1].text = '@FableBirch and @TidalFox';
  assert.deepEqual(handles(read([cell])), []);
});

test('avatar and displayed handle identity comparisons are case insensitive', () => {
  const cell = row('FableBirch', { avatarNode: avatar('FABLEBIRCH', 'fablebirch') });
  assert.deepEqual(handles(read([cell])), ['FableBirch']);
});

test('legacy layout without avatar metadata preserves the single-candidate fallback', () => {
  assert.deepEqual(handles(read([row('FableBirch', { legacy: true })])), ['FableBirch']);
});

test('legacy layout with actual ambiguous identities is still skipped', () => {
  const result = read([row('FableBirch', { legacy: true, mention: ['TidalFox'] })]);
  assert.deepEqual(handles(result), []);
  assert.ok(result.warnings.some(warning => warning.includes('无法确认身份')));
});

test('recommendation headings and labelled recommendation containers remain excluded', () => {
  assert.deepEqual(handles(read([row('FableBirch'), node('h2', {}, 'Who to follow'), row('TidalFox')])), ['FableBirch']);
  const recommendations = node('div', { 'aria-label': 'Recommended accounts' }, '', [row('TidalFox')]);
  assert.deepEqual(handles(read([row('FableBirch'), recommendations])), ['FableBirch']);
});

test('owner rows, hidden rows and duplicate identities retain their existing handling', () => {
  const hidden = row('TidalFox');
  hidden.attributes.hidden = '';
  assert.deepEqual(handles(read([row('LocalOwner'), row('FableBirch'), row('fablebirch'), hidden])), ['fablebirch']);
});
