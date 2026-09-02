"""标注层：三重障碍法（Triple Barrier Labeling）。

这是整套系统最关键、也最容易做错的一层。

## 为什么不能用"事后最高点"

最常见的错误写法：取过去 20 天的最高点作为"高点"标签去训练模型。
这个最高点只有站在未来才知道，回测会给出极高胜率，实盘直接归零。
本模块的每一处计算都严格只用 t 时刻可知的信息。

## 三重障碍怎么定标签

从每个候选点 t 出发，同时设三条壁垒：
  - 上轨：超额收益触及 +upper  → 标签 +1（该点是相对低点）
  - 下轨：超额收益触及 -lower  → 标签 -1（该点是相对高点）
  - 时间壁垒：最多持有 max_hold 根 K 线，到点未破 → 标签 0（震荡，不构成高低点）

先碰到哪条就取哪个标签，全程不需要未来信息。

## 两个必须知道的工程取舍

1. **用超额收益而非绝对收益**。做全市场选股时，大盘 beta 会淹没个股 alpha。
   基准用股票池等权收益，标签衡量的是"跑赢还是跑输同伴"。

2. **同一根 K 线内上下轨都被击穿时无法判定先后顺序**（周/月线没有日内信息）。
   这里按 ambiguity 策略处理：skip（丢弃该样本，默认，最干净）
   或 pessimistic（一律记为 -1，最保守）。丢弃比例会在报告里显式打印，
   如果这个比例很高，说明壁垒定得太窄，需要调大 upper_mult / lower_mult。
"""
from __future__ import annotations

from typing import Dict

import numpy as np
import pandas as pd


def _bench_cum(bench_ret: pd.Series, k: int) -> pd.Series:
    """未来 k 期基准累计收益：prod(1 + b_{t+1..t+k}) - 1。

    rolling(k) 在 t 处覆盖 [t-k+1, t]，再 shift(-k) 把 t+k 处的值搬到 t，
    窗口正好落在 [t+1, t+k]。
    """
    # 用对数累加再相减，而不是 rolling().apply(np.prod)：
    # 后者只要窗口里有一个 NaN 就整段失效，基准序列一旦有缺口，
    # 大量样本的标签会凭空消失。
    log_cum = np.log1p(bench_ret.fillna(0.0)).cumsum()
    return np.expm1(log_cum.shift(-k) - log_cum)


def _first_hit(masks: Dict[int, pd.DataFrame], max_hold: int) -> pd.DataFrame:
    """返回每格"首次触发"的期数，未触发为 inf。

    从大到小遍历并用 where 覆盖，最终留下的是最小的触发期数。
    """
    first = pd.DataFrame(np.inf, index=masks[max_hold].index, columns=masks[max_hold].columns)
    for k in range(max_hold, 0, -1):
        first = first.where(~masks[k].fillna(False), float(k))
    return first


def triple_barrier_labels(
    close: pd.DataFrame,
    high: pd.DataFrame,
    low: pd.DataFrame,
    bench_ret: pd.Series | None = None,
    max_hold: int = 8,
    upper_mult: float = 1.0,
    lower_mult: float = 0.8,
    vol_window: int = 12,
    min_sigma: float = 0.01,
    ambiguity: str = "skip",
) -> Dict[str, pd.DataFrame]:
    """计算三重障碍标签。

    Args:
        close / high / low: 宽表面板，index=date，columns=code。
        bench_ret: 基准单期收益 Series，index=date。None 则用股票池等权收益。
        max_hold: 时间壁垒，最多持有多少期。
        upper_mult / lower_mult: 壁垒宽度系数，乘以 sigma*sqrt(max_hold)。
        vol_window: 单期波动率估计窗口。
        min_sigma: 单期波动率下限，防止低波动个股壁垒窄到失真。
        ambiguity: 同期双破的处理策略，skip | pessimistic。

    Returns:
        dict:
          label      +1 / -1 / 0，NaN 表示样本不可用
          hold_bars  实际触发（或到期）所用期数
          fwd_excess 持有期内实现的超额收益，用作 IC 的"标准答案"
    """
    ret = close.pct_change()

    if bench_ret is None:
        # 用【中位数】而不是均值：等权均值会被少数暴涨股拉高，
        # 导致绝大多数股票"跑输基准"，标签严重偏向 -1。中位数才是"典型个股"。
        bench_ret = ret.median(axis=1)
    bench_ret = bench_ret.reindex(close.index).fillna(0.0)

    # 超额收益的单期波动率，作为壁垒宽度的标尺
    excess = ret.sub(bench_ret, axis=0)
    sigma = excess.rolling(vol_window, min_periods=max(4, vol_window // 2)).std()
    sigma = sigma.clip(lower=min_sigma)

    # 壁垒按持有期长度缩放：单期波动 -> 持有期波动
    scale = sigma * np.sqrt(max_hold)
    upper = (upper_mult * scale).shift(0)
    lower = (lower_mult * scale).shift(0)

    up_masks: Dict[int, pd.DataFrame] = {}
    dn_masks: Dict[int, pd.DataFrame] = {}
    future_ok = pd.DataFrame(True, index=close.index, columns=close.columns)

    for k in range(1, max_hold + 1):
        bench_cum_k = _bench_cum(bench_ret, k)
        # 注意 axis=0：DataFrame 减 Series 默认按【列】对齐，会把日期索引拿去匹配股票代码，
        # 结果是全表 NaN 且不报错。必须显式指定按行对齐。
        # 用当期最高/最低价判断是否触及壁垒（周月线的日内顺序不可知，见模块文档）
        up_path = high.shift(-k).div(close).sub(bench_cum_k, axis=0) - 1.0
        dn_path = low.shift(-k).div(close).sub(bench_cum_k, axis=0) - 1.0
        up_masks[k] = up_path.ge(upper)
        dn_masks[k] = dn_path.le(-lower)
        future_ok &= close.shift(-k).notna()

    up_first = _first_hit(up_masks, max_hold)
    dn_first = _first_hit(dn_masks, max_hold)

    both_miss = np.isinf(up_first) & np.isinf(dn_first)
    ambiguous = (up_first == dn_first) & ~both_miss

    label = pd.DataFrame(0.0, index=close.index, columns=close.columns)
    label = label.mask(up_first < dn_first, 1.0)
    label = label.mask(dn_first < up_first, -1.0)

    if ambiguity == "pessimistic":
        label = label.mask(ambiguous, -1.0)
    else:  # skip：同期双破无法判定，直接丢弃
        label = label.mask(ambiguous, np.nan)

    hold_bars = np.minimum(up_first, dn_first)
    hold_bars = hold_bars.where(~np.isinf(hold_bars), float(max_hold))

    # 样本有效性：当期有价格、有波动率估计、未来 max_hold 期数据完整
    valid = close.notna() & sigma.notna() & future_ok
    label = label.where(valid)
    hold_bars = hold_bars.where(valid)

    fwd_excess = (
        close.shift(-max_hold).div(close).sub(_bench_cum(bench_ret, max_hold), axis=0) - 1.0
    ).where(valid)

    return {"label": label, "hold_bars": hold_bars, "fwd_excess": fwd_excess}


def describe_labels(label: pd.DataFrame) -> pd.DataFrame:
    """标签分布与丢弃率统计——每次调完壁垒参数都要看一眼这张表。"""
    flat = label.stack()
    total = len(flat)
    counts = flat.value_counts(dropna=False)
    out = pd.DataFrame({"样本数": counts, "占比": counts / total if total else 0.0})
    out.index.name = "标签"
    return out


def label_balance_report(label: pd.DataFrame) -> str:
    """生成一段人话结论，用于快速判断标注参数是否合理。"""
    # 必须先 stack 再 dropna。DataFrame.dropna() 会丢掉"任意一个标的为 NaN"的整行，
    # 横截面面板里几乎没有全齐的行，结果样本量被砍掉九成还看不出来。
    flat = label.stack().dropna()
    if len(flat) == 0:
        return "没有有效样本，检查波动率窗口或历史长度是否足够。"
    pos = (flat == 1).sum()
    neg = (flat == -1).sum()
    zero = (flat == 0).sum()
    total = pos + neg + zero

    lines = [
        f"有效样本 {total} 个：高点(-1) {neg} 个 {neg / total:.1%}，"
        f"低点(+1) {pos} 个 {pos / total:.1%}，震荡(0) {zero} 个 {zero / total:.1%}",
    ]
    if zero / total > 0.6:
        lines.append("震荡样本超过 60%，壁垒偏宽，多数样本走不到任何一条轨，"
                     "建议调小 upper_mult / lower_mult 或缩短 max_hold。")
    if abs(pos - neg) / max(pos + neg, 1) > 0.5:
        lines.append("正负样本严重失衡，横截面选股里通常说明基准选得不合适"
                     "（例如牛市里几乎所有股票都跑赢等权基准），检查 bench_ret。")
    if zero / total < 0.1:
        lines.append("震荡样本不足 10%，壁垒偏窄，标签几乎退化为方向判断，"
                     "失去了三重障碍区分'震荡'的意义。")
    return "\n".join(lines)
