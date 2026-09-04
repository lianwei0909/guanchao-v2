/* 由 server.js 机械拆分而来，行为未改动。 */
const { EM } = require('../config.js');
const { clistGet, clistPage } = require('../datasource/em.js');
const { num, round } = require('../lib/format.js');
const { getJSON, getJSON_Text } = require('../lib/http.js');
const { fail, ok } = require('../lib/respond.js');
const { secidOf } = require('../lib/secid.js');
const { mapLimit } = require('../lib/util.js');
const H = {};

const POLITICAL = /中共中央|政治局|总书记|国家主席|国务院总理|委员长|军委|全国人大|全国政协|外交部|国防部|统战部|中央会议|视察|考察调研/;
const NEWS_FEEDS = {
  all:   { ids: [101, 102, 103, 104, 105, 106], tag: '财经要闻' },
  a:     { ids: [101, 103, 104, 109, 118, 125], tag: 'A股' },
  us:    { ids: [111, 119, 126], tag: '美股' },
  hk:    { ids: [101, 102, 103, 104, 105, 106, 107, 109, 111, 114, 118, 119, 125], tag: '港股' },
  alert: { ids: [109, 101, 103, 104], tag: '异动' }
};
const NEWS_KW = {
  hk: /港股|恒生|港交所|南向|港股通|H股|北水|深港通|沪港通|中概股|中概|赴港上市|回归港股/,
  alert: /涨停|跌停|异动|拉升|跳水|封板|涨超|跌超|创新高|创新低|龙虎榜|大涨|大跌|刷新|逼近/,
  us: /美股|纳斯达克|道琼斯|标普|纽交所|美联储|非农|华尔街|美国/
};
const NEWS_SRCS = ['东方财富', '同花顺', '新浪财经'];

/* ---------- 快讯个股识别 ----------
   快讯原文常直接写股票简称（如「凯瑞德：股东…累计减持…」），
   这里用全市场股票名做字典匹配，把提到的票解析成 {code,name,secid}，
   前端据此在快讯条目上挂可点击的个股标签。
   字典异步构建（分页拉全 A 股约 50 页），未就绪时降级为「不识别」，
   绝不阻塞快讯本身返回。 */
const NAME_MAP = { t: 0, map: null, busy: false }
const NAME_TTL = 12 * 3600 * 1000   // 12 小时更新一次（股票简称极少变动）
/* 2 字简称与日常用语高度重叠，这些词直接排除，避免满屏误命中 */
const NAME_STOP = new Set([
  '中国', '银行', '证券', '保险', '建设', '交通', '发展', '国际', '集团', '股份',
  '科技', '实业', '能源', '电力', '医药', '汽车', '食品', '地产', '传媒', '环保',
  '通信', '电子', '化工', '机械', '纺织', '旅游', '商业', '农业', '钢铁', '有色',
  '煤炭', '石油', '燃气', '水务', '航空', '机场', '港口', '公路', '铁路', '物流',
  '家电', '服装', '家具', '造纸', '印刷', '包装', '健康', '医疗', '文化', '教育',
  '体育', '游戏', '网络', '软件', '硬件', '数据', '智能', '数字', '信息', '投资',
  '控股', '产业', '资源', '材料', '装备', '工程', '置业', '贸易', '连锁', '生物'
])

async function buildNameMap() {
  if (NAME_MAP.busy) return
  NAME_MAP.busy = true
  try {
    const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
    /* 先探总数再分页（每页 100，封顶 60 页 ≈ 6000 只，足够覆盖全 A 股） */
    const first = await clistPage(fs, 'f6', 'f12,f13,f14', { po: 1, pz: 100 })
    const total = first.total || first.arr.length
    const pages = Math.min(60, Math.ceil(total / 100))
    const rows = first.arr.slice()
    if (pages > 1) {
      const rest = await mapLimit(
        Array.from({ length: pages - 1 }, (_, i) => i + 2),
        6,
        (pn) => clistPage(fs, 'f6', 'f12,f13,f14', { po: 1, pz: 100, pn }).catch(() => ({ arr: [] }))
      )
      rest.forEach((r) => { if (r && r.arr) rows.push(...r.arr) })
    }
    const map = []
    const seen = {}
    rows.forEach((x) => {
      const name = String(x.f14 || '').trim()
      const code = String(x.f12 || '').trim()
      if (!name || !code || seen[code]) return
      if (NAME_STOP.has(name)) return
      seen[code] = 1
      map.push({ name, code, secid: secidOf(String(x.f13), code) })
    })
    /* 长名优先：避免「中国银行」这类被更短的通用词抢先匹配 */
    map.sort((a, b) => b.name.length - a.name.length)
    NAME_MAP.map = map
    NAME_MAP.t = Date.now()
  } catch (e) {
    /* 构建失败保留旧值（可能为 null），快讯照常返回 */
  } finally {
    NAME_MAP.busy = false
  }
}

/** 文本 → 提及的个股（最多 3 只） */
function findStocks(text) {
  const m = NAME_MAP.map
  if (!m || !text) return []
  const out = []
  const used = {}
  for (const s of m) {
    if (out.length >= 3) break
    if (used[s.code]) continue
    if (text.includes(s.name)) {
      used[s.code] = 1
      out.push({ code: s.code, name: s.name, secid: s.secid })
    }
  }
  return out
}

/* 后台预热，不阻塞首个快讯请求；之后每 12 小时刷新一次。
   由 index.js 显式启动 —— 模块加载期的定时器会挂住事件循环，
   导致进程无法退出，且让「加载模块」产生隐式副作用。 */
function startNameMapSchedule() {
  const warm = setTimeout(buildNameMap, 3000);
  const tick = setInterval(buildNameMap, NAME_TTL);
  if (warm.unref) warm.unref();
  if (tick.unref) tick.unref();
  return () => { clearTimeout(warm); clearInterval(tick); };
}

/* 文本归一化（跨源去重用） */
function nz(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }

/* 东方财富 7×24 单栏目 */
async function kxFeed(id) {
  const txt = await getJSON_Text(
    `https://newsapi.eastmoney.com/kuaixun/v1/getlist_${id}_ajaxResult_20_1_.html`,
    { Referer: 'https://kuaixun.eastmoney.com/' });
  const body = txt.replace(/^\s*var\s+ajaxResult\s*=\s*/, '').replace(/;?\s*$/, '');
  let j;
  try { j = JSON.parse(body); } catch (e) { return []; }
  return j?.LivesList || [];
}

/* 同花顺快讯（7×24）：data.list 为数组，ctime 是 unix 秒 */
async function thsFeed() {
  const txt = await getJSON_Text(
    'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=50',
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://news.10jqka.com.cn/' });
  let j; try { j = JSON.parse(txt); } catch (e) { return []; }
  const list = j?.data?.list || [];
  return list.map(x => ({
    src: '同花顺',
    key: String(x.seq || x.id || ''),
    title: String(x.title || '').trim(),
    summary: String(x.digest || x.short || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    time: Number(x.ctime) ? new Date(Number(x.ctime) * 1000).toISOString() : new Date().toISOString(),
    url: x.url || x.shareUrl || x.appUrl || ''
  })).filter(x => x.title);
}

/* 新浪财经滚动快讯：result.data 为数组，ctime 是 unix 秒 */
async function sinaFeed() {
  const txt = await getJSON_Text(
    'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=30&page=1',
    { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' });
  let j; try { j = JSON.parse(txt); } catch (e) { return []; }
  const list = j?.result?.data || [];
  return list.map(x => ({
    src: '新浪财经',
    key: String(x.docid || x.url || ''),
    title: String(x.title || '').trim(),
    summary: String(x.summary || x.intro || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    time: Number(x.ctime) ? new Date(Number(x.ctime) * 1000).toISOString() : new Date().toISOString(),
    url: x.url || x.wapurl || ''
  })).filter(x => x.title);
}

H['/news'] = async (res, q) => {
  const tab = NEWS_FEEDS[q.get('tab')] ? q.get('tab') : 'all';
  const cfg = NEWS_FEEDS[tab];
  const kw = NEWS_KW[tab] || null;
  const src = NEWS_SRCS.includes(q.get('src')) ? q.get('src') : 'all';

  /* 东财多栏目 + 同花顺 + 新浪 并行抓取 */
  const [emLists, ths, sina] = await Promise.all([
    mapLimit(cfg.ids, 4, id => kxFeed(id).catch(() => [])),
    thsFeed().catch(() => []),
    sinaFeed().catch(() => [])
  ]);

  const raw = [];
  /* 东方财富 */
  emLists.forEach(arr => (arr || []).forEach(x => {
    const text = String(x.digest || '') + ' ' + String(x.title || '');
    if (!text.trim()) return;
    const m = String(x.digest || '').match(/^【([^】]*)】([\s\S]*)$/);
    raw.push({
      src: '东方财富',
      key: String(x.id || x.newsid || ''),
      title: m ? m[1] : String(x.title || x.digest || '').slice(0, 40),
      summary: (m ? m[2] : String(x.digest || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
      time: String(x.showtime || '').replace(' ', 'T') || new Date().toISOString(),
      url: x.url_unique || x.url_w || ''
    });
  }));
  /* 同花顺 + 新浪 */
  raw.push(...ths, ...sina);

  /* 过滤 + 跨源去重：同一事件的快讯只保留一条，但把各来源都记入 sources，
     前端按渠道着色展示，来源筛选按 sources 集合匹配（而非首源） */
  const seen = {};
  const rows = [];
  raw.forEach(x => {
    const t = (x.title || '') + ' ' + (x.summary || '');
    if (!t.trim()) return;
    if (POLITICAL.test(t)) return;
    if (kw && !kw.test(t)) return;
    const dk = nz(x.title) + '|' + nz(x.summary).slice(0, 40);
    if (seen[dk]) {
      /* 同源内重复直接忽略；跨源重复则合并来源，不丢渠道 */
      if (!seen[dk].sources.includes(x.src)) seen[dk].sources.push(x.src);
      return;
    }
    const item = {
      id: x.key || dk,
      title: x.title,
      summary: x.summary.slice(0, 140),
      tag: cfg.tag,
      source: x.src,
      sources: [x.src],
      time: x.time,
      url: x.url,
      /* 原文里提到的个股（字典匹配，未就绪时为空数组） */
      stocks: findStocks(t)
    };
    seen[dk] = item;
    rows.push(item);
  });

  /* 来源筛选：按 sources 集合匹配 */
  const filtered = src === 'all' ? rows : rows.filter(r => r.sources.includes(src));
  filtered.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  let list;
  if (src !== 'all') {
    list = filtered.slice(0, 40);
  } else {
    /* 默认「全部来源」视图：跨源轮转，保证每个渠道都有露出，
       最后仍按时间倒序排列（东财量大但同花顺/新浪的独立快讯不会被完全挤掉） */
    const buckets = {};
    filtered.forEach(r => { (buckets[r.source] = buckets[r.source] || []).push(r); });
    const lists = Object.keys(buckets).map(k => buckets[k]);
    const out = []; let added = true;
    while (out.length < 40 && added) {
      added = false;
      for (const l of lists) { if (l.length && out.length < 40) { out.push(l.shift()); added = true; } }
    }
    out.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    list = out;
  }
  ok(res, { tab, tag: cfg.tag, sources: NEWS_SRCS, src, list });
};

/* ---------- 个股相关资讯 ----------
   全市场 7×24 快讯池只有几十条，绝大多数个股一条都匹配不上（前端过滤后常年为 0），
   所以个股维度改以「交易所公告」为主 —— 按代码精确查询，稳定命中。
   实测：np-anotice-stock.eastmoney.com/api/security/ann?...&stock_list=600519
   返回 data.list（notice_date / title / art_code），单只票通常有上千条历史公告。 */
H['/stock-news'] = async (res, q) => {
  const code = (q.get('code') || '').trim()
  if (!code) return fail(res, '缺少 code 参数', 400)
  const limit = Math.min(20, Math.max(1, parseInt(q.get('limit')) || 10))
  /* days>0 时只保留近 N 天的资讯（前端「相关快讯」默认 3 天），0 表示不限 */
  const days = Math.max(0, Math.min(365, parseInt(q.get('days')) || 0))
  /* 有时间窗时多拉一些再过滤，否则「近 3 天」大概率一条不剩 */
  const fetchSize = days > 0 ? 60 : limit
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0

  const out = []
  try {
    const txt = await getJSON_Text(
      `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${fetchSize}` +
        `&page_index=1&ann_type=A&client_source=web&stock_list=${code}`
    )
    const j = JSON.parse(txt)
    const list = (j && j.data && j.data.list) || []
    list.forEach((x) => {
      const raw = String(x.title || '').trim()
      if (!raw) return
      const dateStr = String(x.notice_date || '')
      /* 时间窗过滤：解析失败的一律保留，避免误杀 */
      if (cutoff) {
        const ts = Date.parse(dateStr.replace(' ', 'T'))
        if (isFinite(ts) && ts < cutoff) return
      }
      /* 标题形如「贵州茅台:贵州茅台关于…的公告」—— 冒号前是公司简称，去掉避免重复 */
      const title = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : raw
      const ac = String(x.art_code || '')
      out.push({
        title,
        /* 拿不到 art_code 时退回该股的公告列表页 */
        url: ac
          ? `https://data.eastmoney.com/notices/detail/${code}/${ac}.html`
          : `https://data.eastmoney.com/notices/stock/${code}.html`,
        time: dateStr.slice(0, 16),
        tag: '公司公告',
        source: '东方财富',
        sources: ['东方财富'],
        summary: String(x.notice_type_name || '')
      })
      if (out.length >= limit) return
    })
  } catch (e) {
    /* 公告接口失败不抛错：前端还有全市场快讯那一路兜底 */
  }

  ok(res, { code, days, list: out })
}

/* ---------- 美股 ---------- */
H['/us'] = async (res, q) => {
  const kind = q.get('kind') || 'tech';
  if (kind === 'index') {
    /* 实测东财无 100.VIX / 100.RUI，请求它们会静默丢数据，只保留已验证的三个 */
    const ids = ['100.DJIA', '100.NDX', '100.SPX'];
    const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${ids.join(',')}&fields=f2,f3,f4,f12,f14&fltt=2&invt=2`);
    const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
    return ok(res, arr.map(x => ({
      code: String(x.f12), secid: '100.' + x.f12, name: x.f14 || String(x.f12),
      price: round(x.f2), change: round(x.f4), pct: round(x.f3), mktcap: 0
    })));
  }
  // 科技股：纳斯达克市值前列
  const arr = await clistGet('m:105', 'f20', 'f2,f3,f4,f12,f13,f14,f20', { pz: 30 });
  ok(res, arr.map(x => ({
    code: String(x.f12 || ''), secid: secidOf(x.f13, x.f12), name: x.f14 || '',
    price: round(x.f2), pct: round(x.f3), change: round(x.f4),
    mktcap: round(num(x.f20) / 1e8, 2)
  })).filter(s => s.code).slice(0, 20));
};

/* ---------- 搜索 ---------- */
H['/search'] = async (res, q) => {
  const kw = (q.get('q') || '').trim();
  if (!kw) return ok(res, []);
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=20`;
  const j = await getJSON(url);
  const arr = j?.QuotationCodeTable?.Data || [];

  /* type=14 是【全市场】模糊搜索，一次把 A股 / 港股 / 美股 / 韩股 / 债券 /
     场外基金 / 指数全塞回来。接口没有"只给某市场"的入参，只能靠
     Classify 白名单 + 代码格式双重过滤。

     旧版只留 AStock，于是站内明明有美股、港股两个模块，
     搜「NVDA」「00700」却是空的——上游其实返回了，被这里滤掉了。

     反过来，光靠 Classify 也不够：搜「00700」时上游会同时给出
       00700  Classify=HK        → 腾讯控股（要）
       000700 Classify=KRX       → 韩国 Eusu Holdings（不要）
       000700 Classify=OTCFUND   → 某货币基金（不要）
     后两个的代码同样是数字，只有格式校验能区分（港股是 5 位）。 */
  const ALLOW = {
    AStock:  { re: /^\d{6}$/, mkt: 'A股' },                        // 沪深 A 股
    HK:      { re: /^\d{5}$/, mkt: '港股' },                        // 港股
    UsStock: { re: /^[A-Za-z][A-Za-z0-9.-]{0,7}$/, mkt: '美股' }   // 美股 / 美股 ETF
  };
  const list = arr
    .filter(x => {
      const rule = ALLOW[x.Classify];
      return rule && rule.re.test(String(x.Code || ''));
    })
    .slice(0, 12);
  if (!list.length) return ok(res, []);

  /* 接口自带 QuoteID（形如 "0.000001"）即完整 secid，无需自行拼市场码 */
  const sidOf = x => x.QuoteID || secidOf(x.MktNum, x.Code);
  const ids = list.map(sidOf).join(',');
  let priceMap = {};
  try {
    const q2 = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f12,f13&fltt=2&invt=2`);
    const d = q2?.data?.diff ? (Array.isArray(q2.data.diff) ? q2.data.diff : Object.values(q2.data.diff)) : [];
    /* 按 secid 建索引而不是按 code：跨市场代码会撞车
       （000700 既是 A 股模塑科技，上游也会把它当韩股返回），
       按 code 建索引会让美股/港股串到 A 股的价格上 */
    d.forEach(x => { priceMap[secidOf(x.f13, x.f12)] = { price: round(x.f2), pct: round(x.f3) }; });
  } catch (e) {}

  ok(res, list.map(x => {
    const sid = x.QuoteID || secidOf(x.MktNum, x.Code);
    const p = priceMap[sid] || {};
    return {
      code: String(x.Code),
      secid: sid,
      name: x.Name,
      mkt: (ALLOW[x.Classify] || {}).mkt || '',
      price: p.price ?? 0, pct: p.pct ?? 0
    };
  }));
};

/* ---------- 个股详情快照 ----------
   push2 stock/get 的金额类字段是「放大 10^decimal 倍」的整数，
   必须按 f59（小数位）缩放后才能使用。 */
/* 个股快照：腾讯(主) → 东财(备)
   东财 push2/api/qt/stock/get 已不可用（返回空），腾讯 qt.gtimg.cn 稳定且字段更全 */

Object.assign(H, { NAME_MAP, NAME_STOP, NAME_TTL, NEWS_FEEDS, NEWS_KW, NEWS_SRCS, POLITICAL, buildNameMap, findStocks, kxFeed, nz, sinaFeed, startNameMapSchedule, thsFeed });
module.exports = H;
