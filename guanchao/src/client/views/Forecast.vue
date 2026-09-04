<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { ForecastRow, MlRow, MlPredictResp, MlStatusResp } from '@/types/market'
import { cl, fx, pc, sg, yi } from '@/utils/format'
import { usePaperStore } from '@/stores/paper'
import { useForecastStore, type MlFailItem } from '@/stores/forecast'
import { setAiContext } from '@/utils/aiContext'
import LoadingOverlay from '@/components/LoadingOverlay.vue'
import StockDetailModal from '@/components/StockDetailModal.vue'

/* 预测 PP（对应旧版 renderForecast / loadForecast）。
   按持股周期分三档：短线(日K) / 中线(周K) / 长线(月K)，各自用对应周期的均线多头 +
   资金 + 量能 + 位置安全 打分；命中 score>=50 才入选。
   注意：目标价/支撑位由对应周期 K 线推导，属技术位参考，非收益承诺。 */
type Horizon = 'ultra' | 'short' | 'mid' | 'long'
/** 四种周期：标签 + 持股时间窗口（与后端 FORECAST_HORIZONS 对齐） */
const HORIZONS: { k: Horizon; label: string; window: string }[] = [
  { k: 'ultra', label: '超短线', window: '1~3 天' },
  { k: 'short', label: '短线', window: '1~2 周' },
  { k: 'mid', label: '中线', window: '1~3 个月' },
  { k: 'long', label: '长线', window: '6~12 个月' }
]
const rows = ref<ForecastRow[]>([])
const date = ref('')
/** horizon 已收进 forecast store（ms.horizon），切换页面/周期保持显示 */
const windowLabel = ref('')
/** 当前持股周期中文标签（超短线/短线/中线/长线），综合预测构成展示用 */
const horizonLabel = computed(() => HORIZONS.find(h => h.k === ms.horizon)?.label || '')
const sampleSize = ref(0)
/** 真正参与技术面横截面的样本数（口径透明：横截面是在这个池子里算的） */
const techSize = ref(0)
const loading = ref(true)
const error = ref('')
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)
/** 「重新预测」进行中（强制重算四条线） */
const refetching = ref(false)
/** 预测中（切换周期或重新预测任一为真）：用于显示居中提示并隐藏旧股票，与切换逻辑一致 */
const predicting = computed(() => loading.value || refetching.value)
/** 展开因子明细的行 */
const expanded = ref<string | null>(null)

/* ---------------- ML 模型预测（与预测 PP 融合） ----------------
   对当前全部入选标的调用 /api/ml/predict：随机森林 / SVM / XGBoost / LSTM /
   Transformer 多模型训练 + 集成投票。纯 numpy 训练较重（首次每只约数十秒，
   Python 进程内缓存 30 分钟，二次训练秒回）。
   结果不单独成列展示，而是与技术面规则（预测 PP）按权重融合后，统一输出到
   「涨概率 / 预期收益」两列；未运行或服务离线时自动退化为技术面口径。
   打开页面即自动训练（展示融合结果）；「⚡ 综合预测」按钮才是从底层
   强制重新选股 + 重新训练。 */
/** ML 服务是否在线（挂载时探测）；离线时降级为纯技术面口径 */
const mlOnline = ref<boolean | null>(null)
/** ML 训练状态：跨路由持久化，收进 store（切换页面不丢，除非重新预测） */
const ms = useForecastStore()
/** 周期训练完成提示（浮窗 5s） */
const trainMsg = ref('')
let trainTimer: number | undefined

/** 预测 PP 周期 → ML {period, horizon} 映射（保持前瞻口径一致） */
function mlParams(h: Horizon): { period: string; horizon: string } {
  switch (h) {
    case 'ultra': return { period: 'day', horizon: 'short' }   // 1~3 天
    case 'short': return { period: 'day', horizon: 'mid' }     // 1~2 周
    case 'mid': return { period: 'week', horizon: 'mid' }      // 1~3 月
    case 'long': return { period: 'month', horizon: 'mid' }    // 6~12 月
  }
}

/* ---- ML 按周期顺序训练（全周期扫描）----
   打开 PP 后默认训当前页周期；随后在后台把全部周期（超短→短→中→长）各训一遍，
   中途切换页面/周期不中断当前训练，训完提示该周期完成，再补训未完成的、跳过已完成的。
   sweepSeq 用来在「重新预测」(force) 时让旧扫描作废，避免回写覆盖新结果。 */
const TRAIN_ORDER: Horizon[] = ['ultra', 'short', 'mid', 'long']
let sweepSeq = 0
/** 周期中文标签 */
function periodLabel(h: string): string {
  return HORIZONS.find(x => x.k === h)?.label || h
}

/** 训练单个周期 h（分批 5 只），写入 store.mlByPeriod[h]，训完提示。
   代码自行拉取该周期选股结果，切换页面/周期后组件卸载也不依赖本地 rows。 */
async function trainPeriod(h: Horizon, mySweep: number) {
  ms.mlCurrentPeriod = h
  ms.mlDone = 0
  let list: ForecastRow[] = []
  try {
    const d = await api.forecast(h)
    list = d.list || []
  } catch {
    /* 拉取失败交给下面的空 codes 处理 */
  }
  const codes = list.map(r => r.code)
  if (!codes.length) {
    ms.setPeriodError(h, '当前无入选标的')
    return
  }
  ms.mlCount = codes.length
  const p = mlParams(h)
  const m: Record<string, MlRow> = {}
  const fails: MlFailItem[] = []
  const BATCH = 5
  let elapsed = 0
  let etaTotal = 0
  for (let i = 0; i < codes.length; i += BATCH) {
    if (mySweep !== sweepSeq) return // 已被更新的扫描取代，丢弃本次结果
    const batch = codes.slice(i, i + BATCH)
    try {
      const d: MlPredictResp = await api.mlPredict({ codes: batch, period: p.period, horizon: p.horizon, limit: batch.length })
      elapsed += d.elapsed_s || 0
      etaTotal += d.eta_s || 0
      ;(d.results || []).forEach((x: MlRow) => {
        if (x.error) {
          const nm = list.find(r => r.code === x.code)?.name || x.code
          fails.push({ code: x.code, name: nm, reason: x.error })
        } else {
          m[x.code] = x
        }
      })
    } catch (e) {
      // 整批请求失败：这批全部记为未训到，附原因（避免静默丢失）
      const msg = e instanceof Error ? e.message : 'ML 预测失败'
      batch.forEach(c => {
        const nm = list.find(r => r.code === c)?.name || c
        fails.push({ code: c, name: nm, reason: msg })
      })
    }
    ms.mlDone = Math.min(i + BATCH, codes.length)
  }
  if (mySweep !== sweepSeq) return // 已被更新的扫描取代，丢弃本次结果
  ms.commitPeriod(h, m, fails, elapsed, etaTotal)
  // 训练完成提示：哪个周期、成功/失败几支、耗时
  const ok = Object.keys(m).length
  trainMsg.value = `✅ 「${periodLabel(h)}」周期 ML 训练完成 · 成功 ${ok} 支 / 失败 ${fails.length} 支 · 耗时 ${ms.mlElapsedByPeriod[h]}s`
  if (trainTimer) clearTimeout(trainTimer)
  trainTimer = window.setTimeout(() => (trainMsg.value = ''), 5000)
}

/** 全周期顺序扫描：从首个进入的周期 initial 开始，按 TRAIN_ORDER 补训其余，跳过已训。
   force=true（重新综合预测）时清空全部重训。 */
async function runSweep(initial: Horizon, force = false) {
  if (ms.mlLoading && !force) return // 已有扫描在跑，不重复
  if (!force && TRAIN_ORDER.every(h => ms.trainedFor(h))) return // 全部已训好，无需再扫
  const mySweep = ++sweepSeq
  if (force) ms.reset()
  ms.mlLoading = true
  const order = [initial, ...TRAIN_ORDER.filter(h => h !== initial)]
  for (const h of order) {
    if (mySweep !== sweepSeq) return // 被更新扫描取代
    if (ms.trainedFor(h) && !force) continue // 已训好，跳过
    await trainPeriod(h, mySweep)
  }
  if (mySweep === sweepSeq) {
    ms.mlLoading = false
    ms.mlCurrentPeriod = ''
  }
}

/* ---------------- 综合预测：技术面规则（PP） × ML 融合 ----------------
   PP 侧是规则评分 + 技术位（评分 / 目标价 / 支撑 / 8 因子），ML 侧是多模型
   集成的上涨概率与预期收益。两者口径不同但目标一致，按权重融合：
   ML 直接对前瞻收益建模、数据驱动，权重更高；技术面规则作先验兜底。
   ML 服务离线或该股 ML 失败时自动退化为纯技术面口径，不显示空值。 */
const FUSE_W_ML = 0.6
const FUSE_W_PP = 0.4
/** 某只是否 ML 训练失败（展开行提示用） */
function mlFail(code: string): boolean {
  return ms.mlFailList.some(f => f.code === code)
}
/** 某只 ML 训练失败原因 */
function mlFailReason(code: string): string {
  return ms.mlFailList.find(f => f.code === code)?.reason || ''
}
/** 融合结果来源口径：fused=技术面+ML，tech=仅技术面 */
type FuseSrc = 'fused' | 'tech'
interface Fused {
  /** 融合后上涨概率 0~1 */
  prob: number
  /** 融合后预期收益 % */
  ret: number
  src: FuseSrc
  /** 构成明细（tooltip 与展开区用） */
  ppProb: number
  ppRet: number
  mlProb: number | null
  mlRet: number | null
  /** ML 前瞻根数（仅融合时有） */
  H: number | null
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** 技术面规则侧上涨概率：综合评分（50 起评）+ 8 因子合成分 映射而来 */
function ppProbOf(r: ForecastRow): number {
  const pScore = 0.5 + clamp01((r.score - 50) / 50) * 0.4 // 50→0.50，100→0.90
  if (r.qfScore == null) return pScore
  const pQf = clamp01(0.5 + (r.qfScore - 60) / 70) // 60→0.50，95→1.00，25→0.00
  return clamp01(0.6 * pScore + 0.4 * pQf)
}

/** 技术面规则侧预期收益（%）：以目标/支撑的空间与风险按概率求期望 */
function ppRetOf(r: ForecastRow, p: number): number {
  return p * r.upside - (1 - p) * r.risk
}

/** code -> 融合结果（未跑 ML 时退化为技术面口径） */
const fused = computed<Record<string, Fused>>(() => {
  const out: Record<string, Fused> = {}
  for (const r of rows.value) {
    const ml = ms.mlMap[r.code]
    const ppProb = ppProbOf(r)
    const ppRet = ppRetOf(r, ppProb)
    if (ml) {
      out[r.code] = {
        prob: clamp01(FUSE_W_ML * ml.ensemble_prob_up + FUSE_W_PP * ppProb),
        ret: FUSE_W_ML * ml.ensemble_exp_return + FUSE_W_PP * ppRet,
        src: 'fused',
        ppProb,
        ppRet,
        mlProb: ml.ensemble_prob_up,
        mlRet: ml.ensemble_exp_return,
        H: ml.H ?? null
      }
    } else {
      out[r.code] = { prob: ppProb, ret: ppRet, src: 'tech', ppProb, ppRet, mlProb: null, mlRet: null, H: null }
    }
  }
  return out
})

/** 融合观点分档（比后端纯评分分档更细，覆盖 ML 给出的看空情形） */
function viewOf(p: number): string {
  if (p >= 0.7) return '强烈看多'
  if (p >= 0.6) return '看多'
  if (p >= 0.52) return '偏多'
  if (p >= 0.45) return '中性'
  if (p >= 0.38) return '偏空'
  return '看空'
}

/** 融合构成说明（悬浮可见，保证口径透明） */
function fuseTitle(r: ForecastRow): string {
  const f = fused.value[r.code]
  if (!f) return ''
  const p = (v: number) => (v * 100).toFixed(1) + '%'
  if (f.src === 'fused' && f.mlProb != null && f.mlRet != null) {
    return (
      `涨概率：技术面 ${p(f.ppProb)}×${FUSE_W_PP} + ML ${p(f.mlProb)}×${FUSE_W_ML} = ${p(f.prob)}\n` +
      `预期收益：技术面 ${f.ppRet.toFixed(2)}%×${FUSE_W_PP} + ML ${f.mlRet.toFixed(2)}%×${FUSE_W_ML} = ${f.ret.toFixed(2)}%\n` +
      `ML 前瞻 ${f.H} 根K · 点击行内 ⓘ 可看逐模型分解`
    )
  }
  return `仅技术面口径（未运行综合预测）：涨概率 ${p(f.prob)}，预期收益 ${f.ret.toFixed(2)}%`
}

/** 取某股的融合结果（模板用，避免在模板里叠长三元） */
function fuseOf(code: string): Fused | undefined {
  return fused.value[code]
}
/** 涨概率列配色：按融合后的观点分档着色 */
function probCls(code: string): string {
  const f = fused.value[code]
  return f ? viewCls(viewOf(f.prob)) : 'muted'
}
/** 全方位综合分（0~100）：融合后用于「综合」列与排名；纯技术面口径回退量化规则评分。
   维度与权重（透明可调）：技术面量化评分 35% · ML 涨概率 30% · ML 预期收益 20% · 风险(盈亏比) 15%。
   预期收益按 ±12.5% 映射 0~100（0→50）；盈亏比按 1~3 映射 0~100。 */
const FS_W = { tech: 0.35, mlP: 0.30, mlR: 0.20, rr: 0.15 }
function finalScore(r: ForecastRow): number {
  const f = fused.value[r.code]
  if (!f || f.src !== 'fused' || f.mlProb == null || f.mlRet == null) return r.score
  const tech = r.score
  const mlP = clamp01(f.mlProb) * 100
  const mlR = clamp01(f.mlRet / 25 + 0.5) * 100
  const rr = clamp01((r.rr == null ? 1 : r.rr) / 3) * 100
  return Math.round((FS_W.tech * tech + FS_W.mlP * mlP + FS_W.mlR * mlR + FS_W.rr * rr) * 10) / 10
}
/** 综合分（0~100）：融合后取全方位打分，未跑 ML 时回退量化规则评分 */
function scoreOf(r: ForecastRow): number {
  return finalScore(r)
}
/** 全表按综合分降序排名（打开=技术面评分序；综合预测后=全方位融合分序） */
const rankedRows = computed(() => [...rows.value].sort((a, b) => scoreOf(b) - scoreOf(a)))
/* 以下为模板专用取值函数：Vue 模板不解析 TS 非空断言，故统一在脚本侧取值 */
/** 涨概率文本（不带正负号，概率无方向性） */
function probText(code: string): string {
  const f = fused.value[code]
  return f ? fx(f.prob * 100, 1) + '%' : '—'
}
/** 预期收益文本（带正负号） */
function retText(code: string): string {
  const f = fused.value[code]
  return f ? pc(f.ret) : '—'
}
/** 预期收益配色 */
function retCls(code: string): string {
  const f = fused.value[code]
  return f ? (f.ret >= 0 ? 'up' : 'down') : 'muted'
}
/** 观点文本（由融合概率分档） */
function viewText(code: string): string {
  const f = fused.value[code]
  return viewOf(f ? f.prob : 0.5)
}
/** 口径来源标注 */
function srcText(code: string): string {
  const f = fused.value[code]
  if (!f) return ''
  return f.src === 'fused' ? '技术面×ML' : '仅技术面'
}
/** ML 前瞻根数标注（无 ML 时空串） */
function hText(code: string): string {
  const f = fused.value[code]
  return f && f.H ? `前瞻 ${f.H} 根K` : ''
}

/** 预测持有周期：基于 ML 前瞻步数 H × K线周期换算为人类可读时间。
    日K: H根≈H个交易日；周K: H根≈H周；月K: H根≈H月。
    这是模型预测的「达到预期收益/顶点所需时间」，而非写死的窗口标签。 */
function predHoldPeriod(code: string): string {
  const ml = ms.mlMap[code]
  if (!ml || !ml.H) return windowLabel.value || '—'
  const mp = mlParams(ms.horizon as Horizon)
  switch (mp.period) {
    case 'day': return ml.H <= 5 ? `约 ${ml.H} 个交易日` : `约 ${Math.round(ml.H / 5)} 周`
    case 'week': return ml.H <= 4 ? `约 ${ml.H} 周` : `约 ${Math.round(ml.H / 4)} 个月`
    case 'month': return `约 ${ml.H} 个月`
    default: return windowLabel.value || '—'
  }
}

/** 融合构成：技术面 / ML 各自的概率与收益（展开区明细用） */
function fusePartText(code: string, part: 'ppProb' | 'ppRet' | 'mlProb' | 'mlRet'): string {
  const f = fused.value[code]
  if (!f) return '—'
  const v = f[part]
  if (v == null) return '—'
  return part === 'ppProb' || part === 'mlProb' ? fx(v * 100, 1) + '%' : pc(v)
}
function fusePartCls(code: string, part: 'ppRet' | 'mlRet'): string {
  const f = fused.value[code]
  if (!f) return 'muted'
  const v = f[part]
  return v == null ? 'muted' : v >= 0 ? 'up' : 'down'
}
/** 20 日振幅 %（由 20 日高低点推导，衡量近期波动区间） */
function amp20(r: ForecastRow): number {
  return r.lo20 > 0 ? ((r.hi20 - r.lo20) / r.lo20) * 100 : 0
}

/** 挂载时探测 ML 服务是否在线 */
async function loadMlStatus() {
  try {
    const s: MlStatusResp = await api.mlStatus()
    mlOnline.value = !!s.online
  } catch {
    mlOnline.value = false
  }
}

/** ML 模型中文名 + 顺序（用于分解展示） */
const ML_MODELS: [keyof MlRow['proba'], string][] = [
  ['rf', '随机森林'], ['svm', 'SVM'], ['xgb', 'XGBoost'], ['lstm', 'LSTM'], ['transformer', 'Transformer']
]
/** 取某模型概率/收益（缺失返回 null） */
function mlVal(row: MlRow | undefined, model: keyof MlRow['proba'], kind: 'proba' | 'ret'): number | null {
  if (!row) return null
  const v = (kind === 'proba' ? row.proba : row.ret)[model]
  return typeof v === 'number' ? v : null
}
/* 以下为模板里用的无 ! 断言辅助（Vue 模板不解析 TS 非空断言） */
function mlProb(code: string, model: keyof MlRow['proba']): number {
  const v = mlVal(ms.mlMap[code], model, 'proba')
  return v == null ? 0 : v
}
function mlRet(code: string, model: keyof MlRow['proba']): number {
  const v = mlVal(ms.mlMap[code], model, 'ret')
  return v == null ? 0 : v
}
function mlProbFmt(code: string, model: keyof MlRow['proba']): string {
  const v = mlVal(ms.mlMap[code], model, 'proba')
  return v == null ? '—' : pc(v * 100)
}
function mlRetFmt(code: string, model: keyof MlRow['proba']): string {
  const v = mlVal(ms.mlMap[code], model, 'ret')
  return v == null ? '—' : pc(v)
}
function mlWeightFmt(code: string, model: keyof MlRow['proba']): string {
  const w = ms.mlMap[code] && ms.mlMap[code].clf_weights ? ms.mlMap[code].clf_weights![model] : undefined
  return w == null ? '—' : fx(w * 100, 1) + '%'
}

/** ML 模型评估指标辅助（后端 metrics 字段） */
function mlMetric(code: string, model: string, key: 'acc' | 'rmse'): number | null {
  const m = ms.mlMap[code]?.metrics?.[model]
  return m?.[key] ?? null
}
function mlAccFmt(code: string, model: string): string {
  const v = mlMetric(code, model, 'acc')
  return v == null ? '—' : fx(v * 100, 1) + '%'
}
function mlRmseFmt(code: string, model: string): string {
  const v = mlMetric(code, model, 'rmse')
  return v == null ? '—' : fx(v, 2)
}
/** 模型特征索引 → 中文名（与 models.py feats[22] 列顺序一一对应） */
const FEAT_NAMES = [
  '收益率_1d','收益率_5d','收益率_20d','波动率_5d','波动率_20d',
  'MA5/MA20','MA20/MA60','趋势偏离','RSI','MACD柱',
  '布林位置','成交趋势','量比','动量12M','反转5d',
  '低波12M','52周位置','低振幅8d','距20日低','MA20偏离',
  'DIF-DEA','当日振幅',
]
function mlFeatText(code: string, model: string): string {
  const top = ms.mlMap[code]?.metrics?.[model]?.feat_top5
  if (!top || !top.length) return '—'
  return top.map(f => `${FEAT_NAMES[f.idx] || 'f'+f.idx}(${fx(f.imp*100,1)})`).join(' · ')
}

/** 因子中文名（与后端 weeklyFactors 的 8 个因子一一对应，使用设计稿简称） */
const FACTOR_LABELS: [keyof NonNullable<ForecastRow['qf']>, string][] = [
  ['mom_12_1', '动量'],
  ['rev_4', '反转'],
  ['low_vol_12', '波动'],
  ['amount_trend', '量能'],
  ['trend_dev', '资金'],
  ['trend_slope', '位置'],
  ['pos_52', '质量'],
  ['low_amp_8', '成长']
]

const kpi = computed(() => {
  const r = rows.value
  if (!r.length) return null
  const avg = r.reduce((a, b) => a + b.score, 0) / r.length
  return {
    count: r.length,
    avg: Math.round(avg * 10) / 10,
    strong: r.filter(x => x.view === '强烈看多').length,
    bull: r.filter(x => x.bull).length,
    cash: r.filter(x => x.cash).length
  }
})

/** 融合观点配色：多 / 空 / 中性三档，强弱用深浅区分 */
const viewCls = (v: string) =>
  v === '强烈看多' || v === '看多' ? 'up' : v === '偏多' ? 'up-soft'
    : v === '中性' ? 'muted' : v === '偏空' ? 'down-soft' : 'down'
/** 表格列数：精简后固定 9 列，展开行 colspan 必须与之一致
    （原为 mlOn ? 14 : 12，与实际列数不符，导致展开面板宽度错位） */
const COLS = 9

/* 把当前预测结果拼成给 AI 的纯文本摘要（学习 go-stock 的「数据→可读结论」思路） */
const aiCtx = computed(() => {
  const list = rankedRows.value
  if (!list.length) return '（暂无预测数据）'
  const lines = list.slice(0, 15).map((r, i) => {
    /* 后端只返回 8 项因子的数值（qf），并没有 reasons 字段 —— 早期遗留的
       r.reasons 引用永远取不到值，导致 AI 上下文里因子信息长期缺失。
       这里直接由 qf 拼出可读摘要。 */
    const fac = r.qf
      ? '；因子：' +
        FACTOR_LABELS.filter(([k]) => typeof r.qf?.[k] === 'number')
          .map(([k, label]) => `${label}${r.qf![k] >= 0 ? '+' : ''}${r.qf![k].toFixed(2)}`)
          .join('、')
      : ''
    return `${i + 1}. ${r.name}(${r.code}) 评分${r.score} ${r.view} 现价${r.price} 建议持有${windowLabel.value || '—'}${fac}`
  })
  return (
    `【预测PP · ${windowLabel.value || ''} · 样本${sampleSize.value}只 · 命中${list.length}只】\n` +
    lines.join('\n')
  )
})

/* 把当前预测摘要注册为全局 AI 上下文，供 App 层全局 AiPanel 读取 */
watch(aiCtx, (ctx) => setAiContext('forecast', ctx), { immediate: true })

/** 评分药丸颜色：分数越高越深、越低越浅（珊瑚橙红系，HSL 明度/饱和度随分数变化） */
function scoreColor(score: number): string {
  const s = Number(score) || 0
  const t = Math.max(0, Math.min(1, (s - 50) / (100 - 50)))
  const hue = 14
  const sat = 40 + t * 28
  const light = 70 - t * 24
  return `hsl(${hue}, ${Math.round(sat)}%, ${Math.round(light)}%)`
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await api.forecast(ms.horizon as Horizon)
    rows.value = d.list || []
    date.value = d.date || ''
    windowLabel.value = d.window || HORIZONS.find(h => h.k === horizon.value)?.window || ''
    sampleSize.value = d.sampleSize || 0
    techSize.value = d.techSize || 0
  } catch (e) {
    error.value = e instanceof Error ? e.message : '预测数据加载失败'
  } finally {
    loading.value = false
  }
}

/** 切换周期：只重新拉取对应周期的选股结果并切换显示；不清空、不重训 ML。
   各周期的训练在后台扫描中进行，已完成的结果直接展示，未完成的会在扫描轮到时补训，
   中途切换页面/周期不会中断正在进行的训练。 */
function switchHorizon(h: Horizon) {
  if (h === ms.horizon) return
  ms.horizon = h
  expanded.value = null
  load()
}

/** 重新预测：强制重算短/中/长三条线（绕过当日缓存），并刷新当前显示周期。
    后端会把新结果缓存到当天 24:00，之后再次打开页面会直接命中缓存。 */
async function refetchAll() {
  if (refetching.value) return
  refetching.value = true
  error.value = ''
  try {
    // 并行强制重算四条线，写入各自当日缓存
    await Promise.all([api.forecast('ultra', true), api.forecast('short', true), api.forecast('mid', true), api.forecast('long', true)])
    // 刷新当前显示周期
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '重新预测失败'
  } finally {
    refetching.value = false
  }
}

/* ---- 一键综合预测（技术面重算 + ML 训练 + 融合展示）----
   原来「↻ 重新预测」与「🤖 运行 ML 预测」是两个入口，需要点两次且结果分列
   展示；现在合并为一个按钮，按顺序推进阶段，最终按融合口径输出。 */
/** 综合预测阶段：null=空闲，'pp'=重算技术面，'ml'=训练 ML 模型 */
const stage = ref<null | 'pp' | 'ml'>(null)
const busy = computed(() => stage.value !== null)
/** 全屏遮罩可见性：仅「重算技术面」阶段强制显示，进入 ML 训练 3s 后收起，
   改为状态栏「训练中」提示，避免长训练把页面锁死（失败也自动降级不卡） */
const overlayVisible = ref(false)

async function runAll() {
  if (busy.value) return
  error.value = ''
  overlayVisible.value = true
  try {
    stage.value = 'pp'
    await refetchAll()
    stage.value = 'ml'
    // 技术面重算完成后，全屏遮罩仅保留 3s 即收起，转状态栏「训练中」提示，
    // 全部周期重新训练在后台继续（force 清掉旧的、从头扫），失败降级不卡死
    window.setTimeout(() => { overlayVisible.value = false }, 3000)
    await runSweep(ms.horizon as Horizon, true)
  } finally {
    stage.value = null
    overlayVisible.value = false
  }
}

/** 预测训练时长文案：用后端真实预估（eta_s，已考虑缓存命中），不再写死固定系数 */
const mlEtaText = computed(() => {
  if (ms.mlEta > 0) return `约 ${Math.max(1, Math.round(ms.mlEta / 60))} 分钟`
  return ''
})
/** 训练状态文案（显示在「建议持有 X」之后）：训练中提示当前在训哪个周期与进度，
   训完显示该周期成功/失败支数与耗时；跨页面切换因状态存 store 而保持显示。 */
const mlStatusText = computed(() => {
  if (ms.mlLoading && ms.mlCurrentPeriod) {
    return `· 当前：训练「${periodLabel(ms.mlCurrentPeriod)}」ML 模型（${ms.mlDone}/${ms.mlCount} 只）`
  }
  if (ms.mlOn) {
    const ok = ms.mlMapped
    const fail = ms.mlFailList.length
    return `· ${periodLabel(ms.horizon)} ML 训练完成 · 成功 ${ok} 支 / 失败 ${fail} 支 · 耗时 ${ms.mlElapsed}s`
  }
  if (ms.mlError) return `· ML 训练失败：${ms.mlError}`
  return '· 准备中'
})

/** 综合预测按钮文案（按阶段推进，让用户知道卡在哪一步） */
const fuseBtnText = computed(() => {
  if (stage.value === 'pp') return '① 重算技术面…'
  if (stage.value === 'ml') return `② 训练 ${ms.mlCount} 只入选股…（${mlEtaText.value || '后台训练中'}）`
  return ms.mlOn ? '⚡ 重新综合预测' : '⚡ 综合预测'
})
/** 加载遮罩文案：跟随综合预测阶段，明确当前步骤与预期耗时
    （ML 训练期间按钮处于禁用属防重复触发设计，须让用户知道在做什么、要多久） */
const overlayText = computed(() => {
  if (stage.value === 'pp') return '① 重算技术面（强制刷新四条线）…'
  if (stage.value === 'ml') return `② 训练 ${ms.mlCount} 只入选标的…（${mlEtaText.value || '后台训练中'}，请稍候）`
  return '预测中，请稍后…'
})
const fuseBtnTitle = computed(() =>
  mlOnline.value === false
    ? 'ML 服务未启动（python ml_service/service.py）：将只按技术面规则口径预测'
    : `一键从底层重新筛选：强制重算四条线 → 对全部 ${ms.mlCount} 只入选标的训练多模型并集成，按「技术面×ML」融合口径输出`
)

function toggleRow(code: string) {
  expanded.value = expanded.value === code ? null : code
}

/** 模拟建仓：点因子明细里的「模拟」按钮，自动加入模拟持仓页（默认 100 股，成本取当前价）。
    两页是独立路由、数据走 Pinia store 持久化，加入后切换到模拟持仓页即可看到。 */
const paperStore = usePaperStore()
const simMsg = ref('')
let simTimer: number | undefined
function simulate(r: ForecastRow) {
  /* 建议持有时间取 ML 预测的持有周期（基于前瞻步数 H × K线周期换算），
     无 ML 时回退到当前窗口标签。写入模拟持仓，与收益率一并展示。 */
  const hold = predHoldPeriod(r.code) || windowLabel.value || '—'
  paperStore.add({ code: r.code, name: r.name, secid: r.secid || '', shares: 100, cost: r.price, holdWindow: hold })
  simMsg.value = `已加入模拟持仓：${r.name} ${r.code} · 100 股 @ ${fx(r.price)} · 建议持有 ${hold}`
  if (simTimer) clearTimeout(simTimer)
  simTimer = window.setTimeout(() => (simMsg.value = ''), 4000)
}

onMounted(async () => {
  loadMlStatus()
  await load()
  /* 打开预测 PP 默认短线；随后在后台按周期顺序扫描训练全部周期（不锁页面）。
     优先训当前页周期，再按 超短→短→中→长 补训未完成的、跳过已训好的；
     已在跑（切换页面回来）或已全部训好则跳过，不重复训练。 */
  if (!ms.mlLoading && !TRAIN_ORDER.every(h => ms.trainedFor(h))) {
    runSweep(ms.horizon as Horizon)
  }
})
</script>

<template>
  <div>
    <transition name="fade">
      <div v-if="simMsg" class="sim-toast">{{ simMsg }}</div>
      <transition name="fade">
        <div v-if="trainMsg" class="train-toast">{{ trainMsg }}</div>
      </transition>
    </transition>
    <div class="section-title">📈 预测 PP</div>

    <div class="pg-tools" style="margin-bottom: 10px">
      <span class="lbl">持股周期</span>
      <div class="seg">
        <button
          v-for="hz in HORIZONS"
          :key="hz.k"
          :class="{ on: ms.horizon === hz.k }"
          @click="switchHorizon(hz.k)"
        >
          {{ hz.label }}
        </button>
      </div>
      <button class="btn sm primary fuse-btn" :disabled="busy" @click="runAll" :title="fuseBtnTitle">
        {{ fuseBtnText }}
      </button>
      <span v-if="mlOnline === true" class="ml-dot on" title="ML 服务在线"></span>
      <span v-else-if="mlOnline === false" class="ml-dot off" title="ML 服务离线：将只按技术面规则口径预测"></span>
      <span class="muted" style="font-size: 12px; margin-left: 8px">建议持有 {{ windowLabel || '—' }}</span>
      <span class="muted" style="font-size: 12px; margin-left: 8px">{{ mlStatusText }}</span>
      <span v-if="ms.mlError" class="ml-err" :title="ms.mlError">ML 降级：{{ ms.mlError }}</span>
      <span v-if="ms.mlFailList.length" class="ml-err" :title="ms.mlFailList.map(f => f.code + ' ' + f.name + '：' + f.reason).join('\n')">⚠ {{ ms.mlFailList.length }} 只未训到：{{ ms.mlFailList.map(f => f.code).join('、') }}</span>
    </div>

    <div class="muted" style="font-size: 13px; margin-bottom: 12px" v-if="!predicting">
      A股量化选股（仅沪深 A 股）：全市场
      <b class="up">{{ sampleSize || '—' }}</b> 只中，取成交额活跃 Top
      <b class="up">{{ techSize || '—' }}</b> 只做技术面横截面筛选 ·
      {{ ms.horizon === 'short' ? '日 K' : ms.horizon === 'long' ? '月 K' : '周 K' }} 均线多头
      + 资金流入 + 量能 + 位置安全 + 8 项横截面因子 · 选股日 {{ date || '—' }} ·
      点击行查看详情，点击 ⓘ 展开 8 项周期因子
    </div>

    <div class="muted" style="font-size: 12px; margin-bottom: 12px" v-if="!predicting">
      设防自检（三层衰减模型）：<b class="up">数据层✓</b> 实时行情接口，非 AI 记忆 ·
      <b class="up">结构层✓</b> 结构化字段，非文本解析 ·
      <b>逻辑层</b> 规则因子交叉验证兜底，<b>非因果推断，仍存在伪相关风险</b>
    </div>
    <div class="muted" style="font-size: 12px; margin-bottom: 12px" v-if="!predicting">
      ML 预测顺序：优先训练当前进入周期（如短线），训练中切换页面不中断、继续完成当前周期；完成后依次按 <b>超短线 → 短线 → 中线 → 长线</b> 顺序补训，已训练完成的周期自动跳过。
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div v-if="kpi && !predicting" class="kpi-row">
      <div class="kpi">
        <div class="kpi-l">入选数量</div>
        <div class="kpi-v">{{ kpi.count }}</div>
        <div class="kpi-s">score ≥ 50</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">平均评分</div>
        <div class="kpi-v">{{ fx(kpi.avg, 1) }}</div>
        <div class="kpi-s">满分 100</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">强烈看多</div>
        <div class="kpi-v up">{{ kpi.strong }}</div>
        <div class="kpi-s">score ≥ 85</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">均线多头</div>
        <div class="kpi-v">{{ kpi.bull }}</div>
        <div class="kpi-s">MA5&gt;10&gt;20&gt;60</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">资金流入</div>
        <div class="kpi-v up">{{ kpi.cash }}</div>
        <div class="kpi-s">主力净流入为正</div>
      </div>
    </div>

    <div class="tbl-wrap" v-if="!predicting">
      <table class="tbl">
        <thead>
          <tr>
            <th>排名</th>
            <th>代码 / 名称</th>
            <th>现价</th>
            <th>综合</th>
            <th>涨概率</th>
            <th>预期收益</th>
            <th>目标 / 支撑</th>
            <th>盈亏比</th>
            <th>因子</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rankedRows.length">
            <td :colspan="COLS">
              <div class="empty">{{ loading ? '预测中，请稍后…' : '今日无符合条件标的' }}</div>
            </td>
          </tr>
          <template v-for="(r, i) in rankedRows" :key="r.code">
            <tr @click="detailStock = { code: r.code, name: r.name, secid: r.secid }">
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ r.name }}</span>
                <span class="c-code">{{ r.code }}</span>
              </td>
              <td data-label="现价">
                <div class="c-main">{{ fx(r.price) }}</div>
                <div class="c-sub" :class="cl(r.pct)">{{ pc(r.pct) }}</div>
              </td>
              <td data-label="综合" :title="fuseTitle(r)">
                <span class="score-pill" :style="{ background: scoreColor(scoreOf(r)) }">{{ fx(scoreOf(r), 1) }}</span>
                <div class="c-view" :class="viewCls(viewText(r.code))">{{ viewText(r.code) }}</div>
              </td>
              <td data-label="涨概率" :class="probCls(r.code)" :title="fuseTitle(r)">
                <div class="c-main">{{ probText(r.code) }}</div>
                <div v-if="fuseOf(r.code)" class="c-src">{{ srcText(r.code) }}</div>
              </td>
              <td data-label="预期收益" :title="fuseTitle(r)">
                <div class="c-main" :class="retCls(r.code)">{{ retText(r.code) }}</div>
                <div v-if="hText(r.code)" class="c-src">{{ hText(r.code) }}</div>
              </td>
              <td data-label="目标/支撑">
                <div class="c-main">{{ fx(r.target) }}<span class="c-sep"> / </span>{{ fx(r.support) }}</div>
                <div class="c-sub">
                  <span class="up">+{{ fx(r.upside, 2) }}%</span>
                  <span class="c-sep"> / </span>
                  <span class="down">-{{ fx(r.risk, 2) }}%</span>
                </div>
              </td>
              <td data-label="盈亏比">{{ r.rr == null ? '—' : fx(r.rr) }}</td>
              <td data-label="因子">
                <button class="btn sm ghost" @click.stop="toggleRow(r.code)">
                  {{ expanded === r.code ? '收起' : 'ⓘ' }}
                </button>
              </td>
            </tr>

            <!-- 明细（展开行）：技术面 / 周期因子 / 融合构成 / ML 分解 -->
            <tr v-if="expanded === r.code" class="exp-row">
              <td :colspan="COLS">
                <div class="exp-box">
                  <div class="exp-cols">
                    <!-- 左：技术面与估值 -->
                    <div class="exp-col">
                      <div class="fac-title">技术面与估值</div>
                      <div class="exp-grid">
                        <div class="exp-cell">
                          <span class="exp-label">评分 / 因子合成</span>
                          <span class="exp-val">{{ fx(r.score, 1) }} / {{ r.qfScore == null ? '—' : fx(r.qfScore) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">偏离 MA20</span>
                          <span class="exp-val" :class="cl(r.dev)">{{ sg(r.dev) }}{{ fx(r.dev, 2) }}%</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">MA5 / MA10</span>
                          <span class="exp-val">{{ fx(r.ma5) }} / {{ fx(r.ma10) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">MA20 / MA60</span>
                          <span class="exp-val">{{ fx(r.ma20) }} / {{ fx(r.ma60) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">20日高 / 低</span>
                          <span class="exp-val">{{ fx(r.hi20) }} / {{ fx(r.lo20) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">20日振幅</span>
                          <span class="exp-val">{{ fx(amp20(r), 2) }}%</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">主力净流入</span>
                          <span class="exp-val" :class="cl(r.mainNetInflow)">{{ yi(r.mainNetInflow) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">净流入占比</span>
                          <span class="exp-val" :class="cl(r.netRatio)">{{ sg(r.netRatio) }}{{ fx(r.netRatio, 2) }}%</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">成交额</span>
                          <span class="exp-val">{{ yi(r.amount) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">换手率</span>
                          <span class="exp-val">{{ fx(r.turnover, 2) }}%</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">量比</span>
                          <span class="exp-val" :class="r.volumeRatio >= 1 ? 'up' : 'muted'">{{ fx(r.volumeRatio) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">总市值</span>
                          <span class="exp-val">{{ yi(r.mktcap) }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">PE(动) / PE(TTM)</span>
                          <span class="exp-val">{{ r.pe > 0 ? fx(r.pe) : '—' }} / {{ r.peTtm > 0 ? fx(r.peTtm) : '—' }}</span>
                        </div>
                        <div class="exp-cell">
                          <span class="exp-label">市净率 PB</span>
                          <span class="exp-val">{{ r.pb > 0 ? fx(r.pb) : '—' }}</span>
                        </div>
                      </div>

                      <!-- 条件命中：四项各自对应后端真实条件
                           （原实现「最优」无对应字段，且与「位置」重复引用 r.safe） -->
                      <div class="cond-row">
                        <span class="cond-tag" :class="r.bull ? 'on' : ''">均线多头</span>
                        <span class="cond-tag" :class="r.cash ? 'on' : ''">资金流入</span>
                        <span class="cond-tag" :class="r.vol ? 'on' : ''">量能放大</span>
                        <span class="cond-tag" :class="r.safe ? 'on' : ''">位置安全</span>
                      </div>
                    </div>

                    <!-- 右：周期 8 因子 + 综合预测构成 -->
                    <div class="exp-col">
                      <div v-if="r.qf" class="fac-section">
                        <div class="fac-title">周期 8 因子（合成分 {{ r.qfScore }}）</div>
                        <div class="fac-grid">
                          <div v-for="[k, label] in FACTOR_LABELS" :key="k" class="fac-cell">
                            <span class="fac-k">{{ label }}</span>
                            <span class="fac-v" :class="cl(r.qf[k])">{{ fx(r.qf[k], 2) }}</span>
                          </div>
                        </div>
                        <div class="fac-note muted">横截面 z-score：正值表示优于市场均值，绝对值越大信号越强</div>
                      </div>

                      <!-- 综合预测构成：把融合过程摊开，避免「黑箱」。
                           样式与技术面/因子区块保持一致（标签在上、数值在下），
                           融合结果两格用卡片底色强调，与分项区分。 -->
                      <div v-if="fuseOf(r.code)" class="fac-section">
                        <div class="fac-title">综合预测构成（技术面 ×{{ FUSE_W_PP }} + ML ×{{ FUSE_W_ML }}）</div>
                        <div class="exp-grid">
                          <div class="exp-cell">
                            <span class="exp-label">技术面涨概率</span>
                            <span class="exp-val">{{ fusePartText(r.code, 'ppProb') }}</span>
                          </div>
                          <div class="exp-cell">
                            <span class="exp-label">技术面预期收益</span>
                            <span class="exp-val" :class="fusePartCls(r.code, 'ppRet')">{{ fusePartText(r.code, 'ppRet') }}</span>
                          </div>
                          <div class="exp-cell">
                            <span class="exp-label">ML 涨概率</span>
                            <span class="exp-val">{{ fusePartText(r.code, 'mlProb') }}</span>
                          </div>
                          <div class="exp-cell">
                            <span class="exp-label">ML 预期收益</span>
                            <span class="exp-val" :class="fusePartCls(r.code, 'mlRet')">{{ fusePartText(r.code, 'mlRet') }}</span>
                          </div>
                          <div class="exp-cell fuse-hi">
                            <span class="exp-label">融合涨概率</span>
                            <span class="exp-val" :class="probCls(r.code)">{{ probText(r.code) }}</span>
                          </div>
                          <div class="exp-cell fuse-hi">
                            <span class="exp-label">融合预期收益</span>
                            <span class="exp-val" :class="retCls(r.code)">{{ retText(r.code) }}</span>
                          </div>
                          <div class="exp-cell fuse-hi">
                            <span class="exp-label">全方位综合分</span>
                            <span class="exp-val">{{ fx(finalScore(r), 1) }}</span>
                          </div>
                          <div class="exp-cell">
                            <span class="exp-label">当前口径</span>
                            <span class="exp-val">{{ srcText(r.code) }}</span>
                          </div>
                          <div class="exp-cell">
                            <span class="exp-label">ML 前瞻</span>
                            <span class="exp-val">{{ hText(r.code) || '—' }}</span>
                          </div>
                          <div class="exp-cell fuse-hi">
                            <span class="exp-label">建议持有周期</span>
                            <span class="exp-val">{{ predHoldPeriod(r.code) }}</span>
                          </div>
                          <div class="exp-cell">
                            <span class="exp-label">技术目标 / 支撑</span>
                            <span class="exp-val"><span class="up">{{ fx(r.target) }}</span> / <span class="down">{{ fx(r.support) }}</span></span>
                          </div>
                          <div class="exp-cell" v-if="r.upside != null">
                            <span class="exp-label">上行 / 下行空间</span>
                            <span class="exp-val"><span class="up">+{{ fx(r.upside, 2) }}%</span> / <span class="down">-{{ fx(r.risk, 2) }}%</span></span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- ML 模型分解：集成观点与逐模型同表对齐（首行=集成，下面=各模型）
                       参考 PKU 统计学习教程：补充 RMSE/准确率/特征重要性 评估指标 -->
                  <div v-if="ms.mlMap[r.code]" class="ml-breakdown">
                    <div class="fac-title">🤖 ML 模型分解（{{ ms.mlMap[r.code].view }} · 前瞻 {{ ms.mlMap[r.code].H }} 根K）</div>
                    <table class="ml-tbl">
                      <thead><tr><th>模型</th><th>涨概率</th><th>预期收益</th><th>准确率</th><th>RMSE</th><th>核心特征 Top3</th></tr></thead>
                      <tbody>
                        <tr class="ml-ens-row">
                          <td><b>集成</b></td>
                          <td :class="ms.mlMap[r.code].ensemble_prob_up >= 0.5 ? 'up' : 'down'">{{ pc(ms.mlMap[r.code].ensemble_prob_up * 100) }}</td>
                          <td :class="ms.mlMap[r.code].ensemble_exp_return >= 0 ? 'up' : 'down'">{{ pc(ms.mlMap[r.code].ensemble_exp_return) }}</td>
                          <td colspan="3" class="muted" style="font-size:11.5px">— 集成无独立指标 —</td>
                          <td class="muted" style="font-size:11px">见各模型权重↓</td>
                        </tr>
                        <tr v-for="[mk, name] in ML_MODELS" :key="mk">
                          <td>{{ name }}</td>
                          <td :class="mlProb(r.code, mk) >= 0.5 ? 'up' : 'down'">{{ mlProbFmt(r.code, mk) }}</td>
                          <td :class="mlRet(r.code, mk) >= 0 ? 'up' : 'down'">{{ mlRetFmt(r.code, mk) }}</td>
                          <td>{{ mlAccFmt(r.code, mk) }}</td>
                          <td>{{ mlRmseFmt(r.code, mk) }}</td>
                          <td style="font-size:11px;max-width:200px" :title="mlFeatText(r.code, mk)">
                            {{ mlFeatText(r.code, mk).slice(0, 30) }}{{ mlFeatText(r.code, mk).length > 30 ? '…' : '' }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <div v-if="ms.mlMap[r.code].clf_weights" class="ml-weights">
                      集成权重（按样本内准确率）：
                      <span v-for="[mk, name] in ML_MODELS" :key="mk" class="ml-wchip">
                        {{ name }} {{ mlWeightFmt(r.code, mk) }}
                      </span>
                    </div>
                  </div>
                  <div v-else-if="mlFail(r.code)" class="ml-fail-note">
                    🤖 ML 训练未成功：{{ mlFailReason(r.code) }}
                  </div>

                  <!-- 模拟建仓（移到展开面板最底部） -->
                  <div class="exp-action">
                    <button class="btn sm primary" @click="simulate(r)">＋ 模拟建仓（100 股 @ {{ fx(r.price) }}）</button>
                    <span class="muted" style="font-size: 11.5px">点击后自动加入「模拟持仓」页</span>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <LoadingOverlay v-if="predicting || overlayVisible" :text="overlayText" />

    <StockDetailModal
      v-if="detailStock"
      :code="detailStock.code"
      :name="detailStock.name"
      :secid="detailStock.secid"
      @close="detailStock = null"
    />
  </div>
</template>

<style scoped>
/* 列合并后一格承载主值 + 副值（现价/涨跌幅、目标/支撑 等） */
.c-main {
  font-size: 13.5px;
  font-weight: 700;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
}
.c-sub {
  font-size: 11.5px;
  font-weight: 600;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  margin-top: 1px;
}
.c-sep { color: var(--text-faint); font-weight: 400; }
.c-view {
  font-size: 11.5px;
  font-weight: 700;
  margin-top: 3px;
}
.c-src {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 400;
  margin-top: 2px;
}
/* 观点强弱：偏多/偏空用浅色，与强多空区分 */
.up-soft { color: #f0a08a; }
.down-soft { color: #7cb98d; }
.score-pill {
  display: inline-block;
  min-width: 38px;
  padding: 4px 11px;
  border-radius: 20px;
  font-weight: 700;
  font-size: 13px;
  color: #fff;
  background: #ef8a68;
  text-align: center;
  line-height: 1.2;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.score-pill.up {
  background: #ef8a68;
  color: #fff;
}
.score-pill.down {
  background: #81b29a;
  color: #fff;
}
.score-pill.muted {
  background: #d4a76a;
  color: #fff;
}
.exp-row:hover {
  background: transparent;
}
.exp-box {
  padding: 14px 16px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 13px;
}
/* 展开区两栏：左技术面 / 右因子+融合构成；窄屏自动堆叠 */
.exp-cols {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 16px;
}
.exp-col { min-width: 0; }
@media (max-width: 980px) {
  .exp-cols { grid-template-columns: 1fr; }
}
/* 指标网格：自适应列宽（原固定 4 列在窄屏会挤压溢出） */
.exp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px 16px;
}
.exp-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.exp-label {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 400;
}
.exp-val {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.exp-val.up { color: #e53935; }
.exp-val.down { color: #43a047; }
/* 条件命中徽章：四项各自独立（原实现存在字段复用） */
.cond-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.cond-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 3px 11px;
}
.cond-tag.on {
  color: #e53935;
  border-color: rgba(229, 57, 53, 0.35);
  background: rgba(229, 57, 53, 0.06);
}

/* 周期 8 因子区域（置于右栏时不再需要顶部外边距） */
.fac-section {
  margin-top: 14px;
}
.exp-col > .fac-section:first-child { margin-top: 0; }
.fac-title {
  font-size: 13px;
  font-weight: 700;
  text-align: center;
  margin-bottom: 10px;
  color: var(--text);
}
/* 因子网格：自适应（原固定 4 列，窄屏因子名与数值会挤到换行错位） */
.fac-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
  gap: 8px 12px;
}
.fac-note {
  font-size: 11.5px;
  line-height: 1.5;
  margin-top: 8px;
}
/* 融合结果格：卡片底色，与分项区分（综合预测构成网格内） */
.fuse-hi {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
}
/* 综合预测按钮 / ML 降级提示。
   nowrap + flex:none：防止在工具栏 flex 布局里被压缩截断文案。
   配色跟随主题、与同页「模拟建仓」按钮一致的正向逻辑：
   浅色=亮底深字、深色=深底浅字（原用 --primary 墨底反白，深浅看着反了）。 */
.fuse-btn {
  font-size: 12.5px;
  white-space: nowrap;
  flex: none;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--primary);
  font-weight: 700;
}
.fuse-btn:hover:not(:disabled) {
  background: var(--surface-2);
  border-color: var(--accent);
}
.fuse-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ml-err {
  font-size: 12px;
  color: #c0392b;
  margin-left: 8px;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fac-cell {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--surface);
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.fac-k {
  font-size: 12.5px;
  color: var(--text-muted);
  font-weight: 500;
}
.fac-v {
  font-size: 14px;
  font-weight: 700;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.fac-v.up { color: #e53935; }
.fac-v.down { color: #43a047; }

/* 底部操作 */
.exp-action {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
/* 模拟建仓按钮——跟随主题：浅色白底黑字 / 深色深底浅字；尺寸放大便于点击 */
.exp-action .btn.primary {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  font-size: 14px;
  font-weight: 700;
  padding: 11px 24px;
  border-radius: 10px;
}
.exp-action .btn.primary:hover {
  background: var(--surface-2);
  border-color: var(--primary);
}
/* 模拟建仓成功提示（浮在右上角，4s 后消失）——跟随主题：
   原用 --primary 作底色，深色下主色反转为浅色、白字看不清，故改 surface 底
   + 主色左边框强调，并下移避开顶部工具条、加宽以容纳完整文案 */
.sim-toast {
  position: fixed;
  top: 78px;
  right: 20px;
  z-index: 200;
  background: var(--surface);
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
  padding: 13px 18px;
  border-radius: 12px;
  min-width: 340px;
  max-width: 480px;
  line-height: 1.55;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border-strong);
  border-left: 4px solid var(--primary);
}
/* 窄屏：取消最小宽度，改为左右撑开，避免超出视口 */
@media (max-width: 520px) {
  .sim-toast {
    min-width: 0;
    left: 16px;
    right: 16px;
    max-width: none;
  }
}
/* 周期 ML 训练完成提示（浮在右上角，复用 sim-toast 视觉，错位避免与模拟建仓提示重叠） */
.train-toast {
  position: fixed;
  top: 78px;
  right: 20px;
  z-index: 201;
  background: var(--surface);
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
  padding: 13px 18px;
  border-radius: 12px;
  min-width: 340px;
  max-width: 480px;
  line-height: 1.55;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border-strong);
  border-left: 4px solid var(--up);
}
@media (max-width: 520px) {
  .train-toast {
    min-width: 0;
    left: 16px;
    right: 16px;
    max-width: none;
  }
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
/* 加载提示已抽为共用组件 LoadingOverlay.vue（A股行情同样使用） */
/* 重新预测按钮 */
.refresh-btn {
  margin-left: 4px;
  font-size: 12.5px;
}
/* ML 服务在线状态点 */
.ml-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  vertical-align: middle;
}
.ml-dot.on { background: #43a047; box-shadow: 0 0 0 2px rgba(67,160,71,0.18); }
.ml-dot.off { background: #c0392b; box-shadow: 0 0 0 2px rgba(192,57,43,0.18); }
/* 注意：实心 .btn 切勿叠加 .on 类——on 的 color: var(--primary) 会与
   .btn 的 var(--primary) 底色同色，文字隐形（本次踩坑） */

/* ML 模型分解（展开行内） */
.ml-breakdown {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}
.ml-ens {
  text-align: center;
  font-size: 13.5px;
  margin-bottom: 10px;
  color: var(--text);
}
.ml-ens b { font-family: var(--font-mono); }
.ml-ens .up { color: #e53935; }
.ml-ens .down { color: #43a047; }
.ml-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ml-tbl th {
  text-align: center;
  color: var(--text-muted);
  font-weight: 500;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.ml-tbl td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.ml-tbl td.up { color: #e53935; }
.ml-tbl td.down { color: #43a047; }
/* 集成观点行：与逐模型同行同列，确保涨概率/预期收益数字上下对齐 */
.ml-ens-row td {
  background: var(--surface-2);
  font-weight: 700;
  border-bottom: 1px solid var(--border-strong);
}
/* 单只 ML 训练失败提示（展开行内，明确告知哪只、为什么） */
.ml-fail-note {
  margin-top: 12px;
  padding: 10px 12px;
  font-size: 13px;
  color: #c0392b;
  background: rgba(192, 57, 43, 0.06);
  border: 1px solid rgba(192, 57, 43, 0.3);
  border-radius: 8px;
}
.ml-weights {
  margin-top: 10px;
  font-size: 12.5px;
  color: #666;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.ml-wchip {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 3px 10px;
  font-family: var(--font-mono);
}
</style>
