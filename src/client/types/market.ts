/* 行情数据类型定义 —— 字段与 server.js 的响应一一对应 */

/** 数据来源：em=东方财富 / ths=同花顺 */
export type DataSource = 'em' | 'ths'

export interface TopStock {
  rank: number
  name: string
  code: string
  secid: string
  price: number
  pct?: number
  amount?: number
  flow?: number
}

/** 全市场统计（涨跌家数 / 成交额 / 主力净流入） */
export interface MarketStat {
  total: number
  sample: number
  up: number
  down: number
  flat: number
  /** 停牌 / 无报价数量。快速模式置 null 表示未知 */
  suspend: number | null
  upPct: number
  downPct: number
  flatPct: number
  /** 成交额（万亿） */
  amount: number
  /** 成交额（亿元） */
  amountYi: number
  /** 主力净流入合计（亿元），快速模式为 null */
  mainFlow: number | null
  top10: TopStock[]
  topUp: TopStock[]
  topDown: TopStock[]
  topAmt: TopStock[]
  topFlowIn: TopStock[]
  topFlowOut: TopStock[]
  topFlat: TopStock[]
  source: DataSource
  /** true=尚未完成精确统计（快速模式），前端显示「精确统计中…」 */
  partial: boolean
  updatedAt: string
}

export interface IndexQuote {
  code: string
  name: string
  price: number
  pct: number
  change: number
  /** 成交额（亿元） */
  amount: number
  source?: DataSource
}

/** 市场指数（港股 / 美股 / 全球通用结构）*/
export interface MarketIndex {
  code: string
  secid: string
  name: string
  price: number
  pct: number
  change: number
  /** 成交额（亿元），部分市场不返回 */
  amount?: number
}
/** 港股板块/指数返回 { group, label, list } */
export interface HkSectorResp {
  group: string
  label: string
  list: MarketIndex[]
}

/** 美股板块（/api/us-sector）。市值单位亿美元，无数据时字段为 null */
export interface UsSectorRow {
  code: string
  secid: string
  name: string
  price: number | null
  pct: number | null
  change: number | null
  /** 总市值（亿美元） */
  mktcap: number | null
  pe: number | null
  pb: number | null
}
export interface UsSectorResp {
  group: string
  label: string
  list: UsSectorRow[]
}

/** 板块资金（行业 / 概念） */
export interface SectorRow {
  code: string
  secid: string
  name: string
  pct: number
  /** 主力净流入（亿元） */
  flow: number
  superAmt: number
  superPct: number
  bigAmt: number
  bigPct: number
  midAmt: number
  midPct: number
  smallAmt: number
  smallPct: number
  up: number
  down: number
  /** 领涨股 */
  lead: string
  leadCode: string
  leadPct: number
  leadSecid: string
}

/** 游资操作（/api/youzi）。金额单位亿元 */
export interface YouziSeat {
  /** 游资名号；未归类营业部以 deptShort 命名 */
  name: string
  rawName: string
  /** true=知名游资（能匹配到名号库） */
  isKnown: boolean
  /** 净买入（亿元），可为负 */
  net: number
  /** 涉及股票数 */
  stocks: number
  /** 关联营业部数 */
  depts: number
  /** 头像用首字 */
  initial: string
  /** 全部游资卡片中的排名（仅 hotSeats 有） */
  rank?: number
}
export interface YouziStock {
  code: string
  secid: string
  name: string
  price: number
  pct: number
  net: number
  buy: number
  sell: number
  turnover: number
  /** 龙虎榜成交额（亿元） */
  dealAmt: number
  reason: string
  /** 是否有机构参与 */
  inst: boolean
}
export interface YouziDetail {
  date: string
  code: string
  name: string
  /** 营业部全称 */
  dept: string
  /** 归入的游资名号 */
  youzi: string
  buy: number
  sell: number
  net: number
}
export interface YouziResp {
  /** 当前查询交易日 YYYY-MM-DD */
  date: string
  /** 上游最新交易日 */
  latest: string
  kpi: {
    /** 游资净买入合计（亿元） */
    netSum: number
    /** 上榜知名游资数 */
    seatCount: number
    stockCount: number
    dealAmt: number
    deptCount: number
  }
  /** 净买入 TOP10 */
  seatsRank: YouziSeat[]
  /** 净卖出 TOP10 */
  seatsSellRank: YouziSeat[]
  stocksRank: { buyTop: YouziStock[]; sellTop: YouziStock[] }
  /** 全部游资卡片（含排名） */
  hotSeats: YouziSeat[]
  /** 营业部级全量明细 */
  detail: YouziDetail[]
}

/** 游资画像（/api/youzi-portrait） */
export interface YouziPortrait {
  name: string
  /** 关联营业部全称列表 */
  depts: string[]
  trades: YouziDetail[]
  note?: string
}

/** 对比分析（/api/compare）。金额单位亿元，K 线衍生指标不足历史时为 null */
export interface CompareItem {
  code: string
  secid: string
  name: string
  price: number
  pct: number
  change: number
  /** 成交额（亿元） */
  amount: number
  amplitude: number
  turnover: number
  pe: number
  volumeRatio: number
  pb: number
  /** 总市值（亿元） */
  mktcap: number
  /** 主力净流入（亿元） */
  mainNetInflow: number
  /** 近 5 日涨幅 % */
  chg5: number | null
  /** 近 20 日涨幅 % */
  chg20: number | null
  ma5: number | null
  ma20: number | null
}

/** 预测 PP（/api/forecast）：量化选股结果 */
export interface ForecastRow {
  code: string
  secid: string
  name: string
  price: number
  pct: number
  amount: number
  turnover: number
  pe: number
  volumeRatio: number
  mktcap: number
  mainNetInflow: number
  ma5: number
  ma10: number
  ma20: number
  ma60: number
  /** 偏离 MA20 % */
  dev: number
  /** 主力净流入占成交额 % */
  netRatio: number
  /** 综合评分（均线40 + 资金25 + 量能20 + 位置15 + 资金强度加分） */
  score: number
  /** 均线多头排列 */
  bull: boolean
  /** 主力净流入为正 */
  cash: boolean
  /** 量比 > 1 */
  vol: boolean
  /** 偏离 MA20 < 15% */
  safe: boolean
  hi20: number
  lo20: number
  /** 目标价 */
  target: number
  /** 支撑位 */
  support: number
  /** 上涨空间 % */
  upside: number
  /** 距支撑下跌空间 % */
  risk: number
  /** 盈亏比，支撑过近时为 null */
  rr: number | null
  /** 强烈看多 / 看多 / 偏多 / 中性 */
  view: string
  /** 周线因子合成分（映射到 50~90） */
  qfScore: number | null
  /** 8 个周线因子明细 */
  qf: {
    mom_12_1: number
    rev_4: number
    low_vol_12: number
    amount_trend: number
    trend_dev: number
    trend_slope: number
    pos_52: number
    low_amp_8: number
    composite: number
  } | null
}
export interface ForecastResp {
  /** 选股日期 YYYY-MM-DD */
  date: string
  list: ForecastRow[]
}

/** 盘中监控（/api/signal）：单股分时异动 */
export interface SignalPoint {
  t: string
  p: number
  avg: number
  /** 价格对均线的偏离度 % */
  dev: number
}
export interface SignalMark {
  t: string
  price: number
  dev: number
}
export interface SignalResp {
  code: string
  name: string
  /** 异动判定阈值 %（由当日分时标准差推算） */
  threshold: number
  /** 高点异动 */
  high: SignalMark[]
  /** 低点异动 */
  low: SignalMark[]
  points: SignalPoint[]
}

/** 人气热度榜（/api/hot） */
export interface HotRow {
  code: string
  secid: string
  name: string
  price: number
  pct: number
  /** 人气值，由成交额换算，越活跃越高 */
  heat: number
  rank: number
  /** 走势方向：1=上涨 -1=下跌 */
  trend: number
}

/** 个股详情（/api/detail） */
export interface StockDetail {
  code: string
  name: string
  price: number
  pct: number
  change: number
  open: number
  high: number
  low: number
  preClose: number
  volume: number
  amount: number
  mktcap: number
  pe: number
  pb: number
  turnover: number
}

/** K 线（/api/kline）*/
export interface KlineItem {
  t: string
  o: number
  c: number
  h: number
  l: number
  v: number
}
export interface KlineResp {
  klines: KlineItem[]
}

/** 分时（/api/minute）*/
export interface MinutePoint {
  t: string
  p: number
  v: number
  amt: number
  avg: number
}
export interface MinuteResp {
  preClose: number
  points: MinutePoint[]
}

/** 批量行情（/api/quotes）*/
export interface Quote {
  code: string
  secid: string
  name: string
  price: number
  pct: number
  change: number
  turnover: number
  amplitude: number
  rate: number
  mktcap: number
}

/** 搜索结果（/api/search）*/
export interface SearchItem {
  code: string
  secid: string
  name: string
  mkt: string
  price: number
  pct: number
}

/** 自选股（本地 localStorage 持久化）*/
export interface WatchItem {
  code: string
  name: string
  secid: string
}

/** 排行（/api/rank）。金额类字段单位为亿元 */
export interface RankRow {
  code: string
  secid: string
  name: string
  price: number
  pct: number
  change: number
  /** 成交额（亿元）*/
  amount: number
  amplitude: number
  turnover: number
  pe: number
  volumeRatio: number
  pb: number
  /** 总市值（亿元）*/
  mktcap: number
  /** 主力净流入（亿元）*/
  mainNetInflow: number
}

/** 大宗交易 / 暗盘（/api/dark）*/
export interface DarkRow {
  code: string
  secid: string
  name: string
  /** 成交价 */
  price: number
  /** 当日收盘价 */
  close: number
  /** 溢价率 %（正=溢价，负=折价）*/
  premium: number
  /** 成交量（万股）*/
  volume: number
  /** 成交额（亿元）*/
  amount: number
  buyer: string
  seller: string
}
export interface DarkResp {
  /** 交易日 YYYY-MM-DD */
  date: string
  /** 近期可选交易日（降序），供日期选择器使用 */
  dates: string[]
  list: DarkRow[]
}

/** 财务报表（/api/financials）。金额单位：原币元 */
export interface FinancialRow {
  thscode: string
  ticker: string
  period: string
  fiscal_year: number
  fiscal_period: string
  report_date_ms: number
  period_end_ms: number
  currency: string
  /* 利润表 */
  operating_income?: number
  operating_costs?: number
  operating_profit?: number
  net_profit?: number
  parent_holder_net_profit?: number
  basic_eps?: number
  /* 资产负债表 */
  assets_total?: number
  total_current_assets?: number
  total_debt?: number
  holder_equity_total?: number
  cash?: number
  accounts_receivable?: number
  /* 现金流量表 */
  act_cash_flow_net?: number
  invest_cash_flow_net?: number
  financing_cash_flow_net?: number
  cash_equivalents_net_addition?: number
  [key: string]: unknown
}
export interface FinancialsResp {
  thscode: string
  code: string
  period: string
  type: string
  list: FinancialRow[]
  source: string
  cached: boolean
}

/** 财务指标（/api/financial-indicators）*/
export interface IndicatorItem {
  index_id: string
  value: string | null
}
export interface AbilityBlock {
  ability: string
  indicators: IndicatorItem[]

}
export interface IndicatorsResp {
  thscode: string
  code: string
  report: string
  abilities: AbilityBlock[]
  source: string
  cached: boolean
}

/** 模拟持仓项（本地 localStorage 持久化）*/
export interface PaperItem {
  code: string
  name: string
  secid: string
  shares: number
  cost: number
  ts: number
}

/** 快讯（/api/news）*/
export interface NewsItem {
  title: string
  url: string
  time: string
  tag?: string
  source?: string
  sources?: string[]
  summary?: string
}
export interface NewsResp {
  list: NewsItem[]
}

/** 涨跌停 / 炸板 / 连板（/api/fuyao-limit，同花顺 fuyao 源）。
    四个 kind 共用一套字段，各自用不到的字段为 null —— 避免为 4 个池建 4 个类型。 */
export interface LimitRow {
  code: string
  thscode: string
  name: string
  price: number
  pct: number
  /** 涨停时间 HH:mm（涨停池） */
  limitTime: string
  /** 涨停原因（涨停池），上游空串已标准化为 '' */
  reason: string
  /** 连板文本，如「首板」「5天4板」 */
  boardText: string
  /** 连板天数 */
  boardCnt: number | null
  /** 当前封单额（亿元） */
  sealMoney: number | null
  /** 峰值封单额（亿元） */
  maxSeal: number | null
  /** 首次 / 最后跌停时间（跌停池） */
  firstTime: string
  lastTime: string
  /** 开板次数（炸板池） */
  openTimes: number | null
  /** 换手率 % */
  turnoverPct: number | null
  /** 成交额（亿元） */
  turnover: number | null
  isST: boolean
  isNew: boolean
  /** 连板数（连板天梯） */
  board: number | null
  /** 次日是否继续封板（连板天梯），最近交易日为 null */
  sealNext: boolean | null
  /** 上游标记等级（连板天梯） */
  signLevel: number | null
}
export interface LimitResp {
  kind: string
  list: LimitRow[]
  /** 涨停 / 跌停 / 炸板池总数（连板天梯无此字段） */
  total?: number
  /** 连板天梯的交易日 YYYYMMDD */
  date?: string
}

/** 统一响应信封（与 server.js 的 ok() 一致） */
export interface ApiResponse<T> {
  ok: boolean
  msg?: string
  data: T
}
