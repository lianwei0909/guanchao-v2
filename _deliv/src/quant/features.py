"""特征层：周/月频横截面因子。

设计原则（决定因子能不能用）：
  1. **全部是"越大越好"的方向**，便于后面等权合成，不必逐因子记忆符号
  2. **只用 t 时刻及之前的数据**。因子在 t 周收盘后计算，交易在 t+1 发生，
     所有 forward return 必须从 t+1 起算，错开一格就是未来函数
  3. 周/月频样本量小，因子数量控制在 8 个以内。30 个弱因子只会放大过拟合

因子清单（方向已统一为正向）：
  mom_12_1       12 期动量，跳过最近 1 期（规避短期反转污染）
  rev_4          4 期反转（取负）
  low_vol_12     12 期收益波动率（取负，低波异象）
  amount_trend   近 4 期成交额 / 近 12 期成交额，量能是否回暖
  trend_dev      价格相对 20 期均线的偏离，趋势位置
  trend_slope    20 期均线的 4 期斜率，趋势方向
  pos_52         距 52 期最高价的回撤（越浅越好）
  low_amp_8      8 期平均振幅（取负）
"""
from __future__ import annotations

from typing import Dict

import numpy as np
import pandas as pd


def compute_factors(panels: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    """由 OHLCV 宽表面板计算因子面板。

    Args:
        panels: build_panels 的返回值，需含 open/close/high/low/volume/amount。

    Returns:
        {因子名: DataFrame(index=date, columns=code)}，方向统一为越大越好。
    """
    close = panels["close"]
    high = panels["high"]
    low = panels["low"]
    amount = panels["amount"]
    ret = close.pct_change()

    ma20 = close.rolling(20).mean()
    f: Dict[str, pd.DataFrame] = {}

    # 动量：t-13 到 t-1 的收益，跳过最近一期
    f["mom_12_1"] = close.shift(1) / close.shift(13) - 1.0
    # 短期反转
    f["rev_4"] = -(close / close.shift(4) - 1.0)
    # 低波
    f["low_vol_12"] = -ret.rolling(12).std()
    # 量能趋势
    f["amount_trend"] = amount.rolling(4).mean() / amount.rolling(12).mean()
    # 趋势位置与斜率
    f["trend_dev"] = close / ma20 - 1.0
    f["trend_slope"] = ma20 / ma20.shift(4) - 1.0
    # 距 52 期高点回撤（越接近 0 越强）
    f["pos_52"] = close / close.rolling(52).max() - 1.0
    # 低振幅
    f["low_amp_8"] = -((high / low - 1.0).rolling(8).mean())

    return f


def forward_returns(close: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """t 期起算的未来 horizon 期收益（从 t+1 收盘到 t+horizon 收盘）。

    这是所有 IC / 分层回测 / 组合回测统一使用的"标准答案"，
    必须与因子错开一期，否则就是用已知信息预测已知信息。
    """
    return close.shift(-horizon) / close - 1.0


def winsorize_and_zscore(factor: pd.DataFrame, n_mad: float = 5.0) -> pd.DataFrame:
    """截面去极值 + 标准化。

    用中位数/MAD 而不是均值/标准差——因子（尤其市值、换手）长尾严重，
    用均值标准差会被少数极值主导，标准化后大部分样本挤在 0 附近失去区分度。

    Args:
        factor: 因子面板。
        n_mad: MAD 截尾倍数。

    Returns:
        同形状 DataFrame，每行（横截面）均值 0、标准差 1。
    """
    med = factor.median(axis=1)
    mad = (factor.sub(med, axis=0)).abs().median(axis=1)
    scale = (mad * 1.4826).replace(0, np.nan)
    lower = med - n_mad * scale
    upper = med + n_mad * scale
    clipped = factor.clip(lower=lower, upper=upper, axis=0)

    z = clipped.sub(clipped.mean(axis=1), axis=0).div(clipped.std(axis=1), axis=0)
    return z.replace([np.inf, -np.inf], np.nan)


def industry_neutralize(factor: pd.DataFrame, industry: pd.Series) -> pd.DataFrame:
    """行业中性化：行业内做 Z-score，剔除行业暴露。

    因子值常在同一行业内高度相似，不中性化的话选出来的可能只是"某个行业"，
    而不是真正的选股能力。

    Args:
        factor: 因子面板（columns 为股票代码）。
        industry: Series，index 为股票代码，值为行业名。

    Returns:
        中性化后的因子面板。
    """
    aligned = industry.reindex(factor.columns).fillna("UNK")

    def _norm(block: pd.DataFrame) -> pd.DataFrame:
        # 行业内样本 < 5 时不中性化，强行标准化会放大噪音
        if block.shape[1] < 5:
            return block
        return block.sub(block.mean(axis=1), axis=0).div(block.std(axis=1), axis=0)

    out = pd.concat(
        [_norm(factor.loc[:, aligned[aligned == ind].index]) for ind in aligned.unique()],
        axis=1,
    )
    return out.reindex(columns=factor.columns).replace([np.inf, -np.inf], np.nan)


def combine(
    factors: Dict[str, pd.DataFrame],
    industry: pd.Series | None = None,
    do_neutralize: bool = True,
    n_mad: float = 5.0,
) -> pd.DataFrame:
    """把多个因子合成一个综合得分（等权）。

    第一版刻意用等权：IC 加权、正交化都需要估计协方差/IC 序列，
    在周月频的小样本上估计误差大，等权反而是最稳的基准。
    """
    cleaned = []
    for name, panel in factors.items():
        z = winsorize_and_zscore(panel, n_mad)
        if do_neutralize and industry is not None:
            z = industry_neutralize(z, industry)
        cleaned.append(z.fillna(0.0))

    score = sum(cleaned) / len(cleaned)
    return score.where(factors[next(iter(factors))].notna())
