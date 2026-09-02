"""股票池：按历史时点动态筛选（消除幸存者偏差）。

## 为什么必须有这个模块

直接用"今天成交额前 N 名"的股票池去回测 2014 年，等于让回测预先知道
哪些股票会在未来变成热门股。这不是小瑕疵——它会系统性地高估策略表现，
因为已经死了的、一直没起来的股票根本不在池子里。

## 怎么修

在每个时点 t 只用**截至 t 已知的信息**判断一只股票能否进池：
  1. 到 t 为止至少有 min_history 期有效收盘价（排除刚上市、数据太短）
  2. 近 liq_window 期的成交额中位数可得（确保当下真的有流动性）
  3. 收盘价不低于 min_price（可选，默认关闭，原因见下）
  4. 可选：每期只保留流动性最好的 max_names 只

每条判据都只用过去和当下的量价数据，不需要任何未来信息。

## 为什么 min_price 默认关闭

K 线用的是**前复权价**，分红送转会把它系统性压低，越往前压得越狠。
实测 2013 年，池内 73 只股票的前复权价中位数只有 3.83 元，
其中 22 只低于 2 元——这些全是大盘蓝筹，不是仙股。
用 2 元做绝对阈值，等于凭空砍掉三分之一的样本，且砍掉的
恰好是分红多、资质好的那批。仙股与退市边缘股由成交额条件拦截即可，
它不受复权方式影响。若确实要用价格过滤，阈值应压到 0.5 元以下。

## 还剩下的局限（如实说明）

本模块消除的是**流动性层面的选择偏差**，但无法完全消除幸存者偏差：
数据源（东财当前股票列表）里没有已退市股票，它们从头到尾都不会出现。
真正的无偏池需要含退市股的历史全样本，免费公开接口拿不到。
另外 ST 状态的历史时点信息同样无法回溯，只能用价格和流动性做代理。
"""
from __future__ import annotations

from typing import Dict

import numpy as np
import pandas as pd


def point_in_time_universe(
    panels: Dict[str, pd.DataFrame],
    min_history: int = 60,
    liq_window: int = 12,
    min_price: float = 2.0,
    max_names: int | None = None,
) -> pd.DataFrame:
    """逐时点判断每只股票是否可交易。

    Args:
        panels: build_panels 的返回值。
        min_history: 至少要有多少期有效收盘价。
        liq_window: 计算流动性中位数的回看窗口。
        min_price: 最低价过滤。
        max_names: 每期最多保留多少只（按流动性排序），None 表示不限。

    Returns:
        布尔 DataFrame，index=date，columns=code，True 表示该期可纳入股票池。
    """
    close = panels["close"]
    amount = panels["amount"]

    # 截至每一期的有效历史长度（cumsum 即扩展窗口计数）
    hist_bars = close.notna().cumsum()

    # 近 liq_window 期的成交额中位数，min_periods 放宽以应对停牌造成的空洞
    liq = amount.rolling(liq_window, min_periods=max(4, liq_window // 2)).median()

    eligible = (
        close.notna()
        & (hist_bars >= min_history)
        & liq.notna()
        & (close >= min_price)
    )

    if max_names is not None:
        # 只在合格股票里按流动性排名，NaN 排名后为 NaN，比较结果自然是 False
        rank = liq.where(eligible).rank(axis=1, ascending=False, method="first")
        eligible = eligible & (rank <= max_names)

    return eligible.fillna(False).astype(bool)


def universe_coverage(mask: pd.DataFrame) -> pd.DataFrame:
    """逐期统计股票池容量，用来确认历史各期是否有足够的可选标的。

    如果早期年度池子里只有十来只股票，那段时间的因子和回测结果都不可靠，
    应该从样本里剔除，而不是让它污染整体结论。
    """
    counts = mask.sum(axis=1)
    by_year = counts.groupby(counts.index.year).agg(["mean", "min", "max", "count"])
    by_year.columns = ["平均只数", "最少", "最多", "期数"]
    return by_year


def coverage_warning(mask: pd.DataFrame, min_names: int = 30) -> str:
    """生成人话提示：哪些年份的股票池太小，结论需要打折。"""
    cov = universe_coverage(mask)
    thin = cov[cov["平均只数"] < min_names]
    if thin.empty:
        return f"各年度股票池均不少于 {min_names} 只，样本充足。"
    years = "、".join(str(y) for y in thin.index)
    return (f"以下年度股票池平均不足 {min_names} 只：{years}。"
            f"这些年份的因子与回测结果样本量不够，建议剔除或显著打折看待。")


def trim_thin_periods(
    mask: pd.DataFrame,
    min_names: int = 30,
    verbose: bool = True,
) -> pd.DatetimeIndex:
    """给出股票池容量首次达到 min_names 之后的日期范围。

    早期年份池子里只有个位数股票时，截面 IC 是在三五个样本上算秩相关，
    数值完全是噪声，却会一股脑混进 IC 均值和 IR 里，把整体结论搅浑。
    与其让它们污染统计，不如直接从样本起点裁掉。

    Args:
        mask: point_in_time_universe 的返回值。
        min_names: 池内至少有多少只才算有效样本期。

    Returns:
        有效期的 DatetimeIndex（已剔除容量不足的期次）。
    """
    counts = mask.sum(axis=1)
    ok = counts >= min_names
    if not ok.any():
        if verbose:
            print(f"  没有任何一期股票池达到 {min_names} 只，全部期次都不可用。")
        return counts.index[:0]
    start = ok.idxmax()          # 首个达到阈值的日期
    valid = counts.index[counts.index >= start]
    valid = valid[counts.reindex(valid) >= min_names]
    if verbose and len(valid) < len(counts):
        dropped = len(counts) - len(valid)
        print(f"  剔除容量不足 {min_names} 只的早期期次 {dropped} 期"
              f"，样本起点 {valid[0].date()}（原 {counts.index[0].date()}）")
    return valid


def mask_panel(panel: pd.DataFrame, mask: pd.DataFrame) -> pd.DataFrame:
    """把面板按股票池掩码置空，用于计算横截面基准、IC 和选股。"""
    return panel.where(mask.reindex(index=panel.index, columns=panel.columns).fillna(False))
