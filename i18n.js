(function (root) {
  'use strict';
  // Reinjected content scripts share one preference listener and dictionary.
  if (root.XReviewI18n) {
    if (typeof module === 'object' && module.exports) module.exports = root.XReviewI18n;
    return;
  }
  const KEY = 'xReviewLanguage';
  const valid = value => value === 'zh-CN' || value === 'en';
  const browserLanguage = root.navigator?.language || 'en';
  let language = /^zh\b/i.test(browserLanguage) ? 'zh-CN' : 'en';
  const exact = new Map(), patterns = new Map(), listeners = new Set(), textSources = new WeakMap();
  let orderedPatterns = [];
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function register(pairs) {
    for (const [source, target] of pairs || []) {
      if (typeof source !== 'string' || typeof target !== 'string') continue;
      const names = [], tokens = [...source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)];
      if (!tokens.length) { exact.set(source, target); continue; }
      let cursor = 0, expression = '^', literalSize = 0;
      for (const token of tokens) {
        const literal = source.slice(cursor, token.index); expression += escape(literal); literalSize += literal.length;
        const existing = names.indexOf(token[1]);
        if (existing < 0) { names.push(token[1]); expression += '([\\s\\S]*?)'; }
        else expression += '\\' + (existing + 1);
        cursor = token.index + token[0].length;
      }
      const tail = source.slice(cursor); literalSize += tail.length; expression += escape(tail) + '$';
      if (literalSize) patterns.set(source, {expression: new RegExp(expression), names, target, literalSize});
    }
    orderedPatterns = [...patterns.values()].sort((a, b) => b.literalSize - a.literalSize);
  }
  function translate(source, depth) {
    if (exact.has(source)) return exact.get(source);
    const whitespace = source.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (whitespace && whitespace[2] !== source && whitespace[2]) {
      return whitespace[1] + translate(whitespace[2], depth + 1) + whitespace[3];
    }
    if (depth > 8) return source;
    for (const item of orderedPatterns) {
      const match = item.expression.exec(source);
      if (!match) continue;
      return item.target.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => {
        const index = item.names.indexOf(name);
        return index < 0 ? token : translate(match[index + 1], depth + 1);
      });
    }
    // Service messages can contain several separately registered sentences.
    const sentences = source.match(/[^。！？\n]+[。！？]?|[。！？]|\n/g) || [];
    if (sentences.length > 1) {
      const translated = sentences.map(part => translate(part, depth + 1));
      return translated.map((part, index) => index && /[.!?]$/.test(translated[index - 1]) && /^\S/.test(part) ? ' ' + part : part).join('');
    }
    return source;
  }
  function t(source, values) {
    let text = source == null ? '' : String(source);
    if (values) text = text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
    return language === 'en' ? translate(text, 0) : text;
  }
  function emit() {
    for (const listener of listeners) { try { listener(language); } catch (error) { root.console?.error('Language listener failed', error); } }
  }
  function change(value) { if (valid(value) && language !== value) { language = value; emit(); } }
  const extensionStorage = root.chrome?.storage?.local;
  const ready = (async () => {
    try {
      const stored = extensionStorage ? (await extensionStorage.get(KEY))?.[KEY] : root.localStorage?.getItem(KEY);
      change(stored);
    } catch { /* A blocked storage context can still use the browser-language default. */ }
    return language;
  })();
  if (extensionStorage && root.chrome?.storage?.onChanged) {
    root.chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) change(changes[KEY].newValue);
    });
  } else if (root.addEventListener) {
    root.addEventListener('storage', event => { if (event.key === KEY) change(event.newValue); });
  }
  async function setLanguage(value) {
    if (!valid(value)) throw new TypeError('Unsupported language');
    await ready;
    // Persist before notifying so a failed write never looks like a saved preference.
    if (extensionStorage) await extensionStorage.set({[KEY]: value});
    else if (root.localStorage) root.localStorage.setItem(KEY, value);
    change(value);
    return language;
  }
  function onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  const translatedAttributes = ['placeholder', 'title', 'aria-label'];
  const selector = '[data-i18n], ' + translatedAttributes.map(name => '[data-i18n-' + name + ']').join(', ');
  function apply(node = root.document) {
    if (!node?.querySelectorAll) return;
    const elements = [...(node.matches?.(selector) ? [node] : []), ...node.querySelectorAll(selector)];
    for (const element of elements) {
      if (element.hasAttribute('data-i18n')) {
        if (element.children?.length) {
          // A labelled container may also hold a count, input or other control.
          for (const child of element.childNodes) {
            if (child.nodeType !== 3) continue;
            if (!textSources.has(child)) textSources.set(child, child.textContent);
            child.textContent = t(textSources.get(child));
          }
        } else {
          let source = element.getAttribute('data-i18n');
          if (!source) { source = element.textContent; element.setAttribute('data-i18n', source); }
          element.textContent = t(source);
        }
      }
      for (const name of translatedAttributes) {
        const key = 'data-i18n-' + name;
        if (!element.hasAttribute(key)) continue;
        let source = element.getAttribute(key);
        if (!source) { source = element.getAttribute(name) || ''; element.setAttribute(key, source); }
        element.setAttribute(name, t(source));
      }
    }
    if (node === root.document) node.documentElement?.setAttribute('lang', language);
  }
  function bindLanguageSelect(select) {
    if (!select) return () => {};
    const update = () => { select.value = language; };
    const unbind = onChange(update); update(); void ready.then(update);
    const handler = () => { void setLanguage(select.value).catch(error => { update(); root.console?.error('Could not save language preference', error); }); };
    select.addEventListener('change', handler);
    return () => { unbind(); select.removeEventListener('change', handler); };
  }
  root.XReviewI18n = {t, register, ready, getLanguage: () => language, getLocale: () => language === 'en' ? 'en-GB' : 'zh-CN', setLanguage, onChange, apply, bindLanguageSelect};
  if (typeof module === 'object' && module.exports) module.exports = root.XReviewI18n;
})(globalThis);
