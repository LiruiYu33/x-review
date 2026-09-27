/* Read-only readiness checks for a native X profile opened by the user-started
 * activity review. No requests, clicks, scrolling or page changes are made.
 */
(() => {
  'use strict';

  const HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'search', 'settings',
    'compose', 'i', 'intent', 'login', 'logout', 'signup', 'account', 'accounts', 'tos',
    'privacy', 'about', 'help', 'download', 'jobs', 'communities', 'premium']);
  const USER_CONTENT = 'article,[data-testid="tweet"],[data-testid="UserDescription"],[data-testid="UserCell"],[data-testid="UserName"],[data-testid="User-Name"],[data-testid="UserProfileHeader_Items"],[data-testid="UserUrl"]';
  const INDICATORS = '[role="alert"],[data-testid="error-detail"],[data-testid="retry"],[data-testid="emptyState"],[data-testid="empty_state_header_text"],h1,h2,h3,[role="heading"]';
  const REPOST = /\breposted\b|\bretweeted\b|\brepost\b|转帖|轉帖|转推|轉推|转发|轉發|轉貼|リポスト|リツイート/i;

  function textOf(node) {
    return String(node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function isRendered(node) {
    if (!node || node.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }

  function profileHandle() {
    if (location.protocol !== 'https:' || !HOSTS.has(location.hostname) || location.port) return null;
    const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    return match && !RESERVED.has(match[1].toLowerCase()) ? match[1] : null;
  }

  function visibleUITexts(root) {
    const nodes = root ? [...root.querySelectorAll(INDICATORS)] : [];
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      nodes.push(dialog, ...dialog.querySelectorAll(INDICATORS));
    }
    return [...new Set(nodes)].filter(node => isRendered(node)
      && !node.closest(USER_CONTENT) && !node.querySelector(USER_CONTENT)).map(textOf);
  }

  function blockReason(root) {
    if (/^\/(?:i\/flow\/(?:login|signup)|account\/access|login)(?:\/|$)/.test(location.pathname)) {
      return 'X 要求登录或账户验证，已停止本轮自动检查。';
    }
    const login = [...document.querySelectorAll('[data-testid="LoginForm_Login_Button"],input[autocomplete="current-password"]')]
      .some(isRendered);
    if (login) return 'X 要求登录，已停止本轮自动检查。';
    const challenge = [...document.querySelectorAll('iframe[src*="arkoselabs"],iframe[title*="challenge"],iframe[title*="Challenge"]')]
      .some(isRendered);
    if (challenge) return 'X 要求完成验证，已停止本轮自动检查。';
    const text = visibleUITexts(root).join(' ');
    if (/rate limit|too many requests|请求过于频繁|操作频繁|操作頻繁|請求過於頻繁|超出.*(?:限制|上限)|达到.*(?:限制|上限)|達到.*(?:限制|上限)/i.test(text)) {
      return 'X 显示访问限制，已停止本轮自动检查。';
    }
    if (/verify (?:that )?you(?: are|'re)|prove (?:that )?you|complete (?:the|this) (?:challenge|captcha)|authenticate your account|确认您是|確認您是|安全验证|安全驗證|验证.*(?:身份|真人)|驗證.*(?:身分|真人)/i.test(text)) {
      return 'X 显示验证提示，已停止本轮自动检查。';
    }
    if (/sign in to (?:x|twitter)|log in to (?:x|twitter)|登录以继续|登入以繼續|请先登录|請先登入|登录后.*(?:查看|继续)|登入後.*(?:查看|繼續)/i.test(text)) {
      return 'X 要求登录后查看，已停止本轮自动检查。';
    }
    if (/something went wrong|try reloading|unable to (?:retrieve|load)|temporarily unavailable|出了[点些]问题|出错了|發生錯誤|发生错误|重新加载|重新載入|暂时无法|暫時無法/i.test(text)) {
      return 'X 页面显示加载错误，已停止本轮自动检查。';
    }
    return '';
  }

  function unavailableReason(root) {
    const text = visibleUITexts(root).join(' ');
    if (/(?:these|this|their) (?:posts|tweets) (?:are|is) protected|protected (?:posts|tweets|account)|only (?:confirmed|approved) followers|这些.*(?:受保护|受到保护)|這些.*受保護|此.*(?:推文|帖子|貼文).*受保護|仅.*(?:关注者|关注的人).*查看|僅.*跟隨者/i.test(text)) {
      return '账户内容受保护，本次发帖活跃度未知。';
    }
    if (/account (?:is )?suspended|account (?:has been|was) suspended|账户已被冻结|账号已被冻结|账号已停用|帳戶已停用|帳號已停用|账户已停用|账号遭到冻结|帳戶已遭停權/i.test(text)) {
      return '账户已暂停或停用，本次发帖活跃度未知。';
    }
    if (/(?:this|that) account (?:doesn.t|does not) exist|account (?:not found|unavailable)|(?:profile|user) (?:not found|unavailable)|此账户不存在|此账号不存在|这个账号不存在|這個帳戶不存在|此帳戶不存在|此帳號不存在|找不到.*(?:账户|账号|帳戶|帳號)|账户不可用|帳戶無法使用/i.test(text)) {
      return '账户不存在或不可访问，本次发帖活跃度未知。';
    }
    if (/hasn.t (?:posted|tweeted)(?: anything)?|has not (?:posted|tweeted)|no (?:posts|tweets)(?: yet)?|nothing to see here|尚未(?:发帖|發文|发布|發布|发推|發推)|还没有.*(?:帖子|推文)|還沒有.*(?:貼文|推文)|没有(?:帖子|推文)|沒有(?:貼文|推文)|暂无(?:帖子|推文)/i.test(text)) {
      return '页面明确显示没有可读取的帖子；无帖子不等于不活跃。';
    }
    return '';
  }

  function unknownSnapshot(handle, reason, name = handle) {
    return { kind: 'profile', record: { handle, name, source: 'visible-profile', evidence: {
      observedAt: new Date().toISOString(), latestPostAt: null, sampleCount: 0,
      scope: 'profile-posts', hasUncertainReposts: true, profileAtTop: false, note: reason.slice(0, 300)
    } }, warnings: [reason, '没有可用的普通发帖时间证据，本次观察不可用于判定低活跃。'] };
  }

  function headerHandles(header) {
    return [...new Set([...textOf(header).matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)]
      .map(match => match[1].toLowerCase()))];
  }

  function publicHeaderID(header, handle) {
    const ids = new Set();
    for (const anchor of header.querySelectorAll('a[href]')) {
      if (!isRendered(anchor) || anchor.closest('article,[data-testid="UserCell"],[data-testid="UserDescription"]')) continue;
      let url;
      try { url = new URL(anchor.getAttribute('href'), location.href); } catch { continue; }
      if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port) continue;
      const numericPath = url.pathname.match(/^\/i\/user\/([0-9]{1,30})\/?$/);
      const id = numericPath ? numericPath[1]
        : /^\/intent\/user\/?$/.test(url.pathname) ? url.searchParams.get('user_id') : null;
      if (!id || !/^[0-9]{1,30}$/.test(id)) continue;
      // A numeric link is attributed only when that very anchor identifies the
      // current @handle, never just because an ID appears somewhere in a header.
      const names = headerHandles(anchor);
      if (names.length !== 1 || names[0] !== handle.toLowerCase()) continue;
      ids.add(id);
    }
    return ids.size === 1 ? [...ids][0] : null;
  }

  function timelineLoading(root) {
    return [...root.querySelectorAll('[role="progressbar"]')].some(node => isRendered(node)
      && !node.closest('nav,[role="navigation"],header,[data-testid="UserName"],article,[data-testid="UserCell"]'));
  }

  function ownTimestampExists(article) {
    const author = article.querySelector('[data-testid="User-Name"]');
    if (!author || author.closest('article') !== article) return false;
    return [...author.querySelectorAll('time[datetime]')].some(time => {
      const link = time.closest('a[href]');
      if (!link || !author.contains(link)) return false;
      let url;
      try { url = new URL(link.getAttribute('href'), location.href); } catch { return false; }
      const date = Date.parse(time.getAttribute('datetime'));
      return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.port
        && /^\/[A-Za-z0-9_]{1,15}\/status\/[0-9]+\/?$/.test(url.pathname)
        && Number.isFinite(date) && date <= Date.now() + 300000;
    });
  }

  globalThis.XReviewProfileProbe = function XReviewProfileProbe() {
    const root = document.querySelector('main [data-testid="primaryColumn"],main[data-testid="primaryColumn"]');
    const blocked = blockReason(root || document.querySelector('main'));
    if (blocked) return { state: 'blocked', reason: blocked };
    const handle = profileHandle();
    if (!handle) return { state: 'unavailable', reason: '当前地址不是可核实的 X Posts 主页。' };
    if (!root) return { state: 'loading', reason: '等待 X 主页主内容区域加载。' };

    const header = root.querySelector('[data-testid="UserName"]');
    const identities = header && isRendered(header) ? headerHandles(header) : [];
    if (header && isRendered(header) && (identities.length !== 1 || identities[0] !== handle.toLowerCase())) {
      return { state: 'loading', reason: '等待与当前地址一致的账户主页身份，避免读取页面切换前的内容。' };
    }
    const unavailable = unavailableReason(root);
    if (unavailable) return { state: 'unavailable', reason: unavailable, snapshot: unknownSnapshot(handle, unavailable) };
    if (!header || identities.length !== 1 || identities[0] !== handle.toLowerCase()) {
      return { state: 'loading', reason: '等待与当前地址一致的账户主页身份，避免读取页面切换前的内容。' };
    }
    if (timelineLoading(root)) return { state: 'loading', reason: '主页时间线仍在加载，等待帖子内容稳定。' };
    if (typeof globalThis.XReviewReadPage !== 'function') return { state: 'loading', reason: '等待页面读取器就绪。' };
    const snapshot = globalThis.XReviewReadPage();
    if (snapshot.kind !== 'profile' || !snapshot.record || snapshot.record.handle.toLowerCase() !== handle.toLowerCase()) {
      return { state: 'loading', reason: '账户主页身份尚未稳定。' };
    }
    if (!snapshot.record.evidence || !snapshot.record.evidence.profileAtTop) {
      return { state: 'loading', reason: '等待完整主页顶部；当前观察不能确认最新帖子。' };
    }
    const articles = [...root.querySelectorAll('article[data-testid="tweet"],article[role="article"]')]
      .filter(article => isRendered(article) && !article.parentElement.closest('article'));
    const datedPosts = articles.filter(ownTimestampExists);
    if (!datedPosts.length) return { state: 'loading', reason: '尚未读取到完整帖子日期或明确的空白状态。' };
    if (snapshot.record.evidence.sampleCount === 0) {
      // A loaded repost-only or pinned-only timeline must not make old activity
      // evidence look current. Preserve a positive recent pinned self-post date
      // but leave sampleCount zero; the core will keep the result unknown.
      const repostOnly = datedPosts.every(article => {
        const context = article.querySelector('[data-testid="socialContext"]');
        return context && REPOST.test(textOf(context));
      });
      if (repostOnly) {
        snapshot.record.evidence.latestPostAt = null;
        snapshot.record.evidence.hasUncertainReposts = true;
      }
    }
    snapshot.record.evidence.observedAt = new Date().toISOString();
    snapshot.record.evidence.scope = 'profile-posts';
    const id = publicHeaderID(header, handle);
    if (id) snapshot.record.id = id;
    return { state: 'ready', reason: snapshot.record.evidence.sampleCount
      ? '已读取到主页顶部的公开发帖样本。' : '已加载的内容不足以判断低活跃，将保留为证据不足。', snapshot };
  };
})();
