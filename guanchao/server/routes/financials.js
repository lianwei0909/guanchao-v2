/* 由 server.js 机械拆分而来，行为未改动。 */
const { FY_KEY } = require('../config.js');
const { fail, ok } = require('../lib/respond.js');
const { fyGet } = require('./fuyao.js');
const { createCache } = require('../lib/cache.js');
const H = {};

function thscodeOf(code) {
  const c = String(code || '').trim()
  if (!c) return ''
  if (c.indexOf('.') > 0) return c.toUpperCase() // 已是 thscode
  const h = c.charAt(0)
  if (h === '6') return c + '.SH'
  if (h === '0' || h === '3') return c + '.SZ'
  if (h === '4' || h === '8') return c + '.BJ'
  return c + '.SH'
}

const FIN_ENDPOINT = {
  income: 'income-statements',
  balance: 'balance-sheets',
  cashflow: 'cash-flow-statements'
}
const FIN_TTL = 6 * 3600 * 1000 // 6 小时
const finCache = createCache({ name: 'financials', ttl: FIN_TTL, max: 500 })

/** 财务报表：type=income|balance|cashflow，period=annual|quarterly */
H['/financials'] = async (res, q) => {
  const code = (q.get('code') || '').trim()
  if (!code) return fail(res, '缺少 code 参数', 400)
  const type = FIN_ENDPOINT[q.get('type')] ? q.get('type') : 'income'
  const period = q.get('period') === 'quarterly' ? 'quarterly' : 'annual'
  const limit = Math.min(20, Math.max(1, parseInt(q.get('limit')) || 4))

  const ths = thscodeOf(code)
  const ck = `${ths}|${type}|${period}|${limit}`
  if (!FY_KEY) return ok(res, null) // 未配置密钥 → 前端降级
  try {
    /* 统一缓存：命中直接返回；未命中时并发的同类请求合并为一次上游调用 */
    const r = await finCache.wrap(ck, async () => {
      const d = await fyGet(
        `/api/a-share/financials/${FIN_ENDPOINT[type]}?thscode=${ths}&period=${period}&limit=${limit}`
      )
      return {
        thscode: ths,
        code,
        period,
        type,
        list: d?.item || [],
        source: 'ths'
      }
    })
    ok(res, Object.assign({}, r.data, { cached: r.cached }))
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    const msg = /429|rate limit|限流/i.test(m)
      ? '同花顺接口限流（约 20 秒/次），请稍后重试'
      : '财务数据获取失败：' + m
    fail(res, msg)
  }
}

/** 财务指标：report 形如 2025-1（一季报）/ 2025-2（中报）/ 2025-3（三季报）/ 2025-4（年报） */
H['/financial-indicators'] = async (res, q) => {
  const code = (q.get('code') || '').trim()
  const report = (q.get('report') || '').trim()
  if (!code || !report) return fail(res, '缺少 code 或 report 参数', 400)

  /* 财务指标仅覆盖 A 股（同花顺 a-share 源）。指数（如 HSI，纯字母）/ 美股 / 港股
     （5 位代码）无此数据，直接返回清晰提示而非把上游 502 透传给前端。 */
  if (/^[A-Za-z]/.test(code) || /^\d{5}$/.test(code)) {
    return fail(res, '财务指标仅支持 A 股（指数 / 美股 / 港股暂不可用）', 400)
  }

  const ths = thscodeOf(code)
  const ck = `IND|${ths}|${report}`
  if (!FY_KEY) return ok(res, null)
  try {
    const r = await finCache.wrap(ck, async () => {
      const d = await fyGet(`/api/a-share/financials/indicators?thscode=${ths}&report=${report}`)
      return {
        thscode: ths,
        code,
        report,
        abilities: d?.abilities || [],
        source: 'ths'
      }
    })
    ok(res, Object.assign({}, r.data, { cached: r.cached }))
  } catch (e) {
    /* 区分场景给提示：限流让用户等一下，未披露/无数据说明原因，其余透传上游信息 */
    const m = e instanceof Error ? e.message : String(e)
    const msg = /429|rate limit|限流/i.test(m)
      ? '同花顺接口限流（约 20 秒/次），请稍后重试'
      : /未披露|不存在|not found|invalid/i.test(m)
        ? `报告期 ${report} 暂无数据（可能尚未披露）`
        : '财务指标获取失败：' + m
    fail(res, msg)
  }
}

/* ---------- 对比分析：多股关键指标横向对比 ---------- */

Object.assign(H, { FIN_ENDPOINT, FIN_TTL, finCache, thscodeOf });
module.exports = H;
