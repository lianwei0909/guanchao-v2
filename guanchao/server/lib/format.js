/* 由 server.js 机械拆分而来，行为未改动。 */

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (v, d = 2) => Number(num(v).toFixed(d));

/* ===================================================================
   交易成本常量（REQUIREMENTS §4 · 唯一定义处，前端 api.js 有一份镜像）
   禁止在其它位置散落这些魔法数字。
   口径：
     佣金   万 2.5（0.025%），买卖双向，单笔最低 5 元
     印花税 卖出 0.05%
     过户费 0.001%，买卖双向
   双边成本 = 佣金×2 + 印花税 + 过户费×2
   按万元级金额估算约 0.152%（佣金触底 5 元），
   按大额（不触底）估算约 0.102%。
   =================================================================== */
const FEE = {
  commission: 0.00025,     // 佣金费率（万 2.5）
  commissionMin: 5,        // 单笔佣金下限（元）
  stampTax: 0.0005,        // 印花税（仅卖出）
  transfer: 0.00001        // 过户费（0.001%，双向）
};
/* 单边费用：dir='buy' | 'sell' */
function feeOf(amount, dir) {
  const a = Math.max(0, num(amount));
  const comm = Math.max(a * FEE.commission, FEE.commissionMin);
  const transfer = a * FEE.transfer;
  const stamp = dir === 'sell' ? a * FEE.stampTax : 0;
  return { commission: comm, transfer, stamp, total: comm + transfer + stamp };
}
/* 双边成本占金额比例（买入+卖出合计 / 金额） */
function roundTripCostPct(amount) {
  const a = Math.max(0, num(amount));
  if (a <= 0) return 0;
  return (feeOf(a, 'buy').total + feeOf(a, 'sell').total) / a;
}

/* ===================================================================
   标的解析
   市场码沿用东方财富：1=沪 0=深 105/106/107=美(纳斯达克/纽交所/美交所)
                       116=港股主板 128=港股创业板 100=港/外盘指数
   code 与 secid 二选一：
     - 传 secid（"1.000001"）时以它为准，指数/港美股必须靠它消除歧义
       （"000001" 既可能是上证指数也可能是平安银行）
     - 只传 code 时按形态推断：
         纯字母        → 美股（NVDA）
         5 位数字      → 港股（00700，腾讯、阿里都是 5 位）
         6/9/5/11 开头 → 沪市
         其余 6 位     → 深市
   =================================================================== */

const US_SUFFIX = ['.OQ', '.N', '.A'];

/* 今日日期 YYYYMMDD */
function today() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function todayDash() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 腾讯日 K（供 /compare、/forecast 复用）
   返回原始数组，每项 [日期, 开, 收, 高, 低, 量]
   注意：腾讯的收盘价是第 3 个（索引 2），不是标准 OHLC 的第 2 个

   ---------- D1 复权切换（REQUIREMENTS D1）----------
   fq = 'qfq'（前复权，默认，保持历史行为）| 'hfq'（后复权）| ''（不复权）
   实测记录（改动前务必读）：
     - param 末段即复权参数，透传即可，无需改域名或路径
     - hfq 时返回节点 key 为 `hfq`+period（如 hfqday）；qfq 时为 `qfq`+period
     - 指数（如 sh000300）不参与复权：无论传 qfq/hfq 都只回 `day` 节点
       → 解析处统一写 node[fq+p] || node[p] 才能同时兼容个股与指数
     - 日期区间的格式必须是 YYYY-MM-DD，传 20240801 会返回 {"code":0,"msg":"param error"}
     - qfq 会多返回 1 根（limit=10 回 11 根），按日期去重后无影响
   口径约定：所有回测 / 指标计算（A1/A2/B 组）一律用 hfq；
             看盘 K 线保持 qfq。原因：前复权的历史价在每次除权后整体平移，
             用它回测会产生「当时并不存在」的假买卖点。 */
/* 腾讯 K 线内存缓存：全市场截面要对几千只逐只拉 K 线，首次较慢，
   但切换周期 / 刷新时应直接命中缓存（秒回），避免重复打上游。
   按 sym|period|limit|fq 分桶，TTL 5 分钟（盘中 K 线变化不快，5 分钟够用）。 */

module.exports = { FEE, US_SUFFIX, feeOf, num, round, roundTripCostPct, today, todayDash };
