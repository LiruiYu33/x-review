/* X Review: reads only content already rendered in the current X tab.
 * This file never fetches, scrolls, clicks, follows, unfollows or changes page DOM.
 * Inject in an extension's isolated world, then call globalThis.XReviewReadPage().
 */
(() => {
  'use strict';

  const ALLOWED_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  const RESERVED_HANDLES = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose',
    'i', 'intent', 'login', 'logout', 'signup', 'account', 'accounts', 'tos',
    'privacy', 'about', 'help', 'download', 'jobs', 'communities', 'premium'
  ]);
  const FOLLOWING_LABEL = /\bfollowing\b|正在关注|正在關注|已关注|已關注|フォロー中|フォローしている/i;
  const RECOMMENDATION_LABEL = /who to follow|you might like|suggested (?:for you|accounts)|recommended|recommendations|你可能喜欢|你可能喜歡|推荐关注|推薦關注|推荐用户|推薦用戶|おすすめ|関連アカウント/i;
  const PINNED_LABEL = /\bpinned\b|置顶|置頂|固定された|固定済み|ピン留め/i;
  const REPOST_LABEL = /\breposted\b|\bretweeted\b|\brepost\b|转帖|轉帖|转推|轉推|转发|轉發|轉貼|リポスト|リツイート/i;

  function textOf(node) {
    return String(node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function normaliseHandle(value) {
    const handle = String(value || '').replace(/^@/, '');
    return /^[A-Za-z0-9_]{1,15}$/.test(handle) && !RESERVED_HANDLES.has(handle.toLowerCase())
      ? handle : null;
  }

  function parseXLink(href, base) {
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return null;
      return url;
    } catch {
      return null;
    }
  }

  function handleFromProfileLink(href, base) {
    const url = parseXLink(href, base);
    const match = url && url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    return match ? normaliseHandle(match[1]) : null;
  }

  function statusFromLink(href, base) {
    const url = parseXLink(href, base);
    const match = url && url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]+)\/?$/);
    const handle = match && normaliseHandle(match[1]);
    return handle ? { handle, id: match[2] } : null;
  }

  function handlesInText(text) {
    return [...String(text).matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)]
      .map(match => normaliseHandle(match[1])).filter(Boolean);
  }

  function labelFor(node, doc) {
    const label = node.getAttribute('aria-label') || '';
    const references = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return [label, ...references.map(id => textOf(doc.getElementById(id)))].join(' ').trim();
  }

  function isRendered(node, win) {
    if (!node || node.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = win.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }

  function ownAuthorBlock(article) {
    const block = article.querySelector('[data-testid="User-Name"]');
    return block && block.closest('article') === article ? block : null;
  }

  function nameBeforeHandle(node, handle) {
    const text = textOf(node);
    const at = text.toLowerCase().indexOf('@' + handle.toLowerCase());
    return (at >= 0 ? text.slice(0, at).trim() : text).slice(0, 160) || handle;
  }

  function followingIdentity(cell, links, displayedHandles) {
    const avatars = [...cell.querySelectorAll('[data-testid^="UserAvatar-Container-"]')];
    if (avatars.length) {
      // Biography mentions are valid profile links too. Establish the row's
      // identity from its avatar, then corroborate it with a separate @handle
      // link, instead of treating every mention as a second account identity.
      const identities = [];
      for (const avatar of avatars) {
        const suffix = avatar.getAttribute('data-testid').slice('UserAvatar-Container-'.length);
        const handle = normaliseHandle(suffix);
        const keys = [...new Set(links.filter(link => avatar.contains(link.anchor))
          .map(link => link.handle.toLowerCase()))];
        if (!handle || keys.length !== 1 || keys[0] !== handle.toLowerCase()) return null;
        identities.push(keys[0]);
      }
      const keys = [...new Set(identities)];
      if (keys.length !== 1) return null;
      const key = keys[0];
      const confirmation = links.find(link => link.handle.toLowerCase() === key
        && !avatars.some(avatar => avatar.contains(link.anchor))
        && textOf(link.anchor).toLowerCase() === '@' + key);
      return confirmation ? { key, handle: textOf(confirmation.anchor).slice(1) } : null;
    }
    // Older page layouts without avatar identity metadata retain the previous
    // conservative rule; an ambiguous legacy row must still be skipped.
    const candidates = [...new Set(links.filter(link => displayedHandles.some(handle =>
      handle.toLowerCase() === link.handle.toLowerCase())).map(link => link.handle.toLowerCase()))];
    if (candidates.length !== 1) return null;
    const key = candidates[0];
    return { key, handle: displayedHandles.find(handle => handle.toLowerCase() === key) };
  }

  function readFollowing(root, owner, observedAt, doc, win) {
    const warnings = [];
    const possibleScopes = [...root.querySelectorAll('[aria-label], section[aria-labelledby], [role="region"]')]
      .filter(node => node.querySelector('[data-testid="UserCell"]'));
    let scopes = possibleScopes.filter(node => {
      const label = labelFor(node, doc);
      return FOLLOWING_LABEL.test(label) && !RECOMMENDATION_LABEL.test(label);
    });
    if (!scopes.length) {
      return {
        kind: 'following', owner, records: [], observedAt,
        warnings: ['未能识别关注列表区域；请打开自己的 Following 页面并等待列表加载。未读取推荐账户。']
      };
    }
    // Keep the smallest matching scopes so a broad labelled container cannot
    // accidentally include an unrelated recommendations section.
    scopes = scopes.filter(scope => !scopes.some(other => scope !== other && scope.contains(other)));
    const records = new Map();
    let skipped = 0;
    for (const scope of scopes) {
      const recommendationHeadings = [...scope.querySelectorAll('h1,h2,h3,[role="heading"]')]
        .filter(node => RECOMMENDATION_LABEL.test(textOf(node)));
      const cells = [...scope.querySelectorAll('[data-testid="UserCell"]')];
      for (const cell of cells) {
        if (!isRendered(cell, win)) continue;
        // A recommendation heading marks the end of trustworthy following data.
        // DOM order is used instead of localisation-sensitive layout offsets.
        if (recommendationHeadings.some(heading =>
          heading.contains(cell) || Boolean(heading.compareDocumentPosition(cell) & 4))) {
          skipped++;
          continue;
        }
        let ancestor = cell.parentElement;
        let insideRecommendations = false;
        while (ancestor && ancestor !== scope) {
          if (RECOMMENDATION_LABEL.test(labelFor(ancestor, doc))) {
            insideRecommendations = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        if (insideRecommendations) { skipped++; continue; }
        const links = [...cell.querySelectorAll('a[href]')].map(anchor => ({
          anchor, handle: handleFromProfileLink(anchor.getAttribute('href'), win.location.href)
        })).filter(link => link.handle);
        const displayedHandles = handlesInText(textOf(cell));
        const identity = followingIdentity(cell, links, displayedHandles);
        if (!identity) { skipped++; continue; }
        const { key, handle } = identity;
        if (key === owner.toLowerCase()) continue;
        const matchingLinks = links.filter(link => link.handle.toLowerCase() === key);
        const nameLink = matchingLinks.find(link => textOf(link.anchor) && !textOf(link.anchor).startsWith('@'));
        const name = nameLink ? textOf(nameLink.anchor).slice(0, 160) : handle;
        records.set(key, { handle, name, source: 'visible-following' });
      }
    }
    if (skipped) warnings.push('已跳过推荐区域或无法确认身份的账户条目。');
    warnings.push('只包含本次页面已加载的关注条目，并非完整关注名单；本工具不会自动滚动。');
    return { kind: 'following', owner, records: [...records.values()], observedAt, warnings };
  }

  function readProfile(root, handle, observedAt, doc, win) {
    const warnings = [];
    const header = root.querySelector('[data-testid="UserName"]');
    const headerMatches = header && handlesInText(textOf(header)).some(value => value.toLowerCase() === handle.toLowerCase());
    const headerVisible = header && isRendered(header, win) && header.getBoundingClientRect().bottom > 0;
    const profileAtTop = Boolean(headerMatches && headerVisible && Math.max(0, win.scrollY || 0) < 350);
    const evidence = {
      observedAt, latestPostAt: null, sampleCount: 0, scope: 'profile-posts',
      hasUncertainReposts: false, profileAtTop
    };
    const record = { handle, name: headerMatches ? nameBeforeHandle(header, handle) : handle,
      source: 'visible-profile', evidence };
    if (!headerMatches) {
      warnings.push('未能确认账户主页身份；页面可能仍在加载、需要登录或不可访问。活跃度未知。');
      return { kind: 'profile', record, warnings };
    }
    if (!profileAtTop) warnings.push('当前不在主页顶部，无法确认是否遗漏较新的帖子；本次结果不能用于判定低活跃。');
    const seenRegularStatusIds = new Set();
    const articles = [...root.querySelectorAll('article[data-testid="tweet"], article[role="article"]')]
      .filter(article => isRendered(article, win) && !article.parentElement.closest('article'));
    const recommendationHeadings = [...root.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .filter(node => RECOMMENDATION_LABEL.test(textOf(node)));
    let invalidDates = 0;
    let foreignPosts = 0;
    let ambiguousPosts = 0;
    let pinnedPosts = 0;
    for (const article of articles) {
      if (recommendationHeadings.some(heading => Boolean(heading.compareDocumentPosition(article) & 4))) continue;
      const context = article.querySelector('[data-testid="socialContext"]');
      let isPinned = false;
      if (context) {
        const contextText = [textOf(context), context.getAttribute('aria-label') || ''].join(' ');
        if (PINNED_LABEL.test(contextText)) { pinnedPosts++; isPinned = true; }
        else {
          // A repost exposes the original post's date, never the repost event date.
          // Unknown contexts are also excluded, because they may be localised reposts.
          evidence.hasUncertainReposts = true;
          if (!REPOST_LABEL.test(contextText)) ambiguousPosts++;
          continue;
        }
      }
      const author = ownAuthorBlock(article);
      if (!author) { ambiguousPosts++; evidence.hasUncertainReposts = true; continue; }
      const authorHandles = [...author.querySelectorAll('a[href]')]
        .map(anchor => handleFromProfileLink(anchor.getAttribute('href'), win.location.href)).filter(Boolean);
      const uniqueAuthors = [...new Set(authorHandles.map(value => value.toLowerCase()))];
      if (uniqueAuthors.length !== 1) { ambiguousPosts++; evidence.hasUncertainReposts = true; continue; }
      if (uniqueAuthors[0] !== handle.toLowerCase()) {
        foreignPosts++;
        evidence.hasUncertainReposts = true;
        continue;
      }
      // Only the top author block supplies timestamps. Quoted posts elsewhere
      // inside an article cannot supply a date for the account being reviewed.
      let dateFound = false;
      for (const time of author.querySelectorAll('time[datetime]')) {
        const anchor = time.closest('a[href]');
        if (!anchor || !author.contains(anchor)) continue;
        const status = statusFromLink(anchor.getAttribute('href'), win.location.href);
        if (!status || status.handle.toLowerCase() !== handle.toLowerCase()) continue;
        const date = new Date(time.getAttribute('datetime'));
        if (!Number.isFinite(date.getTime()) || date.getTime() > Date.parse(observedAt) + 300000) { invalidDates++; continue; }
        dateFound = true;
        // A recent pinned self-post is valid positive activity evidence, but
        // an old pinned post alone cannot establish that the normal timeline is old.
        if (!isPinned && !seenRegularStatusIds.has(status.id)) {
          seenRegularStatusIds.add(status.id);
          evidence.sampleCount++;
        }
        const isoDate = date.toISOString();
        if (!evidence.latestPostAt || isoDate > evidence.latestPostAt) evidence.latestPostAt = isoDate;
      }
      if (!dateFound) { ambiguousPosts++; evidence.hasUncertainReposts = true; }
    }
    if (evidence.hasUncertainReposts) warnings.push('存在转帖、其他作者内容或无法识别的帖子；原帖日期不等于转帖日期，不能据此判定账户低活跃。');
    if (!evidence.sampleCount) warnings.push('没有读到可确认日期的普通自发帖子；受保护、空白、加载失败等情况均记为未知。');
    if (invalidDates) warnings.push('已忽略无效或异常的帖子日期。');
    if (pinnedPosts) warnings.push('置顶帖的有效日期可用于确认近期发帖，但其显示位置不代表发帖顺序；仅有旧置顶帖不能列为候选。');
    if (ambiguousPosts || foreignPosts) warnings.push('已跳过无法明确归属于本账户的帖子或时间信息。');
    warnings.push('只反映本次已加载的 Posts 样本，不包含登录、阅读、私密活动或完整回复历史。');
    return { kind: 'profile', record, warnings };
  }

  globalThis.XReviewReadPage = function XReviewReadPage() {
    const observedAt = new Date().toISOString();
    const win = window;
    const doc = document;
    if (win.location.protocol !== 'https:' || !ALLOWED_HOSTS.has(win.location.hostname)) {
      return { kind: 'unsupported', observedAt, warnings: ['仅支持 HTTPS 的 X / Twitter 原生网页。'] };
    }
    const parts = win.location.pathname.split('/').filter(Boolean);
    const handle = normaliseHandle(parts[0]);
    if (!handle || parts.length > 2 || (parts.length === 2 && parts[1] !== 'following')) {
      return { kind: 'unsupported', observedAt, warnings: ['请打开 /账户名/following 关注列表，或 /账户名 的 Posts 主页；Replies、Media、搜索和单条帖子页不用于此筛选。'] };
    }
    const root = doc.querySelector('main [data-testid="primaryColumn"], main[data-testid="primaryColumn"]');
    if (!root) return { kind: 'unavailable', observedAt, warnings: ['未找到 X 主内容区域；请等待页面加载完成后再读取。'] };
    return parts.length === 2
      ? readFollowing(root, handle, observedAt, doc, win)
      : readProfile(root, handle, observedAt, doc, win);
  };
})();
