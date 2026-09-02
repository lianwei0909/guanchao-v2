"""快速验证：基本面 + 大宗交易因子能否计算、IC 方向与 amount 口径。

不改动 run_pipeline，单独跑一遍拿到结论再决定接入方式。
用本地 K 线缓存（不打网络），财务/大宗走 mcp 缓存。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import altdata
import datasource
import evaluate
import fundamental
import labeling
import universe
from config import Config

cfg = Config(period="week", bars=800, universe_size=150, universe_pages=3,
             min_history=60, max_hold=8, upper_mult=1.0, lower_mult=0.8,
             atr_window=12, min_sigma=0.01, ambiguity="skip",
             use_pit_universe=True, pit_min_names=30,
             industry_neutral=True, winsor=5.0)

print("=" * 78)
print("1 / 数据层（读本地缓存）")
# 直接用本地 universe_syms.json 的 150 只，避免再联网拉东财列表
_uni = json.loads(Path("data_cache/universe_syms.json").read_text(encoding="utf-8"))
codes = _uni["codes"][: cfg.universe_size]
print(f"股票池: 本地清单 {len(codes)} 只")
panels = datasource.build_panels(codes, period=cfg.period, bars=cfg.bars,
                                 use_cache=True)
close = panels["close"]
enough = close.notna().sum() >= cfg.min_history
drop = close.columns[~enough]
if len(drop):
    for k in panels:
        panels[k] = panels[k].loc[:, close.columns[enough]]
close = panels["close"]
print(f"有效标的 {close.shape[1]} 只，K 线 {close.shape[0]} 根")

pit = universe.point_in_time_universe(panels, min_history=cfg.min_history,
                                      liq_window=cfg.pit_liq_window,
                                      min_price=cfg.pit_min_price,
                                      max_names=cfg.pit_max_names)
valid_idx = universe.trim_thin_periods(pit, min_names=cfg.pit_min_names)
for k in panels:
    panels[k] = panels[k].loc[valid_idx]
pit = pit.loc[valid_idx]
close = panels["close"]
print(f"裁剪后 {close.shape[1]} 只 / {close.shape[0]} 期")

print("=" * 78)
print("2 / 标注层")
pct = close.pct_change().where(pit)
bench = pct.median(axis=1)
lab = labeling.triple_barrier_labels(
    close=panels["close"], high=panels["high"], low=panels["low"],
    bench_ret=bench, max_hold=cfg.max_hold, upper_mult=cfg.upper_mult,
    lower_mult=cfg.lower_mult, vol_window=cfg.atr_window,
    min_sigma=cfg.min_sigma, ambiguity=cfg.ambiguity,
)
fwd = lab["fwd_excess"].where(pit)
print(labeling.label_balance_report(lab["label"]))

print("=" * 78)
print("3 / amount 口径检查（volume 单位决定大宗/二级比率是否合理）")
amt = panels["amount"]
# 取几只样本，对比 amount 量级与 block value 量级
blk_raw = altdata.load_block()
sample_syms = [s for s in ("sh600519", "sz000858", "sh601318") if s in blk_raw]
for s in sample_syms[:2]:
    code = s[2:]
    if code in amt.columns:
        a = amt[code].dropna()
        bv = blk_raw[s]["value"]
        print(f"  {s}: amount 周中位={a.median():.3e} 元；"
              f"大宗周成交中位={bv.median():.3e} 元；"
              f"ratio≈{bv.median()/a.median():.2%}（占二级成交比）")

print("=" * 78)
print("4 / 基本面因子")
fin = fundamental.load_finance()
print(f"  缓存标的 {len(fin)} 只")
fpanels = fundamental.build_panel(fin, close.index, close.columns, max_stale=12)
ff = fundamental.compute_factors(fpanels, close)
print(f"  算出 {len(ff)} 个基本面因子，覆盖情况（非空占比中位）:")
for name, p in ff.items():
    cov = float(p.notna().mean().median())
    print(f"    {name:<16} 覆盖 {cov:6.1%}")

print("=" * 78)
print("5 / 大宗因子 + 风控标记")
blk = altdata.load_block()
print(f"  缓存标的 {len(blk)} 只")
bwk = altdata.weekly_panel(blk, close.index, close.columns)
af = altdata.compute_factors(bwk, amt, window=8)
risk = altdata.risk_flag(bwk, amt, window=8, max_discount=15.0, max_pressure=0.30)
print(f"  算出 {len(af)} 个大宗因子")
for name, p in af.items():
    cov = float(p.notna().mean().median())
    print(f"    {name:<16} 覆盖 {cov:6.1%}")
print(f"  风控标记命中率（任意周任一标的中招）: "
      f"{float(risk.stack().mean()):.2%}；累计触发标的 {int(risk.any().sum())} 只")


def report(d: dict, title: str):
    print(f"\n--- {title} IC（全样本截面，带 pit_mask）---")
    rows = []
    for name, p in d.items():
        ic = evaluate.compute_ic(p.where(pit), fwd.where(pit))
        s = evaluate.ic_summary(ic, overlap=cfg.max_hold)
        rows.append({"因子": name, **s})
    t = pd.DataFrame(rows).set_index("因子")
    print(t.round(4).to_string())


report(ff, "基本面")
report(af, "大宗")

# 综合：把基本面 + 大宗都并进一个等权得分，看对 fwd 的联合 IC
allf = {**ff, **af}
from features import combine
comb = combine(allf, industry=None, do_neutralize=False, n_mad=5.0)
cic = evaluate.compute_ic(comb.where(pit), fwd.where(pit))
print("\n--- 基本面+大宗 等权合成得分 IC ---")
print(evaluate.ic_summary(cic, overlap=cfg.max_hold))
