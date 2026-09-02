"""回测层：TopN 等权组合，含交易成本与仓位漂移。

几个刻意的设计选择：
  1. **成本按双边分别计**：买入付佣金+滑点，卖出还要再加千一印花税。
     周月频换手低，成本看着不起眼，但忽略它会导致"高频调仓看起来更赚"的错觉。
  2. **持仓权重会漂移**：调仓之间不偷偷再平衡，涨得多的权重自然变大，
     这更接近真实持仓，而不是每天自动归位的理想化假设。
  3. **信号与收益错开一期**：第 t 期用截至 t 的数据打分、在 t 收盘后交易，
     赚的是 t 到 t+1 的收益。
"""
from __future__ import annotations

from typing import Dict, Optional

import numpy as np
import pandas as pd


def top_n_weights(score_row: pd.Series, top_n: int) -> pd.Series:
    """取得分最高的 top_n 只等权，其余为 0。"""
    valid = score_row.dropna()
    if len(valid) == 0:
        return pd.Series(0.0, index=score_row.index)
    n = min(top_n, len(valid))
    picked = valid.nlargest(n).index
    w = pd.Series(0.0, index=score_row.index)
    w.loc[picked] = 1.0 / n
    return w


def run_backtest(
    score: pd.DataFrame,
    ret: pd.DataFrame,
    top_n: int = 20,
    rebalance_every: int = 4,
    commission_bps: float = 2.5,
    stamp_bps: float = 10.0,
    slippage_bps: float = 10.0,
    exposure: Optional[pd.Series] = None,
) -> Dict[str, pd.Series]:
    """跑一遍 TopN 等权组合。

    Args:
        score: 综合得分面板，第 t 行只能用截至 t 的信息。
        ret: 单期收益率面板，ret.loc[t] 表示 t 到 t+1 的收益。
        top_n: 每期持仓数量。
        rebalance_every: 每 N 期调仓一次。
        commission_bps / stamp_bps / slippage_bps: 单边佣金 / 卖出印花税 / 单边滑点。
        exposure: 仓位上限序列（来自市场状态判断），None 则满仓。

    Returns:
        dict：组合净收益 / 毛收益 / 成本 / 换手率 / 持仓数。
    """
    dates = score.index.intersection(ret.index)
    cols = score.columns.intersection(ret.columns)
    score = score.loc[dates, cols]
    ret = ret.loc[dates, cols].fillna(0.0)

    buy_cost = (commission_bps + slippage_bps) / 1e4
    sell_cost = (commission_bps + slippage_bps + stamp_bps) / 1e4

    w = pd.Series(0.0, index=cols)
    gross_r, cost_s, turn_s, hold_s = [], [], [], []

    for i, t in enumerate(dates[:-1]):
        cost = 0.0
        turnover = 0.0

        if i % rebalance_every == 0:
            target = top_n_weights(score.iloc[i], top_n)
            if exposure is not None:
                target = target * float(exposure.reindex([t]).fillna(1.0).iloc[0])
            delta = target - w
            turnover = float(delta.abs().sum())
            cost = float(delta.clip(lower=0).sum()) * buy_cost + \
                   float((-delta.clip(upper=0)).sum()) * sell_cost
            w = target

        r_row = ret.iloc[i]
        gross = float((w * r_row).sum())
        net = gross - cost

        gross_r.append(gross)
        cost_s.append(cost)
        turn_s.append(turnover)
        hold_s.append(int((w > 1e-9).sum()))

        # 权重漂移：调仓之间不再平衡
        if gross > -1.0:
            w = (w * (1.0 + r_row)) / (1.0 + gross)
        w = w.fillna(0.0)

    idx = dates[:-1]
    return {
        "gross": pd.Series(gross_r, index=idx),
        "cost": pd.Series(cost_s, index=idx),
        "net": pd.Series(np.array(gross_r) - np.array(cost_s), index=idx),
        "turnover": pd.Series(turn_s, index=idx),
        "holdings": pd.Series(hold_s, index=idx),
    }


def equal_weight_benchmark(
    ret: pd.DataFrame,
    mask: Optional[pd.DataFrame] = None,
) -> pd.Series:
    """股票池等权收益，作为组合的对比基准。

    Args:
        mask: 布尔面板，True 表示该期股票在池内可交易。
            传入后只统计当期池内股票，否则基准会包含当期本不可交易的标的，
            使对比失去意义（早期年度尤其明显）。
    """
    if mask is not None:
        ret = ret.where(mask.reindex(index=ret.index, columns=ret.columns).fillna(False))
    return ret.mean(axis=1).fillna(0.0)
