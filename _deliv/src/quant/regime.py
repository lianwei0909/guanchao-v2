"""市场状态识别（规则引擎，第一版的核心）。

为什么第一版要先做这个，而不是先做选股：

周月频选股能贡献的是 alpha（选对股票），但账户的生死主要由 beta（仓位）决定。
同样一套选股逻辑，在趋势市里能赚 30%，在震荡市里会因为反复被打脸亏掉 15%。
先用几条硬规则把市场分成"趋势 / 震荡 / 末端"三种状态，再让状态决定仓位上限，
比任何复杂的选股模型都更能改善实盘体验。

规则刻意保持简单到可以肉眼验证——复杂规则在小样本上只是过拟合的温床。
"""
from __future__ import annotations

from typing import Dict

import pandas as pd

# 状态 -> 仓位上限
POSITION_CAP: Dict[str, float] = {"趋势": 1.0, "震荡": 0.5, "末端": 0.3, "下跌": 0.2}


def market_regime(
    close: pd.Series,
    ma_window: int = 20,
    slope_window: int = 4,
    vol_window: int = 12,
    vol_base: int = 52,
    mom_window: int = 12,
    vol_z_threshold: float = 1.3,
) -> pd.DataFrame:
    """用指数收盘价判断市场状态。

    判定顺序（先判方向，再判是否末端）：
      1. 收盘价在均线上方且均线向上 -> 趋势
      2. 收盘价在均线下方且均线向下 -> 下跌
      3. 其余 -> 震荡
      4. 在趋势内部，若波动率显著放大且动量开始衰竭 -> 末端（趋势尾声，减仓）

    Args:
        close: 指数收盘价 Series（周线或月线）。
        ma_window: 均线窗口。
        slope_window: 均线斜率回看期数。
        vol_window: 短期波动率窗口。
        vol_base: 波动率基准窗口（用于算相对高低）。
        mom_window: 动量窗口。
        vol_z_threshold: 波动率相对基准的倍数阈值。

    Returns:
        DataFrame，列：close / ma / trend_up / vol_ratio / momentum / state / position_cap。
    """
    ret = close.pct_change()
    ma = close.rolling(ma_window).mean()
    ma_slope = ma / ma.shift(slope_window) - 1.0

    vol = ret.rolling(vol_window).std()
    vol_base_level = vol.rolling(vol_base, min_periods=vol_window * 2).mean()
    vol_ratio = vol / vol_base_level

    momentum = close / close.shift(mom_window) - 1.0
    momentum_fading = momentum < momentum.shift(slope_window)

    above = close > ma
    rising = ma_slope > 0

    state = pd.Series("震荡", index=close.index, dtype=object)
    state[above & rising] = "趋势"
    state[(~above) & (~rising)] = "下跌"
    # 末端：仍在趋势中，但波动率放大且动量转弱——典型的高位放量滞涨
    state[(state == "趋势") & (vol_ratio > vol_z_threshold) & momentum_fading] = "末端"

    out = pd.DataFrame(
        {
            "close": close,
            "ma": ma,
            "trend_up": above & rising,
            "vol_ratio": vol_ratio,
            "momentum": momentum,
            "state": state,
        }
    )
    out["state"] = out["state"].where(close.notna() & ma.notna())
    out["position_cap"] = out["state"].map(POSITION_CAP)
    return out


def regime_report(regime: pd.DataFrame) -> pd.DataFrame:
    """各状态占比与状态下的平均后续收益——用来验证状态划分是否真的有用。

    如果"趋势"和"下跌"两个状态的后续收益没有明显差别，说明这套规则没捕捉到
    任何有效信息，应该直接弃用而不是硬套。
    """
    df = regime.dropna(subset=["state"]).copy()
    df["fwd_ret"] = df["close"].shift(-4) / df["close"] - 1.0

    grouped = df.groupby("state").agg(
        期数=("close", "size"),
        占比=("close", lambda s: len(s) / len(df)),
        后续4期平均收益=("fwd_ret", "mean"),
        后续4期中位数=("fwd_ret", "median"),
        平均波动比=("vol_ratio", "mean"),
    )
    return grouped.sort_values("期数", ascending=False)
