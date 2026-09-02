/* ===================================================================
   行情通 · 数据层
   统一封装后端接口 + 本地自选持久化；后端不可用时回落演示数据
   =================================================================== */
window.API = (function () {
  var BASE = '';

  /* ---------- 交易成本常量 ----------
     必须与 server.js 顶部的 FEE 保持一致（REQUIREMENTS §4：集中定义，禁止散落魔法数字）
       佣金   万 2.5（0.025%），买卖双向，单笔最低 5 元
       印花税 卖出 0.05%
       过户费 0.001%，买卖双向 */
  var FEE = {
    commission: 0.00025,
    commissionMin: 5,
    stampTax: 0.0005,
    transfer: 0.00001
  };
  function feeOf(amount, dir) {
    var a = Math.max(0, Number(amount) || 0);
    var comm = Math.max(a * FEE.commission, FEE.commissionMin);
    var transfer = a * FEE.transfer;
    var stamp = dir === 'sell' ? a * FEE.stampTax : 0;
    return { commission: comm, transfer: transfer, stamp: stamp, total: comm + transfer + stamp };
  }
  /* 双边成本（买入+卖出）占金额比例 */
  function roundTripCostPct(amount) {
    var a = Math.max(0, Number(amount) || 0);
    if (a <= 0) return 0;
    return (feeOf(a, 'buy').total + feeOf(a, 'sell').total) / a;
  }

  function get(path, params) {
    var qs = '';
    if (params) {
      var p = [];
      for (var k in params) if (params[k] !== undefined && params[k] !== null) p.push(k + '=' + encodeURIComponent(params[k]));
      if (p.length) qs = (path.indexOf('?') > -1 ? '&' : '?') + p.join('&');
    }
    return fetch(BASE + '/api' + path + qs, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.msg || '接口异常');
        return j.data;
      });
  }

  function post(path, body) {
    return fetch(BASE + '/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body || {})
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.msg || '接口异常');
        return j.data;
      });
  }
  function postRaw(path, body) {
    return fetch(BASE + '/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  /* ---------- 本地自选 ---------- */
  var WK = 'hqt.watchlist.v1';
  function watchlist() {
    try { return JSON.parse(localStorage.getItem(WK)) || []; } catch (e) { return []; }
  }
  function saveWatchlist(list) {
    try { localStorage.setItem(WK, JSON.stringify(list)); } catch (e) {}
    return list;
  }
  function addWatch(code, name, secid) {
    var list = watchlist();
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return false;
    list.push({ code: code, name: name || code, secid: secid || '', ts: Date.now() });
    saveWatchlist(list);
    return true;
  }
  function removeWatch(code) {
    return saveWatchlist(watchlist().filter(function (x) { return x.code !== code; }));
  }
  function inWatch(code) {
    return watchlist().some(function (x) { return x.code === code; });
  }

  /* ---------- 云端同步凭据 ----------
     只存昵称，口令绝不落盘；每次同步时由用户输入 */
  var SK = 'hqt.sync.v1';
  function syncCred() {
    try { return JSON.parse(localStorage.getItem(SK)) || {}; } catch (e) { return {}; }
  }
  function saveSyncUser(user, remember) {
    try {
      if (remember) localStorage.setItem(SK, JSON.stringify({ user: user }));
      else localStorage.removeItem(SK);
    } catch (e) {}
  }
  function clearSyncUser() {
    try { localStorage.removeItem(SK); } catch (e) {}
  }

  /* ---------- 模拟持仓（本地 localStorage） ----------
     结构：{ code, name, secid, shares, cost, ts } */
  var PK = 'hqt.paper.v1';
  function paper() {
    try { return JSON.parse(localStorage.getItem(PK)) || []; } catch (e) { return []; }
  }
  function paperSave(list) {
    try { localStorage.setItem(PK, JSON.stringify(list)); } catch (e) {}
    return list;
  }
  function paperAdd(p) {
    var list = paper();
    for (var i = 0; i < list.length; i++) {
      if (list[i].code === p.code) {
        /* 加仓：加权平均成本 */
        var o = list[i];
        var tot = o.shares + p.shares;
        o.cost = tot > 0 ? (o.cost * o.shares + p.cost * p.shares) / tot : p.cost;
        o.shares = tot;
        return paperSave(list);
      }
    }
    list.push({ code: p.code, name: p.name || p.code, secid: p.secid || '', shares: p.shares, cost: p.cost, ts: Date.now() });
    return paperSave(list);
  }
  function paperDel(code) {
    return paperSave(paper().filter(function (x) { return x.code !== code; }));
  }

  /* 注：原「演示数据 demoQuotes」（用 Math.random 生成假行情/假涨跌幅）已整体删除。
     本项目只展示真实行情：后端不可用时前端显示错误提示，绝不用假数据兜底。 */

  /* 并发限流：避免一次性打出过多请求被上游限流 */
  function mapLimit(list, n, fn) {
    var i = 0, out = [];
    function next() {
      if (i >= list.length) return Promise.resolve();
      var idx = i++;
      return Promise.resolve(fn(list[idx], idx)).then(function (r) { out[idx] = r; return next(); });
    }
    var ps = [];
    for (var k = 0; k < Math.min(n, list.length); k++) ps.push(next());
    return Promise.all(ps).then(function () { return out; });
  }

  return {
    get: get,
    globalIndex: function () { return get('/global'); },
    indices: function (params) { return get('/indices', params || {}); },
    quotes: function (codes) { return get('/quotes', { codes: codes.join(',') }); },
    ranking: function (type) { return get('/ranking', { type: type }); },
    sectors: function (type) { return get('/sectors', { type: type }); },
    limitPool: function (kind) { return get('/limit', { kind: kind }); },
    limitStats: function () { return get('/limit-stats'); },
    dragon: function (type) { return get('/dragon', { type: type }); },
    hot: function () { return get('/hot'); },
    news: function (tab, src) { return get('/news', { tab: tab || 'all', src: src || 'all' }); },
    us: function (kind) { return get('/us', { kind: kind }); },
    search: function (kw) { return get('/search', { q: kw }); },
    /* code 无法区分市场（"000001" 既可能是上证指数也可能是平安银行），
       因此所有个股级接口都额外接受 secid，有就优先用它 */
    detail: function (code, secid) { return get('/detail', { code: code, secid: secid }); },
    kline: function (code, period, limit, secid) { return get('/kline', { code: code, period: period, limit: limit || 120, secid: secid }); },
    minute: function (code, secid) { return get('/minute', { code: code, secid: secid }); },
    signal: function (code, secid) { return get('/signal', { code: code, secid: secid }); },

    /* ---------- 对标参考站新增 ---------- */
    rank: function (mkt, dim, limit) { return get('/rank', { mkt: mkt, dim: dim, limit: limit || 50 }); },
    sectorCapital: function (type, sort) { return get('/sector-capital', { type: type, sort: sort }); },
    usSector: function (g) { return get('/us-sector', { g: g }); },
    hkSector: function (g) { return get('/hk-sector', { g: g }); },
    /* /treemap 已随自绘云图一起下线：板块层在宽画布上会出横条，
       且东财 clist 从本机取不到价格；改由前端直接嵌入 52etf.site */
    /* mode=fast 秒回（涨跌家数取指数统计字段）；默认精确全量，服务端缓存 2 分钟 */
    marketStat: function (mode) { return get('/market-stat', mode ? { mode: mode } : {}); },
    youzi: function (date) { return get('/youzi', date ? { date: date } : {}); },
    youziPortrait: function (name, date) { return get('/youzi-portrait', { name: name, date: date }); },
    dark: function () { return get('/dark'); },
    compare: function (codes) { return get('/compare', { codes: codes.join(',') }); },
    forecast: function () { return get('/forecast'); },
    /* A1 历史回测：codes 为空时后端自动取当前 forecast 推荐列表 */
    backtest: function (codes, days, hold, minScore) {
      var q = { days: days || 250, hold: hold || 5 };
      if (codes && codes.length) q.codes = codes.join(',');
      if (minScore != null) q.minScore = minScore;
      return get('/backtest', q);
    },
    /* A2 事后追踪 */
    pickStats: function () { return get('/pick-stats'); },

    /* ---------- 同花顺（fuyao.aicubes.cn）代理 ----------
       对标同花顺 A股市场数据，作为权威基准对齐涨跌家数/成交额/指数点位。
       返回 null 时表示未配置或源不可用，调用方应降级到东财源。 */
    fuyaoStat: function () { return get('/fuyao-stat'); },
    fuyaoIndices: function () { return get('/fuyao-indices'); },

    /* ---------- 模拟持仓（本地） ---------- */
    paper: paper, paperSave: paperSave, paperAdd: paperAdd, paperDel: paperDel,

    /* ---------- 邮件通知 ---------- */
    mailGet: function () { return get('/mail/config'); },
    mailSave: function (cfg) { return post('/mail/config', cfg); },
    mailTest: function () { return post('/mail/test', {}); },
    mailCheck: function () { return post('/mail/check', {}); },

    syncPull: function (user, pass) { return post('/sync/pull', { user: user, pass: pass }); },
    syncPush: function (user, pass, list, base) {
      return post('/sync/push', { user: user, pass: pass, watchlist: list, baseUpdatedAt: base || '' });
    },
    syncRawPull: function (user, pass) { return postRaw('/sync/pull', { user: user, pass: pass }); },

    watchlist: watchlist, addWatch: addWatch, removeWatch: removeWatch, inWatch: inWatch,
    saveWatchlist: saveWatchlist,
    syncCred: syncCred, saveSyncUser: saveSyncUser, clearSyncUser: clearSyncUser,
    mapLimit: mapLimit,

    /* ---------- 交易成本 ---------- */
    FEE: FEE, feeOf: feeOf, roundTripCostPct: roundTripCostPct
  };
})();
