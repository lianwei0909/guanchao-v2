"""第 2c 层：另类数据因子，当前以**大宗交易**为主。

为什么加这一层
--------------
纯价量因子在本框架里已经被 walk-forward 证伪（样本外 IC 仅 +0.014，
22 个窗口里 11 个为正，等同抛硬币）。而 2025 年前后的研究共识是：
基本面因子与量价因子的长期相关性只有 0.07，另类数据则是第三类信息源。
大宗交易恰好是 A 股少数**公开、逐笔、带席位信息**的资金行为数据。

关于大宗交易信号方向，已有的实证结论很一致，且和直觉相反：
    - 折价成交占比超 90%，折价是常态，**不是**"捡便宜"的机会
    - 折价 >= 8% 的交易，后续 5/20/60 日超额收益 -1.2%/-2.8%/-4.1%，
      胜率仅 44%/39%/36%——折价越深，后续越差
    - 溢价 >= 5% 的交易，20 日平均 +1.6%，胜率 > 50%
    - 连续多日折价 = 资金持续离场，是最强的负面信号之一

所以本模块把大宗交易定位成**风控过滤器与负面信号**，而不是买入信号。
这与整套系统"状态识别 + 概率输出 + 赔率管理"的定位一致：
我们不需要它预测涨跌，只需要它在明显有风险时把标的踢出去。

字段口径（腾讯自选股 data_fund_block）
--------------------------------------
    CloseDiscountRate  折溢价率，**正 = 折价，负 = 溢价**，单位是百分数
                       定义：(收盘价 - 成交价) / 收盘价 * 100
                       例：收盘 16.82、成交 15.08 -> +10.34（折价 10.34%）
                           收盘 11.43、成交 12.50 -> -9.36（溢价 9.36%）
    这个符号方向极易搞反，本模块在入口处统一转成"溢价为正"。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
BLOCK_FILE = ROOT / "data_cache" / "mcp_block.json"

# 席位名称里出现这些关键词，视为机构行为
INST_KEYWORDS = ("机构专用", "社保", "养老", "保险", "年金", "QFII", "陆股通", "沪股通", "深股通")


# ---------------------------------------------------------------- 加载

def load_block() -> Dict[str, pd.DataFrame]:
    """读缓存，返回 {symbol: DataFrame}，一行为一个交易日的汇总。

    返回的列：
        close     当日收盘价
        n         当日笔数
        value     当日成交总额（元）
        prem_w    成交额加权的**溢价率**（正数=溢价，负数=折价）
        prem_max  当日最大单笔溢价率
        prem_min  当日最小单笔溢价率（即最大折价）
        inst_buy  机构席位买入金额占比
        inst_sell 机构席位卖出金额占比
    """
    if not BLOCK_FILE.exists():
        return {}
    raw = json.loads(BLOCK_FILE.read_text(encoding="utf-8"))
    out: Dict[str, pd.DataFrame] = {}
    for sym, by_day in raw.items():
        if not by_day:
            continue
        rows = []
        for day, node in by_day.items():
            trades = node.get("trades") or []
            if not trades:
                continue
            vals, prem, inst_b, inst_s = [], [], 0.0, 0.0
            for t in trades:
                v = pd.to_numeric(t.get("value"), errors="coerce")
                # 接口给的是"折价率"，这里翻符号，统一成"溢价为正"
                d = pd.to_numeric(t.get("discount"), errors="coerce")
                p = -d if pd.notna(d) else np.nan
                if pd.isna(v):
                    v = 0.0
                vals.append(v)
                prem.append(p)
                buyer = str(t.get("buyer") or "")
                seller = str(t.get("seller") or "")
                if any(k in buyer for k in INST_KEYWORDS):
                    inst_b += v
                if any(k in seller for k in INST_KEYWORDS):
                    inst_s += v
            v_tot = float(np.nansum(vals))
            if v_tot <= 0:
                w = np.full(len(vals), 1.0 / max(len(vals), 1))
            else:
                w = np.array(vals, dtype=float) / v_tot
            p_arr = np.array(prem, dtype=float)
            ok = ~np.isnan(p_arr)
            prem_w = float(np.sum(p_arr[ok] * w[ok])) if ok.any() else np.nan
            rows.append(
                {
                    "date": pd.to_datetime(day),
                    "close": pd.to_numeric(node.get("close"), errors="coerce"),
                    "n": len(trades),
                    "value": v_tot,
                    "prem_w": prem_w,
                    "prem_max": float(np.nanmax(p_arr)) if ok.any() else np.nan,
                    "prem_min": float(np.nanmin(p_arr)) if ok.any() else np.nan,
                    "inst_buy": inst_b / v_tot if v_tot > 0 else np.nan,
                    "inst_sell": inst_s / v_tot if v_tot > 0 else np.nan,
                }
            )
        if not rows:
            continue
        df = pd.DataFrame(rows).set_index("date").sort_index()
        out[sym] = df
    return out


# ---------------------------------------------------------------- 汇总到周线

def weekly_panel(
    block: Dict[str, pd.DataFrame],
    index: pd.DatetimeIndex,
    columns: pd.Index,
) -> Dict[str, pd.DataFrame]:
    """把逐日大宗交易汇总到周线网格。

    汇总方式：成交额、笔数按周求和；溢价率按成交额加权；
    极值取周内最大/最小。周内没有大宗交易的填 0（成交额、笔数）
    或 NaN（溢价率——没有交易就谈不上折溢价）。
    """
    fields = ["n", "value", "prem_w", "prem_max", "prem_min", "inst_buy", "inst_sell"]
    out: Dict[str, pd.DataFrame] = {}
    for f in fields:
        cols = {}
        for code in columns:
            sym = _guess_symbol(code, block)
            if sym is None:
                continue
            s = block[sym][f]
            if f in ("n", "value"):
                g = s.resample("W").sum().reindex(index)
            elif f in ("prem_max",):
                g = s.resample("W").max().reindex(index)
            elif f in ("prem_min",):
                g = s.resample("W").min().reindex(index)
            else:
                # 加权类：先算分子分母，再相除，不能直接对比率求均值
                v = block[sym]["value"].resample("W").sum()
                w = (s * block[sym]["value"]).resample("W").sum()
                g = (w / v.replace(0, np.nan)).reindex(index)
            cols[code] = g
        df = pd.DataFrame(cols, index=index).reindex(columns=columns)
        out[f] = df
    return out


def _guess_symbol(code: str, block: Dict[str, pd.DataFrame]):
    for prefix in ("sh", "sz"):
        if prefix + code in block:
            return prefix + code
    for sym in block:
        if sym[2:] == code:
            return sym
    return None


# ---------------------------------------------------------------- 因子

def compute_factors(
    wk: Dict[str, pd.DataFrame],
    amount: pd.DataFrame,
    window: int = 8,
) -> Dict[str, pd.DataFrame]:
    """由周线大宗交易面板算因子，全部统一为"越大越好"。

    Args:
        wk: weekly_panel() 的输出。
        amount: 周线成交额面板（二级市场），用于算相对抛压。
        window: 回看窗口（周）。

    Returns:
        {因子名: DataFrame}

    因子清单与方向依据：
        block_prem     近 window 周成交额加权溢价率。溢价=有人愿意
                       高于市价拿货，是正面信号。
        block_press_inv 近 window 周大宗成交额 / 同期二级市场成交额，
                       取负。占比越高说明筹码在通过大宗平台转移，
                       抛压越大。
        block_inst     近 window 周机构席位买入占比 - 卖出占比。
                       机构接盘比机构抛售好。
        block_worst_inv 近 window 周最差的一笔（最大折价），取负。
                       单笔极端折价往往对应解禁减持，是强负面信号。
        block_freq_inv  近 window 周有大宗交易的周数占比，取负。
                       连续发生 = 资金持续离场。
    """
    f: Dict[str, pd.DataFrame] = {}

    val = wk.get("value")
    amt = amount.replace(0, np.nan)

    # 加权溢价率：分子分母分别滚动求和再相除
    prem = wk.get("prem_w")
    if prem is not None and val is not None:
        num = (prem * val).rolling(window, min_periods=1).sum()
        den = val.rolling(window, min_periods=1).sum().replace(0, np.nan)
        f["block_prem"] = num / den

    # 相对抛压（取负：越大越安全）
    if val is not None:
        ratio = val.rolling(window, min_periods=1).sum() / amt.rolling(
            window, min_periods=1
        ).sum().replace(0, np.nan)
        f["block_press_inv"] = -ratio

    # 机构净接盘
    ib, isell = wk.get("inst_buy"), wk.get("inst_sell")
    if ib is not None and isell is not None:
        b = (ib * val).rolling(window, min_periods=1).sum()
        s = (isell * val).rolling(window, min_periods=1).sum()
        den = val.rolling(window, min_periods=1).sum().replace(0, np.nan)
        f["block_inst"] = (b - s) / den

    # 最差单笔（取负）
    pmin = wk.get("prem_min")
    if pmin is not None:
        f["block_worst_inv"] = -pmin.rolling(window, min_periods=1).min()

    # 发生频率（取负）
    n = wk.get("n")
    if n is not None:
        cnt = (n.fillna(0) > 0).rolling(window, min_periods=1).sum()
        f["block_freq_inv"] = -cnt / float(window)

    return f


def risk_flag(
    wk: Dict[str, pd.DataFrame],
    amount: pd.DataFrame,
    window: int = 8,
    max_discount: float = 15.0,
    max_pressure: float = 0.30,
) -> pd.DataFrame:
    """大宗交易风险过滤器：命中则 True，建议剔除该标的。

    两条判据都来自实证结论：
      1. 近 window 周出现过超过 max_discount% 的折价成交。
         单笔深度折价大多对应解禁减持或过桥减持，后续 60 日
         平均跑输 4.1%，胜率仅 36%。
      2. 近 window 周大宗成交额占二级市场成交额超过 max_pressure。
         说明筹码正在大规模转移，原有供需平衡被打破。

    Args:
        max_discount: 触发的折价阈值（百分数）。
        max_pressure: 触发的抛压占比阈值。
    """
    prem_min = wk.get("prem_min")
    val = wk.get("value")
    amt = amount.replace(0, np.nan)
    flag = pd.DataFrame(False, index=amount.index, columns=amount.columns)

    if prem_min is not None:
        # prem_min 是"溢价率"的最小值，折价 = 负数，折价 15% -> -15
        deep = (prem_min.rolling(window, min_periods=1).min() < -max_discount)
        flag = flag | deep.fillna(False)

    if val is not None:
        ratio = val.rolling(window, min_periods=1).sum() / amt.rolling(
            window, min_periods=1
        ).sum().replace(0, np.nan)
        flag = flag | (ratio > max_pressure).fillna(False)

    return flag


# ---------------------------------------------------------------- 诊断

def coverage_report(wk: Dict[str, pd.DataFrame]) -> pd.DataFrame:
    """逐年统计：每周有多少只股票发生过大宗交易、总成交规模。"""
    val = wk.get("value")
    n = wk.get("n")
    if val is None:
        return pd.DataFrame()
    cnt = (val.fillna(0) > 0).sum(axis=1)
    tot = val.sum(axis=1) / 1e8
    df = pd.DataFrame({"有交易的股票数": cnt, "周成交额(亿)": tot})
    return df.groupby(df.index.year).mean().round(2)
