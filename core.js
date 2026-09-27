(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.XReviewCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const HANDLES = /^[A-Za-z0-9_]{1,15}$/;
  const IDS = /^\d{1,30}$/;
  const RESERVED = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose', 'i', 'intent', 'share', 'hashtag', 'login', 'logout', 'signup', 'tos', 'privacy', 'jobs', 'bookmarks', 'communities']);
  const STATUSES = new Set(['pending', 'keep', 'reviewed']);

  function currentTime(value) {
    const time = value === undefined ? Date.now() : value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(time)) throw new TypeError('当前时间无效。');
    return time;
  }

  function dateISO(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return null;
    const [year, month, day] = text.slice(0, 10).split('-').map(Number);
    const dayCheck = new Date(Date.UTC(year, month - 1, day));
    if (year < 100 || dayCheck.getUTCFullYear() !== year || dayCheck.getUTCMonth() !== month - 1 || dayCheck.getUTCDate() !== day) return null;
    const millis = Date.parse(text);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
  }

  function cleanID(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('账户 ID 必须以完整数字字符串提供。');
    const text = String(value).trim();
    if (!IDS.test(text)) throw new TypeError('账户 ID 只能包含数字。');
    return text;
  }

  function cleanHandle(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const text = String(value).trim().replace(/^@/, '');
    if (!HANDLES.test(text) || RESERVED.has(text.toLowerCase())) throw new TypeError('账户名须为 1–15 个英文字母、数字或下划线。');
    return text;
  }

  function identityFromURL(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch (_) { throw new TypeError('账户链接格式无效。'); }
    if (!['https:', 'http:'].includes(url.protocol) || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
      throw new TypeError('只接受 x.com 或 twitter.com 的账户链接。');
    }
    const path = url.pathname.replace(/\/+$/, '');
    const idMatch = path.match(/^\/i\/user\/(\d{1,30})$/);
    if (idMatch) return { id: idMatch[1] };
    if (path === '/intent/user') return { id: cleanID(url.searchParams.get('user_id')) || invalidIdentity() };
    const handleMatch = path.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (handleMatch) return { handle: cleanHandle(handleMatch[1]) };
    throw new TypeError('链接必须指向账户主页，不能是帖子或其他页面。');
  }

  function invalidIdentity() { throw new TypeError('缺少有效的账户名或账户 ID。'); }

  function followingOwners(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 1000) throw new TypeError('关注名单所属账户格式无效。');
    return [...new Set(value.map(owner => {
      if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('关注名单所属账户格式无效。');
      return cleanHandle(owner).toLowerCase();
    }))].sort();
  }

  function profileUrl(record) {
    try {
      const handle = cleanHandle(record && record.handle);
      const id = cleanID(record && record.id);
      if (id) return 'https://x.com/i/user/' + id;
      if (handle) return 'https://x.com/' + handle;
      if (record && record.profileUrl) return profileUrl(identityFromURL(record.profileUrl));
    } catch (_) { return ''; }
    return '';
  }

  function normaliseRecord(input, now) {
    const nowISO = new Date(currentTime(now)).toISOString();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('账户记录格式无效。');
    let handle = cleanHandle(input.handle === undefined ? input.username : input.handle);
    let id = cleanID(input.id === undefined ? input.accountId : input.id);
    const rawURL = input.profileUrl || input.userLink;
    if (rawURL) {
      const identity = identityFromURL(rawURL);
      if (handle && identity.handle && handle.toLowerCase() !== identity.handle.toLowerCase()) throw new TypeError('账户名与主页链接不一致。');
      if (id && identity.id && id !== identity.id) throw new TypeError('账户 ID 与主页链接不一致。');
      handle = handle || identity.handle;
      id = id || identity.id;
    }
    if (!handle && !id && typeof input.key === 'string') {
      if (input.key.startsWith('id:')) id = cleanID(input.key.slice(3));
      else if (input.key.startsWith('handle:')) handle = cleanHandle(input.key.slice(7));
    }
    if (!handle && !id) invalidIdentity();
    const record = {
      key: id ? 'id:' + id : 'handle:' + handle.toLowerCase(),
      ...(id ? { id } : {}), ...(handle ? { handle } : {}),
      name: typeof input.name === 'string' ? input.name.slice(0, 200) : '',
      profileUrl: profileUrl({ handle, id }),
      status: STATUSES.has(input.status) ? input.status : 'pending',
      addedAt: dateISO(input.addedAt) || nowISO,
      updatedAt: dateISO(input.updatedAt) || nowISO,
      source: typeof input.source === 'string' ? input.source.slice(0, 100) : 'import',
      followingOwners: followingOwners(input.followingOwners)
    };
    if (input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)) {
      const e = input.evidence;
      record.evidence = {
        observedAt: dateISO(e.observedAt), latestPostAt: dateISO(e.latestPostAt),
        sampleCount: Number.isSafeInteger(Number(e.sampleCount)) && Number(e.sampleCount) >= 0 ? Math.min(10000, Number(e.sampleCount)) : 0,
        scope: ['profile-posts', 'manual'].includes(e.scope) ? e.scope : 'unknown',
        ...(typeof e.note === 'string' && e.note.trim() ? {note: e.note.trim().slice(0, 300)} : {}),
        hasUncertainReposts: e.hasUncertainReposts !== false,
        profileAtTop: e.profileAtTop === true
      };
    }
    return record;
  }

  function evidenceTime(e, now) {
    const observed = e && dateISO(e.observedAt);
    if (!observed) return -Infinity;
    const time = Date.parse(observed);
    const latest = dateISO(e.latestPostAt);
    if (time > now || (latest && Date.parse(latest) > time)) return -Infinity;
    return time;
  }
  function latestTime(e, now) {
    const latest = e && dateISO(e.latestPostAt);
    const observed = e && dateISO(e.observedAt);
    if (!latest || !observed) return -Infinity;
    const result = Date.parse(latest);
    return result <= Date.parse(observed) && Date.parse(observed) <= now ? result : -Infinity;
  }

  function mergePair(a, b, now) {
    const aTime = evidenceTime(a.evidence, now), bTime = evidenceTime(b.evidence, now);
    const bIsBetter = bTime > aTime || (bTime === aTime && Number.isFinite(latestTime(b.evidence, now)) && !Number.isFinite(latestTime(a.evidence, now)));
    const evidence = bIsBetter ? b.evidence : a.evidence || b.evidence;
    let mergedEvidence = evidence ? { ...evidence } : undefined;
    // A later snapshot can show an old pinned post. Never discard a newer known post.
    const knownLatest = Math.max(latestTime(a.evidence, now), latestTime(b.evidence, now));
    // Missing dates must stay unknown: an empty new observation cannot renew old evidence.
    if (mergedEvidence && Number.isFinite(latestTime(mergedEvidence, now)) && Number.isFinite(knownLatest) && knownLatest <= evidenceTime(mergedEvidence, now)) mergedEvidence.latestPostAt = new Date(knownLatest).toISOString();
    return normaliseRecord({
      ...a, ...b, id: a.id || b.id, handle: b.handle || a.handle,
      profileUrl: undefined,
      name: b.name || a.name,
      followingOwners: followingOwners([...(a.followingOwners || []), ...(b.followingOwners || [])]),
      status: a.status !== 'pending' ? a.status : b.status,
      addedAt: Date.parse(a.addedAt) <= Date.parse(b.addedAt) ? a.addedAt : b.addedAt,
      updatedAt: new Date(now).toISOString(), evidence: mergedEvidence
    }, now);
  }

  function mergeRecords(existing, incoming, now) {
    const nowMillis = currentTime(now);
    if (!Array.isArray(existing) || !Array.isArray(incoming)) throw new TypeError('待合并的数据必须为账户数组。');
    const records = [];
    const ids = new Map();
    const handles = new Map();
    const aliases = new Map();
    function resolve(index) {
      while (aliases.has(index)) index = aliases.get(index);
      return index;
    }
    for (const raw of [...existing, ...incoming]) {
      const record = normaliseRecord(raw, nowMillis);
      const byID = record.id ? resolve(ids.get(record.id)) : undefined;
      const byHandle = record.handle ? resolve(handles.get(record.handle.toLowerCase())) : undefined;
      let index = byID !== undefined ? byID : byHandle;
      // An observed ID+handle can connect an archive entry with a handle-only import.
      if (byID !== undefined && byHandle !== undefined && byID !== byHandle &&
          (!records[byHandle].id || records[byHandle].id === record.id)) {
        records[byID] = mergePair(records[byID], records[byHandle], nowMillis);
        records[byHandle] = null;
        aliases.set(byHandle, byID);
      }
      // A reused handle must not merge two different account IDs.
      if (index !== undefined && record.id && records[index].id && record.id !== records[index].id) index = undefined;
      if (index === undefined) { index = records.length; records.push(record); }
      else records[index] = mergePair(records[index], record, nowMillis);
      const merged = records[index];
      if (merged.id) ids.set(merged.id, index);
      if (merged.handle) handles.set(merged.handle.toLowerCase(), index);
    }
    return records.filter(Boolean);
  }

  function classify(record, thresholdDays, now, freshnessDays) {
    const nowMillis = currentTime(now);
    const threshold = thresholdDays === undefined ? 180 : Number(thresholdDays);
    const freshness = freshnessDays === undefined ? 7 : Number(freshnessDays);
    if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(freshness) || freshness < 0) throw new TypeError('阈值和证据有效天数必须为非负数。');
    if (record && record.status === 'keep') return { bucket: 'keep', reason: '已加入保留名单。' };
    if (record && record.status === 'reviewed') return { bucket: 'reviewed', reason: '已标记为处理完毕；这不代表已经取关。' };
    const e = record && record.evidence;
    if (!e || !dateISO(e.observedAt) || !dateISO(e.latestPostAt)) return { bucket: 'unknown', reason: e?.note || '尚无可用的发帖时间证据；没有看到帖子不等于不活跃。' };
    const observed = Date.parse(e.observedAt), latest = Date.parse(e.latestPostAt);
    if (observed > nowMillis || latest > nowMillis || latest > observed) return { bucket: 'unknown', reason: '时间证据含未来日期或互相矛盾，请重新核实。' };
    const days = Math.floor((observed - latest) / DAY);
    if (nowMillis - observed > freshness * DAY) return { bucket: 'stale', days, reason: '证据已过期，请重新查看主页。旧快照不会随时间自动变成候选。' };
    if (!['profile-posts', 'manual'].includes(e.scope)) return { bucket: 'unknown', days, reason: '证据来源不明确，请重新核实。' };
    if (observed - latest < threshold * DAY) return { bucket: 'recent', days, reason: '采集时已看到阈值内的帖子。' };
    if (e.scope === 'profile-posts' && (!e.profileAtTop || !(e.sampleCount > 0) || e.hasUncertainReposts !== false)) return { bucket: 'unknown', days, reason: '主页样本不足或含时间不明的转帖，暂不能列为候选。' };
    return { bucket: 'candidate', days, reason: e.scope === 'manual' ? '你填写的最近发帖日期早于阈值，列为待核实候选；不能据此确认账户不活跃。' : '主页可见帖子的日期早于阈值，列为待核实候选；不能据此确认账户不活跃。' };
  }

  function parseCSV(text) {
    const rows = []; let row = [], field = '', quoted = false, justClosed = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
        else if (char === '"') { quoted = false; justClosed = true; }
        else field += char;
      } else if (char === '"' && field === '' && !justClosed) quoted = true;
      else if (char === ',') { row.push(field); field = ''; justClosed = false; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[index + 1] === '\n') index++;
        row.push(field); rows.push(row); row = []; field = ''; justClosed = false;
      } else if (justClosed && !/\s/.test(char)) throw new Error('CSV 引号后的内容无效。');
      else if (!justClosed) field += char;
    }
    if (quoted) throw new Error('CSV 含未闭合的引号。');
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(values => values.some(value => value.trim()));
  }

  function parseImport(text, filename, now) {
    if (typeof text !== 'string' || !text.replace(/^\uFEFF/, '').trim()) throw new Error('文件内容为空，请导入 following.js、JSON、CSV 或账户列表。');
    const input = text.replace(/^\uFEFF/, '').trim();
    const warnings = []; const candidates = []; const nowMillis = currentTime(now);
    function add(raw, label) {
      try {
        const record = normaliseRecord(raw, nowMillis);
        if (raw.evidence && ((!record.evidence.latestPostAt && raw.evidence.latestPostAt) || (!record.evidence.observedAt && raw.evidence.observedAt))) warnings.push(label + '：日期格式无效，已保留账户并将其视为证据不足。');
        if (record.evidence && classify(record, 180, nowMillis).reason.includes('未来日期')) warnings.push(label + '：日期位于未来或互相矛盾，不会用于候选判断。');
        candidates.push(record);
      } catch (error) { warnings.push(label + '：' + error.message); }
    }
    const archiveMatch = input.match(/^window\.YTD\.following\.part\d+\s*=\s*/);
    if (archiveMatch || input.startsWith('[') || input.startsWith('{')) {
      let payload;
      const json = archiveMatch ? input.slice(archiveMatch[0].length).replace(/;\s*$/, '') : input;
      try { payload = JSON.parse(json); } catch (_) { throw new Error('JSON 或 following.js 格式无效。只读取数据，不执行 JavaScript。'); }
      let rows;
      if (Array.isArray(payload)) rows = payload;
      else if (payload && payload.schemaVersion === 1 && Array.isArray(payload.records)) rows = payload.records;
      else throw new Error('JSON 须为账户数组，或 schemaVersion 为 1 的备份文件。');
      rows.forEach((item, index) => {
        if (item && item.following && typeof item.following === 'object') add({ id: item.following.accountId, profileUrl: item.following.userLink, source: 'x-archive' }, '第 ' + (index + 1) + ' 条');
        else if (archiveMatch) warnings.push('第 ' + (index + 1) + ' 条：缺少 following 数据。');
        else add(item, '第 ' + (index + 1) + ' 条');
      });
      if (archiveMatch || rows.some(row => row && row.following)) warnings.push('X 关注归档通常不含对方最近发帖日期；导入后仍需采集或手动核实。');
    } else {
      const firstLine = input.split(/\r?\n/, 1)[0];
      const headerNames = firstLine.split(',').map(value => value.replace(/^"|"$/g, '').trim().toLowerCase().replace(/[ _-]/g, ''));
      const headerLooksValid = headerNames.some(value => ['handle', 'username', 'screenname', 'profileurl', 'userlink', 'accountid'].includes(value)) || (headerNames.includes('id') && headerNames.length > 1);
      if (headerLooksValid || /\.csv$/i.test(filename || '')) {
        const rows = parseCSV(input);
        if (!rows.length) throw new Error('CSV 内容为空。');
        const headers = rows.shift().map(value => value.trim().toLowerCase().replace(/[ _-]/g, ''));
        if (!headers.some(value => ['handle', 'username', 'screenname', 'profileurl', 'userlink', 'accountid', 'id'].includes(value))) throw new Error('CSV 需要 handle、profileUrl 或 id 列。');
        rows.forEach((values, index) => {
          if (values.length !== headers.length) { warnings.push('第 ' + (index + 2) + ' 行：列数与表头不符，已跳过。'); return; }
          const cells = Object.fromEntries(headers.map((key, cellIndex) => [key, values[cellIndex].trim()]));
          const latest = cells.latestpostat || cells.lastpostat || cells.lasttweet || cells.latestpostdate;
          const observed = cells.observedat || cells.checkedat;
          let owners = [];
          try { if (cells.followingowners) owners = JSON.parse(cells.followingowners); }
          catch { warnings.push('第 ' + (index + 2) + ' 行：followingOwners 须为 JSON 数组，已跳过以保留归属保护。'); return; }
          add({ handle: cells.handle || cells.username || cells.screenname, id: cells.id || cells.accountid,
            profileUrl: cells.profileurl || cells.userlink, name: cells.name || cells.displayname || '',
            status: cells.status, source: cells.source || 'csv', followingOwners: owners,
            ...(latest || observed ? { evidence: { latestPostAt: latest, observedAt: observed,
              sampleCount: cells.samplecount || (latest ? 1 : 0), scope: cells.scope || 'manual', note: cells.note,
              hasUncertainReposts: cells.hasuncertainreposts === 'true', profileAtTop: cells.profileattop === 'true' } } : {})
          }, '第 ' + (index + 2) + ' 行');
        });
      } else {
        input.split(/[\r\n]+/).forEach((line, index) => {
          const trimmed = line.trim().replace(/^[-*]\s+/, '');
          if (!trimmed || trimmed.startsWith('#')) return;
          const values = trimmed.split(/[\s,]+/).filter(Boolean);
          for (const value of values) add(/^https?:\/\//i.test(value) ? { profileUrl: value, source: 'list' } : { handle: value, source: 'list' }, '第 ' + (index + 1) + ' 行');
        });
      }
    }
    if (!candidates.length) throw new Error('没有找到有效账户。' + (warnings.length ? ' ' + warnings.slice(0, 3).join(' ') : ' 请检查文件是否包含关注账户。'));
    const records = mergeRecords([], candidates, nowMillis);
    if (records.length < candidates.length) warnings.push('已合并 ' + (candidates.length - records.length) + ' 条重复账户。');
    return { records, warnings };
  }

  function exportCSV(records) {
    if (!Array.isArray(records)) throw new TypeError('导出数据必须为账户数组。');
    const headers = ['handle', 'name', 'id', 'profileUrl', 'status', 'latestPostAt', 'observedAt', 'sampleCount', 'scope', 'hasUncertainReposts', 'profileAtTop', 'source', 'note', 'followingOwners'];
    function cell(value) {
      let text = value === undefined || value === null ? '' : String(value);
      if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    }
    const lines = [headers.map(cell).join(',')];
    for (const raw of records) {
      const record = normaliseRecord(raw);
      const e = record.evidence || {};
      const row = { ...record, ...e, profileUrl: profileUrl(record), followingOwners: JSON.stringify(record.followingOwners || []) };
      lines.push(headers.map(key => cell(row[key])).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  return { normaliseRecord, mergeRecords, classify, parseImport, exportCSV, profileUrl };
});
