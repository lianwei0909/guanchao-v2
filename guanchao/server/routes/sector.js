/* 由 server.js 机械拆分而来，行为未改动。 */
const { EM } = require('../config.js');
const { clistGet, clistPage } = require('../datasource/em.js');
const { num, round } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { secidOf } = require('../lib/secid.js');
const { mapLimit } = require('../lib/util.js');
const { createCache } = require('../lib/cache.js');
const H = {};

const SEC_TYPE = { industry: 'm:90+t:2', concept: 'm:90+t:3', area: 'm:90+t:1' };
/* 板块资金缓存（按 type|sort 分组）：概念约 500 个板块要翻 6 页（实测 ~0.76s），
   前端每 25 秒刷新一次，无缓存时每次都会重新打上游并占用多个闸门名额。
   走统一缓存后并发请求会合并，定时预热与前台轮询不再重复打上游。 */
const SEC_CAP_TTL = 30000;
const secCapCache = createCache({ name: 'sector-capital', ttl: SEC_CAP_TTL, max: 16 });

H['/sector-capital'] = async (res, q) => {
  const type = SEC_TYPE[q.get('type')] ? q.get('type') : 'industry';
  const sort = q.get('sort') === 'pct' ? 'f3' : 'f62';
  const ck = type + '|' + sort;
  /* 统一缓存：命中直接返回；未命中时并发的同类请求合并为一次上游调用 */
  const { data } = await secCapCache.wrap(ck, async () => {
  /* 资金拆解字段（已实测）：
       f62 主力净流入  f66 超大单净额 f69 超大单占比
       f72 大单净额    f75 大单占比   f78 中单净额 f81 中单占比
       f84 小单净额    f87 小单占比 */
  const F = 'f2,f3,f12,f13,f14,f62,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f128,f136,f140,f141,f204,f205,f206';
  /* 单次 clist 硬上限 pz=100，行业约 90、概念约 380，必须翻页才能拿到
     全部板块（否则只返回「主力净流入最高」的板块，净流出的板块被截断，
     前端「主力净流出 TOP」会变成「暂无」）。按 sort 降序翻页即可同时覆盖两端。 */
  const first = await clistPage(SEC_TYPE[type], sort, F, { po: 1, pz: 100 });
  const total = first.total || first.arr.length;
  const pages = Math.min(8, Math.ceil(total / 100));   // 封顶 800，防异常
  const rows = first.arr.slice();
  if (pages > 1) {
    const rest = await mapLimit(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      4,
      pn => clistPage(SEC_TYPE[type], sort, F, { po: 1, pz: 100, pn }).catch(() => ({ arr: [] }))
    );
    rest.forEach(r => { if (r && r.arr) rows.push(...r.arr); });
  }
  const seen = {};
  const data = rows.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    pct: round(x.f3),
    flow: round(num(x.f62) / 1e8, 2),          // 主力净流入（亿元）
    /* 资金拆解：净额（亿元）+ 占比（%） */
    superAmt: round(num(x.f66) / 1e8, 2), superPct: round(x.f69),
    bigAmt: round(num(x.f72) / 1e8, 2), bigPct: round(x.f75),
    midAmt: round(num(x.f78) / 1e8, 2), midPct: round(x.f81),
    smallAmt: round(num(x.f84) / 1e8, 2), smallPct: round(x.f87),
    up: num(x.f104), down: num(x.f105),
    lead: x.f128 || '',                        // 领涨股
    leadCode: String(x.f140 || ''),
    leadPct: round(x.f136),
    leadSecid: secidOf(x.f141, x.f140)
  })).filter(s => s.name && !seen[s.secid] && (seen[s.secid] = 1));
    return data;
  });
  ok(res, data);
};

/* ---------- 美股板块行情 ---------- */
const US_GROUPS = {
  tech:    { l: '科技巨头', items: [['AAPL','苹果'],['MSFT','微软'],['NVDA','英伟达'],['GOOGL','谷歌A'],['AMZN','亚马逊'],['META','Meta'],['TSLA','特斯拉'],['NFLX','奈飞'],['ORCL','甲骨文'],['CRM','赛富时'],['ADBE','Adobe'],['CSCO','思科']] },
  chip:    { l: '半导体', items: [['NVDA','英伟达'],['AMD','AMD'],['INTC','英特尔'],['QCOM','高通'],['TXN','德州仪器'],['MU','美光'],['AMAT','应用材料'],['LRCX','拉姆研究'],['KLAC','科磊'],['ARM','ARM'],['TSM','台积电'],['ASML','阿斯麦'],['MRVL','迈威尔'],['NXPI','恩智浦']] },
  china:   { l: '中概股', items: [['BABA','阿里巴巴'],['JD','京东'],['BIDU','百度'],['PDD','拼多多'],['NIO','蔚来'],['XPEV','小鹏'],['LI','理想'],['TME','腾讯音乐'],['BILI','哔哩哔哩'],['BEKE','贝壳'],['FUTU','富途控股'],['NTES','网易'],['TCOM','携程'],['ZTO','中通快递']] },
  ev:      { l: '电动车 / 新能源', items: [['TSLA','特斯拉'],['RIVN','Rivian'],['LCID','Lucid'],['F','福特'],['GM','通用汽车'],['PLUG','普拉格能源'],['ENPH','Enphase'],['FSLR','First Solar'],['NEE','新纪元能源'],['ALB','雅保'],['CHPT','ChargePoint']] },
  retail:  { l: '消费 / 零售', items: [['KO','可口可乐'],['PEP','百事'],['MCD','麦当劳'],['SBUX','星巴克'],['WMT','沃尔玛'],['COST','好市多'],['TGT','塔吉特'],['NKE','耐克'],['PG','宝洁'],['HD','家得宝'],['LOW','劳氏'],['EBAY','eBay']] },
  finance: { l: '金融', items: [['JPM','摩根大通'],['BAC','美国银行'],['WFC','富国银行'],['GS','高盛'],['MS','摩根士丹利'],['C','花旗'],['AXP','美国运通'],['V','Visa'],['MA','万事达'],['BRK.B','伯克希尔B'],['BLK','贝莱德'],['SCHW','嘉信理财']] },
  medical: { l: '医疗健康', items: [['JNJ','强生'],['UNH','联合健康'],['LLY','礼来'],['PFE','辉瑞'],['MRK','默沙东'],['ABBV','艾伯维'],['TMO','赛默飞'],['ABT','雅培'],['DHR','丹纳赫'],['AMGN','安进'],['GILD','吉利德'],['CVS','CVS健康']] },
  energy: { l: '能源/材料/工业', items: [['XOM','埃克森美孚'],['CVX','雪佛龙'],['SLB','斯伦贝谢'],['CAT','卡特彼勒'],['GE','通用电气'],['HON','霍尼韦尔'],['UNP','联合太平洋'],['BA','波音'],['LMT','洛克希德马丁'],['RTX','雷神技术'],['DE','迪尔'],['MMM','3M']] },
  comm: { l: '通信/媒体/互联网成长股', items: [['GOOGL','谷歌A'],['META','Meta'],['NFLX','奈飞'],['DIS','迪士尼'],['TMUS','T-Mobile'],['VZ','威瑞森'],['SPOT','Spotify'],['SNAP','Snap'],['UBER','优步'],['LYFT','Lyft'],['Roku','Roku'],['PIN','Pinterest']] },
  etf: { l: 'ETF / 指数', items: [['SPY','标普500 ETF'],['QQQ','纳斯达克100 ETF'],['IWM','罗素2000 ETF'],['IWB','罗素1000 ETF'],['VTI','全市场ETF'],['GLD','黄金ETF'],['TLT','20年+国债ETF'],['HYG','高收益债ETF'],['EEM','新兴市场ETF'],['VWO','新兴市场ETF'],['IJH','中盘400 ETF'],['IJR','小盘600 ETF']] },
  consumer: { l: '消费日常', items: [['KO','可口可乐'],['PEP','百事'],['MCD','麦当劳'],['SBUX','星巴克'],['WMT','沃尔玛'],['COST','好市多'],['TGT','塔吉特'],['NKE','耐克'],['PG','宝洁'],['CL','高露洁'],['KMB','金佰利'],['EL','雅诗兰黛']] },
  industrial: { l: '工业制造', items: [['CAT','卡特彼勒'],['GE','通用电气'],['HON','霍尼韦尔'],['UNP','联合太平洋'],['UPS','联合包裹'],['FDX','联邦快递'],['RTX','雷神技术'],['LMT','洛克希德马丁'],['DE','迪尔'],['CMI','康明斯'],['ETN','伊顿'],['DOV','多佛']] },
  reit: { l: 'REITs', items: [['PLD','普洛斯达'],['AMT','美国塔楼'],['EQIX','Equinix'],['DLR','数字地产'],['VICI','维西'],['O','Realty Income'],['AVB','AvalonBay'],['SBAC','SBA Communications'],['PSA','公共存储'],['WELL','Welltower'],['EXR','Extra Space'],['MAA','MAA']] }
};
H['/us-sector'] = async (res, q) => {
  const g = q.get('g') || 'tech';
  const grp = US_GROUPS[g] || US_GROUPS.tech;
  const secids = grp.items.map(([c]) => `105.${c}`).join(',');
  /* f20 总市值 f21 流通市值 f114 市盈率(动) f115 市净率 —— 均已实测可用 */
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${secids}` +
    `&fields=f2,f3,f4,f12,f13,f14,f20,f21,f114,f115&fltt=2&invt=2`);
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  const map = {};
  arr.forEach(x => { map[String(x.f12)] = x; });
  ok(res, {
    group: g,
    label: grp.l,
    list: grp.items.map(([code, cn]) => {
      const x = map[code];
      return {
        code, secid: '105.' + code,
        name: (x && x.f14) ? String(x.f14) : cn,
        price: x ? round(x.f2) : null,
        pct: x ? round(x.f3) : null,
        change: x ? round(x.f4) : null,
        mktcap: x ? round(num(x.f20) / 1e8, 2) : null,   // 总市值（亿美元）
        pe: x ? round(x.f114) : null,
        pb: x ? round(x.f115) : null
      };
    })
  });
};

/* ---------- 港股行情 ----------
   踩坑记录：
     1) 港股个股用 ulist.np/get + 116.xxxxx，clist 主域被封（走 clistGet 降级）
     2) 恒生指数是 100.HSI，恒生科技是 124.HSTECH，红筹 124.HSCCI（116.HSI 返回 null）
     3) 组件名一律以接口 f14 为准 —— 之前手写名称大量张冠李戴
        （09918 是丽年国际不是京东、09896 是名创优品不是小米、09990 是祖龙娱乐不是海尔智家）
        这里的中文只作为接口缺数据时的兜底 */
const HK_GROUPS = {
  index: { l: '主要指数', secids: [
    ['100.HSI', '恒生指数'], ['124.HSTECH', '恒生科技'],
    ['100.HSCEI', '国企指数'], ['124.HSCCI', '红筹指数']
  ]},
  hsblue: { l: '恒生科技', secids: [
    ['116.09988', '阿里巴巴-W'], ['116.09888', '百度集团-SW'], ['116.09618', '京东集团-SW'],
    ['116.03690', '美团-W'], ['116.09626', '哔哩哔哩-W'], ['116.09868', '小鹏集团-W'],
    ['116.02015', '理想汽车-W'], ['116.01810', '小米集团-W'], ['116.06618', '京东健康'],
    ['116.09698', '万国数据-SW'], ['116.00981', '中芯国际'], ['116.02382', '舜宇光学科技'],
    ['116.09999', '网易'], ['116.01024', '快手-W'], ['116.00241', '阿里健康'],
    ['116.01833', '平安好医生'], ['116.03888', '金山软件'], ['116.00268', '金蝶国际'],
    ['116.01347', '华虹宏力'], ['116.00285', '比亚迪电子'], ['116.02018', '瑞声科技'],
    ['116.06060', '众安在线']
  ]},
  mainboard: { l: '主板蓝筹', secids: [
    ['116.00700', '腾讯控股'], ['116.00939', '建设银行'], ['116.01398', '工商银行'],
    ['116.03988', '中国银行'], ['116.00941', '中国移动'], ['116.02318', '中国平安'],
    ['116.02883', '中海油田服务'], ['116.06030', '中信证券'], ['116.00386', '中国石油化工股份'],
    ['116.01088', '中国神华'], ['116.02628', '中国人寿'], ['116.00002', '中电控股'],
    ['116.00003', '香港中华煤气'], ['116.00006', '电能实业'], ['116.00011', '恒生银行'],
    ['116.00012', '恒基地产'], ['116.00016', '新鸿基地产'], ['116.00019', '太古股份公司A'],
    ['116.00083', '信和置业'], ['116.00101', '恒隆地产'], ['116.00388', '香港交易所'],
    ['116.00688', '中国海外发展'], ['116.00857', '中国石油股份'], ['116.01038', '长江基建集团']
  ]},
  etf: { l: 'ETF', secids: [
    ['116.02800', '盈富基金'], ['116.03033', '南方恒生科技'], ['116.03188', '华夏沪深三百'],
    ['116.03001', 'PP中地美债'], ['116.02823', '安硕A50'], ['116.02812', '三星中国龙网'],
    ['116.07200', '南方两倍看多恒指'], ['116.07552', '南方两倍做空恒生科技'],
    ['116.03032', '恒生科技ETF'], ['116.02822', '南方A50']
  ]},
  /* 动态分组：走 clistGet（域名降级），实时取当日榜单 */
  hot:  { l: '成交额榜', fs: 'm:128+t:1,m:128+t:2,m:128+t:3,m:128+t:4', fid: 'f6', pz: 30 },
  gain: { l: '涨幅榜',   fs: 'm:128+t:1,m:128+t:2,m:128+t:3,m:128+t:4', fid: 'f3', pz: 30 },
  gem:  { l: '创业板',   fs: 'm:128+t:4', fid: 'f6', pz: 30 }
};
H['/hk-sector'] = async (res, q) => {
  const g = q.get('g') || 'index';
  const grp = HK_GROUPS[g] || HK_GROUPS.index;

  /* 动态分组：直接返回榜单，名称用接口原文 */
  if (grp.fs) {
    const arr = await clistGet(grp.fs, grp.fid, 'f2,f3,f4,f6,f12,f13,f14', { pz: grp.pz });
    return ok(res, {
      group: g, label: grp.l,
      list: arr.filter(x => x && x.f14).map(x => {
        const code = String(x.f12 || '');
        /* clist 返回的市场码是 128，但详情页走的是 116 前缀 —— 统一成 116 */
        return {
          code, secid: '116.' + code,
          name: String(x.f14), price: round(x.f2), pct: round(x.f3),
          change: round(x.f4), amount: round(num(x.f6) / 1e8, 2)
        };
      })
    });
  }

  /* 固定分组：ulist 批量查，名称以 f14 为准 */
  const secids = grp.secids.map(x => x[0]).join(',');
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${secids}` +
    `&fields=f2,f3,f4,f6,f12,f13,f14&fltt=2&invt=2`);
  const d = j?.data?.diff;
  const arr = d ? (Array.isArray(d) ? d : Object.values(d)) : [];
  const map = {};
  arr.forEach(x => { if (x && x.f12 != null) map[String(x.f12)] = x; });

  ok(res, {
    group: g, label: grp.l,
    list: grp.secids.map(([sid, fallback]) => {
      const code = sid.slice(sid.indexOf('.') + 1);
      const x = map[code];
      return {
        code, secid: sid,
        name: (x && x.f14) ? String(x.f14) : fallback,
        price: x ? round(x.f2) : null,
        pct: x ? round(x.f3) : null,
        change: x ? round(x.f4) : null,
        amount: x ? round(num(x.f6) / 1e8, 2) : null
      };
    })
  });
};

/* ---------- 游资操作：游资作战室 · 龙虎榜 ----------
   数据源：
     1) RPT_DAILYBILLBOARD_DETAILSNEW  —— 个股维度（每只上榜股票的买卖总额、涨跌幅、上榜原因）
     2) RPT_OPERATEDEPT_TRADE_DETAILS  —— 营业部级明细（每个营业部在每只股票上的买/卖/净额）
   把营业部明细按「知名游资名号」聚合，得到目标站同款的：
     游资净买入/卖出 TOP10、个股净买入/卖出 TOP10、游资卡片列表、游资画像（关联营业部 + 近期交易）。 */

Object.assign(H, { HK_GROUPS, SEC_CAP_TTL, SEC_TYPE, US_GROUPS, secCapCache });
module.exports = H;
