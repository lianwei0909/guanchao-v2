"""第 2b 层：基本面因子（价值 / 质量 / 成长 / 规模）。

数据源是腾讯自选股 MCP 的 ``data_finance``（income 表 core 窄表），
经 ``mcp_import.py`` 落到 ``data_cache/mcp_finance.json``。

本模块最重要的一个设计：point-in-time 对齐
--------------------------------------------
财务数据有两套日期，混用就会引入前视偏差：

    EndDate       报告期，如 2026-06-30（这份财报"说的是"哪半年）
    InfoPublDate  实际披露日，如 2026-08-15（市场"什么时候知道的"）

用 EndDate 对齐面板，等于假设 6 月 30 日就知道 8 月 15 日才公布的业绩，
回测出来的 IC 会漂亮得离谱，而且**完全不报错**。这是本层唯一必须守住的红线：
一律以 InfoPublDate 为时间戳，再 ffill 到周线。

另一个坑是财报数据的老化：A 股一年只披露 4 次，ffill 会让一份 3 个月前的
财报一直"有效"。本模块对外暴露 ``freshness()`` 报告数据年龄，
并支持用 ``max_stale`` 把过期太久的观测掐断。

因子方向统一为"越大越好"（与 features.py 一致），合成时才不会互相抵消。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
FIN_FILE = ROOT / "data_cache" / "mcp_finance.json"


# ---------------------------------------------------------------- 加载

def _to_num(s):
    return pd.to_numeric(s, errors="coerce")


def pub_deadline(end: pd.Timestamp) -> pd.Timestamp:
    """报告期 -> **法定披露截止日**，用作"市场可得日"的保守估计。

    为什么需要它
    ------------
    ``data_finance`` 带 ``type=income`` 时返回的是 core 窄表，**不含
    InfoPublDate**（实际披露日）；只有拉取三大报表（省略 type）才带，
    而那样数据量是三倍，150 只股票根本拉不动。

    好在 A 股的定期报告披露有监管硬性上限，实际披露日必然 <= 截止日：

        一季报（03-31） -> 当年 04-30
        半年报（06-30） -> 当年 08-31
        三季报（09-30） -> 当年 10-31
        年  报（12-31） -> 次年 04-30

    用截止日代替真实披露日，等于假设我们比现实更晚才知道业绩。
    这会损失一点及时性（"提前披露的公司业绩更好"那个效应抓不到），
    但绝不会引入前视偏差。宁可少赚，不能造假。

    若数据里本来就有 InfoPublDate，则以真实披露日为准。
    """
    if pd.isna(end):
        return pd.NaT
    m, y = end.month, end.year
    if m == 3:
        return pd.Timestamp(y, 4, 30)
    if m == 6:
        return pd.Timestamp(y, 8, 31)
    if m == 9:
        return pd.Timestamp(y, 10, 31)
    if m == 12:
        return pd.Timestamp(y + 1, 4, 30)
    # 非标准报告期（如调整后的中期），退化为报告期后 60 天
    return end + pd.Timedelta(days=60)


def load_finance() -> Dict[str, pd.DataFrame]:
    """读缓存，返回 {symbol: DataFrame}，index 为**披露日**。

    优先用真实披露日 InfoPublDate；没有则退回 pub_deadline() 推算的
    法定截止日。两条路都拿不到日期的记录直接丢弃。
    """
    if not FIN_FILE.exists():
        return {}
    raw = json.loads(FIN_FILE.read_text(encoding="utf-8"))
    out: Dict[str, pd.DataFrame] = {}
    for sym, by_date in raw.items():
        if not by_date:
            continue
        df = pd.DataFrame.from_dict(by_date, orient="index")
        col = df["InfoPublDate"] if "InfoPublDate" in df.columns else None
        if col is not None and col.notna().any():
            # 形如 "2026-08-15 00:00:00 +0800 CST"。
            # 尾部的 "CST" 是缩写时区，pandas 解析不了会整列变 NaT，
            # 所以只取前 10 个字符的日期部分。
            pub = pd.to_datetime(col.astype(str).str[:10], errors="coerce")
        else:
            pub = pd.to_datetime(
                df.get("EndDate", pd.Series(index=df.index, dtype=object)),
                errors="coerce",
            ).map(pub_deadline)
        df = df.assign(pub=pub).dropna(subset=["pub"])
        if df.empty:
            continue
        df = df.sort_values("pub").drop_duplicates(subset=["pub"], keep="last")
        df = df.set_index("pub")
        out[sym] = df
    return out


# ---------------------------------------------------------------- 对齐

def build_panel(
    fin: Dict[str, pd.DataFrame],
    index: pd.DatetimeIndex,
    columns: pd.Index,
    max_stale: int | None = None,
) -> Dict[str, pd.DataFrame]:
    """把逐股的财报序列对齐到周线面板。

    对齐方式：以披露日为时间戳 reindex 到周线网格，向前填充。
    这样"某周能用到的最新财报"就是截至该周已披露的那一期。

    Args:
        fin: load_finance() 的输出，key 是 sh600519 形式。
        index: 周线面板的日期索引。
        columns: 周线面板的列，6 位代码（"600519"）。
        max_stale: 允许一份财报连续沿用多少期，超出置 NaN。None = 不限制。

    Returns:
        {"<field>": DataFrame}，已 shift(1)——披露周的下一周才能用于交易。
    """
    fields = [
        "EPSTTM", "BasicEPS",
        "NPParentCompanyOwners", "NPParentCompanyOwnersTTM",
        "NPParentCompanyYOY", "NPParentCompanyYOY_Q",
        "TORGrowRate", "TORGrowRate_Q",
        "ROE", "ROETTM", "ROEWeighted", "ROE_Q",
        "ROA", "ROATTM", "ROIC",
        "GrossIncomeRatio", "NetProfitRatio",
        "OperatingRevenue", "OperatingRevenueTTM",
        "RAndD", "OperatingCost",
        "ORComGrowRate3Y", "NPPCCGrowRate3Y",
    ]
    out: Dict[str, pd.DataFrame] = {}
    for f in fields:
        cols = {}
        for code in columns:
            sym = _guess_symbol(code, fin)
            if sym is None or f not in fin[sym].columns:
                continue
            s = _to_num(fin[sym][f])
            s = s[~s.index.duplicated()].reindex(
                s.index.union(index)
            ).ffill().reindex(index)
            cols[code] = s
        df = pd.DataFrame(cols, index=index).reindex(columns=columns)
        out[f] = df.shift(1)  # 披露后下一期才交易，杜绝"当天公布当天用"

    if max_stale is not None:
        out = _apply_staleness(out, index, max_stale)
    return out


def _guess_symbol(code: str, fin: Dict[str, pd.DataFrame]):
    """6 位代码 -> 缓存里的 symbol（sh/sz 前缀）。

    优先按代码规则推断，失败再遍历兜底。
    """
    for prefix in ("sh", "sz"):
        sym = prefix + code
        if sym in fin:
            return sym
    for sym in fin:
        if sym[2:] == code:
            return sym
    return None


def _apply_staleness(panels, index, max_stale):
    """财报沿用超过 max_stale 期就置 NaN。

    判断依据是"数值有没有变过"：把每列与其上一行比较，
    相同则年龄 +1，不同则归零。年龄超限的位置清空。
    """
    ref = panels.get("EPSTTM")
    if ref is None:
        return panels
    changed = ref.ne(ref.shift(1)) | ref.isna()
    age = pd.DataFrame(0, index=index, columns=ref.columns, dtype=float)
    cur = pd.Series(0.0, index=ref.columns)
    rows = []
    for dt in index:
        cur = np.where(changed.loc[dt].values, 0.0, cur + 1.0)
        rows.append(pd.Series(cur, index=ref.columns, name=dt))
    age = pd.DataFrame(rows)
    stale = age > max_stale
    return {k: v.mask(stale) for k, v in panels.items()}


# ---------------------------------------------------------------- 因子

def compute_factors(
    panels: Dict[str, pd.DataFrame],
    close: pd.DataFrame,
) -> Dict[str, pd.DataFrame]:
    """由对齐后的财务面板算出因子，全部统一为"越大越好"。

    Args:
        panels: build_panel() 的输出。
        close: 周线收盘价面板（用于把每股指标换算成估值）。

    Returns:
        {因子名: DataFrame}，可直接送 features.winsorize_and_zscore()。
    """
    f: Dict[str, pd.DataFrame] = {}

    # ---- 规模：总股本 = 归母净利润 / 基本EPS（同期口径，自洽）
    # 市值 = 总股本 × 收盘价。EPS 极小或为负时比值会爆炸，先掐掉。
    np_ = panels.get("NPParentCompanyOwners")
    eps = panels.get("BasicEPS")
    if np_ is not None and eps is not None:
        eps_safe = eps.where(eps.abs() > 1e-3)
        shares = (np_ / eps_safe).where(lambda x: x > 0)
        shares = shares.replace([np.inf, -np.inf], np.nan)
        mktcap = shares * close
        mktcap = mktcap.where(mktcap > 0)
        f["ln_mktcap_inv"] = -np.log(mktcap.replace(0, np.nan))  # 小市值倾斜

    # ---- 价值：盈利收益率 E/P
    epsttm = panels.get("EPSTTM")
    if epsttm is not None:
        f["ep_ttm"] = epsttm / close.replace(0, np.nan)

    # ---- 质量
    for src, name in (
        ("ROETTM", "roe_ttm"),
        ("ROATTM", "roa_ttm"),
        ("ROIC", "roic"),
        ("GrossIncomeRatio", "gross_margin"),
        ("NetProfitRatio", "net_margin"),
    ):
        v = panels.get(src)
        if v is not None:
            f[name] = v

    # ---- 质量变化（"困境反转"类：ROE 有没有在改善）
    roe = panels.get("ROETTM")
    if roe is not None:
        f["roe_chg_4q"] = roe - roe.shift(4)

    # ---- 成长
    for src, name in (
        ("TORGrowRate", "rev_growth"),
        ("NPParentCompanyYOY", "np_growth"),
        ("NPParentCompanyYOY_Q", "np_growth_q"),
        ("ORComGrowRate3Y", "rev_cagr3y"),
        ("NPPCCGrowRate3Y", "np_cagr3y"),
    ):
        v = panels.get(src)
        if v is not None:
            f[name] = v

    # ---- 研发强度
    rd = panels.get("RAndD")
    rev = panels.get("OperatingRevenue")
    if rd is not None and rev is not None:
        f["rd_intensity"] = rd / rev.replace(0, np.nan)

    # ---- 毛利率变化
    gm = panels.get("GrossIncomeRatio")
    if gm is not None:
        f["gross_margin_chg"] = gm - gm.shift(4)

    return f


# ---------------------------------------------------------------- 诊断

def coverage_report(
    panels: Dict[str, pd.DataFrame],
    index: pd.DatetimeIndex,
) -> pd.DataFrame:
    """逐年统计各字段的覆盖率，用于判断样本能往前推到哪一年。"""
    rows = []
    for name, df in panels.items():
        s = df.notna().sum(axis=1)
        by_year = s.groupby(s.index.year).mean()
        rows.append(pd.Series(by_year, name=name))
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows).round(1)


def freshness(panels: Dict[str, pd.DataFrame]) -> pd.Series:
    """每期"最新财报已沿用了多少期"的中位数，用来看数据老化程度。"""
    ref = panels.get("EPSTTM")
    if ref is None:
        return pd.Series(dtype=float)
    changed = ref.ne(ref.shift(1))
    age = pd.DataFrame(np.nan, index=ref.index, columns=ref.columns)
    cur = np.zeros(len(ref.columns))
    for i, dt in enumerate(ref.index):
        cur = np.where(changed.iloc[i].values, 0, cur + 1)
        age.iloc[i] = cur
    return age.median(axis=1)
