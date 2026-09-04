/* 由 server.js 机械拆分而来，行为未改动。 */
const { EMD } = require('../config.js');
const { num, round } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { secidOf } = require('../lib/secid.js');
const H = {};

H['/dark'] = async (res, q) => {
  const BASE = `${EMD}/api/data/v1/get?reportName=RPT_DATA_BLOCKTRADE&columns=ALL&source=WEB&client=WEB`;
  const dateQ = (q.get('date') || '').trim();

  /* 概览请求：按 日期+成交额 降序。既用于取最新交易日数据，也用于提取可选日期列表 */
  const oj = await getJSON(
    `${BASE}&pageNumber=1&pageSize=300&sortColumns=TRADE_DATE,DEAL_AMT&sortTypes=-1,-1`
  ).catch(() => null);
  const oarr = oj?.result?.data || [];

  const dates = [];
  oarr.forEach(x => {
    const d = String(x.TRADE_DATE || '').slice(0, 10);
    if (d && dates.indexOf(d) < 0) dates.push(d);
  });

  let arr = [];
  const target = dateQ || dates[0] || '';

  /* 未指定日期 → 直接复用概览里最新交易日的数据，零额外请求 */
  if (!dateQ && target) {
    arr = oarr.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === target);
  }
  /* 指定了日期（或概览未覆盖）→ 用 filter 精确查询，保证拿到该日完整数据 */
  if ((dateQ || !arr.length) && target) {
    const filter = encodeURIComponent(`(TRADE_DATE='${target}')`);
    const dj = await getJSON(
      `${BASE}&pageNumber=1&pageSize=200&sortColumns=DEAL_AMT&sortTypes=-1&filter=${filter}`
    ).catch(() => null);
    const darr = dj?.result?.data || [];
    if (darr.length) arr = darr;
  }

  ok(res, {
    date: target,
    dates: dates.slice(0, 10),
    /* 不截断：合计成交额、平均溢价率等 KPI 需基于该日完整数据。
       上游 pageSize=200 已设上限，个别超量交易日按上游返回为准。 */
    list: arr.map(x => {
      const code = String(x.SECURITY_CODE || '');
      return {
        code,
        secid: secidOf(undefined, code),
        name: x.SECURITY_NAME_ABBR || '',
        price: round(x.DEAL_PRICE),
        close: round(x.CLOSE_PRICE),
        premium: round(x.PREMIUM_RATIO),        // 溢价率 %
        volume: round(num(x.DEAL_VOLUME) / 1e4, 2),  // 万股
        amount: round(num(x.DEAL_AMT) / 1e8, 4),     // 亿元
        buyer: x.BUYER_NAME || '',
        seller: x.SELLER_NAME || ''
      };
    }).filter(s => s.code)
  });
};

/* ===================================================================
   同花顺（fuyao）财务数据代理
   - 财务报表：/api/a-share/financials/{income,balance,cashflow}-statements
   - 财务指标：/api/a-share/financials/indicators（成长/盈利/偿债/营运/现金流 五类）
   注意：同花顺公开 API 无大宗交易端点（data.10jqka.com.cn/market/dzjy 未开放），
   故暗盘监控仍只用东财源。
   限流约 20 秒/次，而财报按季度才更新，这里缓存 6 小时，避免把密钥打废。
   =================================================================== */

/** 6 位 A 股代码 → 同花顺 thscode（600519.SH / 000001.SZ / 430047.BJ） */

module.exports = H;
