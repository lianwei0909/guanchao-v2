"""验证层：IC/IR、分层回测、walk-forward 切分与绩效指标。

绝大多数量化项目死在这里而不是死在模型上，所以这一层的每个数字都带"及格线"。

有效性红线（来自因子研究的通行标准）：
  IC 均值 > 0.03   基本具备预测力
  IR > 0.5         因子稳定（IR = IC均值 / IC标准差）
  IC 正率 > 55%    方向稳定；低于 50% 视为不可用
  IC > 0.1         反而要警惕，八成是前向偏差（look-ahead bias）

另一个必须记住的：回测拟合度 80-90% 才合理，超过 95% 基本可以判定过拟合；
实盘收益通常只有回测的 5-7 折，因为滑点、冲击成本和选股偏差都会侵蚀。
"""
from __future__ import annotations

import math
from typing import Dict, Iterator, List, Tuple

import numpy as np
import pandas as pd


# ---------------------------------------------------------------- 绩效指标

def perf_metrics(returns: pd.Series, ppy: float) -> Dict[str, float]:
    """由单期收益率序列算标准绩效指标。

    Args:
        returns: 单期收益率（已扣成本）。
        ppy: 每年期数（周线 50，月线 12）。
    """
    r = returns.dropna()
    if len(r) < 2:
        return {"年化收益": np.nan, "年化波动": np.nan, "夏普": np.nan,
                "最大回撤": np.nan, "Calmar": np.nan, "胜率": np.nan, "期数": len(r)}

    equity = (1.0 + r).cumprod()
    total = equity.iloc[-1] - 1.0
    n = len(r)
    ann_ret = (1.0 + total) ** (ppy / n) - 1.0 if total > -1 else -1.0
    ann_vol = r.std(ddof=1) * math.sqrt(ppy)
    sharpe = ann_ret / ann_vol if ann_vol > 1e-12 else np.nan
    maxdd = float((equity / equity.cummax() - 1.0).min())
    calmar = ann_ret / abs(maxdd) if maxdd < -1e-9 else np.nan

    return {
        "年化收益": ann_ret,
        "年化波动": ann_vol,
        "夏普": sharpe,
        "最大回撤": maxdd,
        "Calmar": calmar,
        "胜率": float((r > 0).mean()),
        "期数": n,
    }


# ---------------------------------------------------------------- IC / IR

def _rowwise_rank_corr(a: pd.DataFrame, b: pd.DataFrame) -> pd.Series:
    """逐行（横截面）Spearman 相关，不依赖 scipy。"""
    ra = a.rank(axis=1)
    rb = b.rank(axis=1)
    ra = ra.sub(ra.mean(axis=1), axis=0)
    rb = rb.sub(rb.mean(axis=1), axis=0)
    num = (ra * rb).sum(axis=1)
    den = np.sqrt((ra ** 2).sum(axis=1) * (rb ** 2).sum(axis=1))
    den = den.replace(0, np.nan)
    return num / den


def compute_ic(factor: pd.DataFrame, fwd_ret: pd.DataFrame, min_names: int = 5) -> pd.Series:
    """逐期截面 IC（Spearman 秩相关）。"""
    common = factor.index.intersection(fwd_ret.index)
    cols = factor.columns.intersection(fwd_ret.columns)
    a = factor.loc[common, cols]
    b = fwd_ret.loc[common, cols]
    enough = (a.notna() & b.notna()).sum(axis=1) >= min_names
    return _rowwise_rank_corr(a, b).where(enough).dropna()


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def ic_summary(ic: pd.Series, overlap: int = 1) -> Dict[str, float]:
    """IC 序列的汇总统计，含 t 统计量与显著性。

    Args:
        ic: 逐期 IC 序列。
        overlap: 相邻 IC 观测的重叠期数。

    重叠样本必须修正：如果标签用了未来 8 周的收益，那么相邻两周的 IC
    有 7/8 的信息是重合的，直接算 t 值会把显著性夸大 sqrt(8) 倍。
    这里按有效样本数 = 期数 / overlap 下调。
    """
    ic = ic.dropna()
    if len(ic) < 2:
        return {"IC均值": np.nan, "IC标准差": np.nan, "IR": np.nan,
                "IC正率": np.nan, "t统计量": np.nan, "p值": np.nan,
                "期数": len(ic), "有效期数": np.nan}
    mean = ic.mean()
    std = ic.std(ddof=1)
    n = len(ic)
    n_eff = max(n / max(overlap, 1), 2.0)
    tstat = mean / (std / math.sqrt(n_eff)) if std > 1e-12 else np.nan
    pval = 2.0 * (1.0 - _norm_cdf(abs(tstat))) if tstat == tstat else np.nan
    return {
        "IC均值": mean,
        "IC标准差": std,
        "IR": mean / std if std > 1e-12 else np.nan,
        "IC正率": float((ic > 0).mean()),
        "t统计量": tstat,
        "p值": pval,
        "期数": n,
        "有效期数": n_eff,
    }


def ic_verdict(summary: Dict[str, float], ic_th: float = 0.03, ir_th: float = 0.5) -> str:
    """把 IC 统计翻译成人话结论，直接可用/需复核/不可用。"""
    ic, ir, pos = summary["IC均值"], summary["IR"], summary["IC正率"]
    if any(v != v for v in (ic, ir, pos)):  # NaN 检查
        return "样本不足，无法判断。"
    if ic > 0.1:
        return (f"IC={ic:.4f} 高得反常，优先怀疑前向偏差（因子里混入了未来信息），"
                "而不是庆祝找到了圣杯。")
    if ic < ic_th:
        return f"IC={ic:.4f} 低于 {ic_th} 及格线，预测力不足，不要用。"
    if ir < ir_th:
        return f"IC={ic:.4f} 达标但 IR={ir:.3f} < {ir_th}，方向不稳定，属于时灵时不灵。"
    if pos < 0.55:
        return f"IC={ic:.4f}、IR={ir:.3f} 尚可，但正率 {pos:.1%} < 55%，方向不够稳定。"
    return f"IC={ic:.4f}、IR={ir:.3f}、正率 {pos:.1%}，三项达标，可以进入分层回测。"


# ---------------------------------------------------------------- 分层回测

def quantile_backtest(
    factor: pd.DataFrame,
    fwd_ret: pd.DataFrame,
    n_groups: int = 5,
    min_names: int = 5,
) -> pd.DataFrame:
    """按因子值分 N 组，看组间收益是否单调。

    好因子的判据不是"第一组收益高"，而是**从第 1 组到第 N 组单调**。
    只有头尾好、中间乱跳，通常是噪音。
    """
    common = factor.index.intersection(fwd_ret.index)
    cols = factor.columns.intersection(fwd_ret.columns)
    a = factor.loc[common, cols]
    b = fwd_ret.loc[common, cols]

    def _group_mean(row_f: pd.Series, row_r: pd.Series) -> pd.Series:
        mask = row_f.notna() & row_r.notna()
        f, r = row_f[mask], row_r[mask]
        if len(f) < min_names:
            return pd.Series(np.nan, index=range(1, n_groups + 1))
        # 用 qcut 会因子并列值报错，改用 rank 均分
        ranks = f.rank(method="first")
        groups = pd.qcut(ranks, n_groups, labels=range(1, n_groups + 1))
        return r.groupby(groups, observed=False).mean()

    res = pd.concat(
        [_group_mean(a.iloc[i], b.iloc[i]) for i in range(len(a))],
        axis=1,
    ).T
    res.index = common
    return res.dropna(how="all")


def quantile_report(qret: pd.DataFrame, ppy: float, horizon: int = 1) -> pd.DataFrame:
    """把分层收益序列整理成各组年化收益表，并给出多空价差与单调性。

    Args:
        qret: 分层收益，每格是未来 horizon 期的收益。
        ppy: 每年期数。
        horizon: 收益跨越的期数。

    horizon 必须传对：如果 qret 是 8 周收益却按 1 周年化，
    年化收益会虚高到四位数、夏普算出几十，看起来"效果惊人"实则全是错的。
    年化时按 ppy / horizon 折算。
    """
    eff_ppy = ppy / max(horizon, 1)
    rows = []
    for g in qret.columns:
        m = perf_metrics(qret[g], eff_ppy)
        rows.append({"分组": f"G{int(g)}", **{k: m[k] for k in ("年化收益", "年化波动", "夏普", "最大回撤")}})
    out = pd.DataFrame(rows)

    if len(qret.columns) >= 2:
        spread = qret[qret.columns[-1]] - qret[qret.columns[0]]
        m = perf_metrics(spread, eff_ppy)
        out.loc[len(out)] = {"分组": "多空价差", **{k: m[k] for k in ("年化收益", "年化波动", "夏普", "最大回撤")}}

        ann = [out.loc[out["分组"] == f"G{int(g)}", "年化收益"].iloc[0] for g in qret.columns]
        diffs = np.diff([x for x in ann if x == x])
        mono = float(np.mean(diffs > 0)) if len(diffs) else np.nan
        out.attrs["单调性"] = mono
        out.attrs["多空序列"] = spread
    return out


# ---------------------------------------------------------------- walk-forward

def walk_forward_splits(
    index: pd.DatetimeIndex,
    train_bars: int,
    test_bars: int,
    embargo_bars: int,
) -> Iterator[Tuple[pd.DatetimeIndex, pd.DatetimeIndex]]:
    """滚动前进切分，每次把训练窗整体向前推。

    embargo（禁运期）是必需的：标签用了未来 max_hold 期的信息，
    如果测试集紧挨着训练集，训练集末尾的样本会"看到"测试集开头的走势。
    embargo_bars 至少要等于 max_hold。
    """
    n = len(index)
    start = 0
    while True:
        train_end = start + train_bars
        test_start = train_end + embargo_bars
        test_end = test_start + test_bars
        if test_end > n:
            break
        yield index[start:train_end], index[test_start:test_end]
        start += test_bars


def purged_folds(
    index: pd.DatetimeIndex,
    n_folds: int,
    embargo_bars: int,
) -> List[Tuple[np.ndarray, np.ndarray]]:
    """净化 K 折：时间相邻样本标签重叠，普通 K 折必然泄漏。

    做法是按时间连续切块（不随机打散），并把每折两端的 embargo_bars 样本
    从训练集中剔除，阻断标签跨越折边界。
    """
    n = len(index)
    fold_size = n // n_folds
    folds = []
    for i in range(n_folds):
        lo, hi = i * fold_size, (i + 1) * fold_size if i < n_folds - 1 else n
        test_idx = np.arange(lo, hi)
        train_idx = np.setdiff1d(
            np.arange(0, n),
            np.arange(max(0, lo - embargo_bars), min(n, hi + embargo_bars)),
        )
        if len(train_idx) == 0 or len(test_idx) == 0:
            continue
        folds.append((train_idx, test_idx))
    return folds
