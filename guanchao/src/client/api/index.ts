import type {
  ApiResponse,
  CompareItem,
  DarkResp,
  FinancialsResp,
  ForecastResp,
  HkSectorResp,
  HotRow,
  IndicatorsResp,
  IndexQuote,
  MarketIndex,
  KlineResp,
  LimitResp,
  MarketStat,
  MinuteResp,
  NewsResp,
  Quote,
  RankRow,
  RzrqRankResp,
  RzrqTrend,
  CalendarDay,
  ConceptDay,
  SearchItem,
  SectorRow,
  SignalResp,
  StockDetail,
  UsSectorResp,
  YouziPortrait,
  YouziResp,
  MlPredictResp,
  MlStatusResp
} from '@/types/market'

/* 与旧版 js/api.js 的 get() 保持一致：前缀 /api + no-store。
   这里用 TS 泛型把响应 data 的类型带出来，避免调用处 any 满天飞。 */
async function get<T>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const qs = params
    ? '?' +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&')
    : ''
  const r = await fetch(`/api${path}${qs}`, { cache: 'no-store' })
  const j = (await r.json()) as ApiResponse<T>
  if (!j.ok) throw new Error(j.msg || '接口异常')
  return j.data
}

/** POST 助手（ML 预测等写接口用） */
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const j = (await r.json()) as ApiResponse<T>
  if (!j.ok) throw new Error(j.msg || '接口异常')
  return j.data
}

export const api = {
  /** 全市场统计。mode='fast' 走指数字段（快，无主力净流入）；不传则翻全量（慢，有主力净流入） */
  marketStat: (mode?: 'fast') => get<MarketStat>('/market-stat', mode ? { mode } : undefined),
  /** 同花顺口径统计，未配置密钥时返回 null */
  fuyaoStat: () => get<MarketStat | null>('/fuyao-stat'),
  indices: (scope?: 'ashare') => get<IndexQuote[]>('/indices', scope ? { scope } : undefined),
  sectorCapital: (type: 'industry' | 'concept', sort: 'flow' | 'pct') =>
    get<SectorRow[]>('/sector-capital', { type, sort }),

  /** 个股详情 */
  detail: (code: string, secid?: string) => get<StockDetail>('/detail', { code, secid }),
  /** K 线：period = day / week / month */
  kline: (code: string, period: 'day' | 'week' | 'month' = 'day', limit = 120, secid?: string) =>
    get<KlineResp>('/kline', { code, period, limit, secid }),
  /** 分时 */
  minute: (code: string, secid?: string) => get<MinuteResp>('/minute', { code, secid }),

  /** 快讯：tab=all/a/hk/us/alert，src=all/东方财富/同花顺/新浪财经 */
  news: (tab = 'all', src = 'all') => get<NewsResp>('/news', { tab, src }),
  /** 个股相关资讯：以交易所公告为主（按代码精确查询）。days>0 时只取近 N 天 */
  stockNews: (code: string, limit = 10, days = 0) =>
    get<NewsResp>('/stock-news', { code, limit, days: days > 0 ? days : undefined }),

  /** 批量行情 */
  quotes: (codes: string[]) => get<Quote[]>('/quotes', { codes: codes.join(',') }),
  /** 代码 / 名称搜索 */
  search: (kw: string) => get<SearchItem[]>('/search', { q: kw }),

  /** 排行：mkt=all/sh/sz/cyb/kcb/bj，dim=changePct/changePctD/amount/... */
  rank: (mkt = 'all', dim = 'changePct', limit = 50) =>
    get<RankRow[]>('/rank', { mkt, dim, limit }),

  /** 大宗交易 / 暗盘监控。传 date=YYYY-MM-DD 可查指定交易日 */
  dark: (date?: string) => get<DarkResp>('/dark', date ? { date } : undefined),

  /** 财务报表（同花顺源）。type=income|balance|cashflow */
  financials: (
    code: string,
    type: 'income' | 'balance' | 'cashflow' = 'income',
    period: 'annual' | 'quarterly' = 'annual',
    limit = 4
  ) => get<FinancialsResp>('/financials', { code, type, period, limit }),
  /** 财务指标（同花顺源）。report 形如 2025-4 */
  financialIndicators: (code: string, report: string) =>
    get<IndicatorsResp>('/financial-indicators', { code, report }),

  /* ---- 游资 / 龙虎榜 ---- */
  /** 游资操作（龙虎榜聚合）。date=YYYY-MM-DD 可查指定交易日 */
  youzi: (date?: string) => get<YouziResp>('/youzi', date ? { date } : undefined),
  /** 游资画像：某游资名号下的关联营业部 + 近期交易明细 */
  youziPortrait: (name: string, date?: string) =>
    get<YouziPortrait>('/youzi-portrait', date ? { name, date } : { name }),

  /** 对比分析：codes 最多 6 个，支持 code 或 secid */
  compare: (codes: string[]) => get<CompareItem[]>('/compare', { codes: codes.join(',') }),

  /** 盘中监控：单股分时异动（需传 code） */
  signal: (code: string) => get<SignalResp>('/signal', { code }),

  /** 预测 PP：量化选股（均线多头 + 资金 + 量能 + 位置）。h=ultra/short/mid/long；force=true 绕过当日缓存强制重算 */
  forecast: (h?: 'ultra' | 'short' | 'mid' | 'long', force = false) =>
    get<ForecastResp>('/forecast', { ...(h ? { h } : undefined), ...(force ? { force: '1' } : undefined) }),

  /* ---- 各大市场指数（全景盘面「市场总览」用，东财源）---- */
  /** 港股指数 / 板块：index|mainboard|hsblue|etf|hot|gain|gem
      注意：后端读的是 g 参数（不是 kind），传错会静默回退到 index 分组 */
  hkIndex: (kind = 'index') => get<HkSectorResp>('/hk-sector', { g: kind }),
  /** 美股指数：道指 / 纳指 / 标普 */
  usIndex: () => get<MarketIndex[]>('/us', { kind: 'index' }),
  /** 美股板块：g=tech|chip|china|ev|retail|finance|medical|energy|comm|etf|consumer|industrial|reit */
  usSector: (g = 'tech') => get<UsSectorResp>('/us-sector', { g }),
  /** 全球主要指数 */
  globalIndex: () => get<MarketIndex[]>('/global'),

  /** 人气热度榜（成交额换算人气值） */
  hot: () => get<HotRow[]>('/hot'),

  /** 涨跌停 / 炸板 / 连板（同花顺源）。kind=涨停 up | 跌停 down | 炸板 break | 连板天梯 ladder */
  fuyaoLimit: (kind: 'up' | 'down' | 'break' | 'ladder', size = 50) =>
    get<LimitResp>('/fuyao-limit', { kind, size }),

  /** 融资融券（同花顺源）。op=trend 全市场走势 / op=rank 余额排名（type=ggList|hyList|gnList） */
  rzrq: (
    op: 'trend' | 'rank',
    params?: { type?: 'ggList' | 'hyList' | 'gnList'; sort?: string; len?: number }
  ) => get<RzrqTrend | RzrqRankResp>('/rzrq', { op, ...params }),

  /** 财经日历（财联社源，按日分组） */
  calendar: () => get<CalendarDay[]>('/calendar'),

  /** 每日炒作题材（同花顺源，按日分组） */
  concept: () => get<ConceptDay[]>('/concept'),

  /** AI 解读层（SSE 流式）。返回 fetch Response（调用方用 readSSE 消费）。
      body: { kind, ask?, ctx(字符串或对象), history? } */
  aiRaw: (body: { kind: string; ask?: string; ctx: unknown; history?: { role: string; content: string }[] }) =>
    fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),

  /* ---- ML 预测引擎（Python 服务）---- */
  /** 引擎健康/在线状态 */
  mlStatus: () => get<MlStatusResp>('/ml/status'),
  /** 多模型预测：codes 最多约 8 只（训练较重）。period=day/week/month，horizon=short/mid/long */
  mlPredict: (payload: { codes?: string[]; period?: string; horizon?: string; limit?: number }) =>
    post<MlPredictResp>('/ml/predict', payload)
}
