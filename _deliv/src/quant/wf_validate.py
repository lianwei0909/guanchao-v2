"""walk-forward 严格验证新因子（基本面 + 大宗）。

复用 factor_direction.walk_forward_direction：训练窗定方向，测试窗算样本外 IC。
逐因子单跑 + 分组组合跑，看新因子在「没见过的数据」上是否站得住脚。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import altdata
import datasource
import evaluate
import factor_direction
import fundamental
import labeling
import universe
from config import Config

cfg = Config(period="week", bars=800, universe_size=150, universe_pages=3,
             min_history=60, max_hold=8, upper_mult=1.0, lower_mult=0.8,
             atr_window=12, min_sigma=0.01, ambiguity="skip",
             use_pit_universe=True, pit_min_names=30)

print("加载数据（本地缓存）...")
_uni = json.loads(Path("data_cache/universe_syms.json").read_text(encoding="utf-8"))
codes = _uni["codes"][: cfg.universe_size]
panels = datasource.build_panels(codes, period=cfg.period, bars=cfg.bars, use_cache=True)
close = panels["close"]
enough = close.notna().sum() >= cfg.min_history
if len(close.columns[~enough]):
    for k in panels:
        panels[k] = panels[k].loc[:, close.columns[enough]]
close = panels["close"]
pit = universe.point_in_time_universe(panels, min_history=cfg.min_history,
                                      liq_window=cfg.pit_liq_window,
                                      min_price=cfg.pit_min_price,
                                      max_names=cfg.pit_max_names)
valid_idx = universe.trim_thin_periods(pit, min_names=cfg.pit_min_names)
for k in panels:
    panels[k] = panels[k].loc[valid_idx]
pit = pit.loc[valid_idx]
close = panels["close"]
pct = close.pct_change().where(pit)
bench = pct.median(axis=1)
lab = labeling.triple_barrier_labels(close=panels["close"], high=panels["high"],
                                     low=panels["low"], bench_ret=bench,
                                     max_hold=cfg.max_hold, upper_mult=cfg.upper_mult,
                                     lower_mult=cfg.lower_mult, vol_window=cfg.atr_window,
                                     min_sigma=cfg.min_sigma, ambiguity=cfg.ambiguity)
fwd = lab["fwd_excess"].where(pit)
print(f"样本 {close.shape[1]} 只 × {close.shape[0]} 期")

fin = fundamental.load_finance()
fpanels = fundamental.build_panel(fin, close.index, close.columns, max_stale=12)
ff = {k: v.where(pit) for k, v in fundamental.compute_factors(fpanels, close).items()}

blk = altdata.load_block()
bwk = altdata.weekly_panel(blk, close.index, close.columns)
af = {k: v.where(pit) for k, v in altdata.compute_factors(bwk, panels["amount"], window=8).items()}

RULE = "=" * 78


def wf_one(name: str, panel: pd.DataFrame):
    wf = factor_direction.walk_forward_direction({name: panel}, fwd, cfg, ic_floor=0.0)
    if wf.empty:
        return None
    ic = wf["IC均值"]
    return {
        "因子": name,
        "样本外IC均值": float(ic.mean()),
        "IC为正的窗口": f"{int((ic > 0).sum())}/{len(ic)}",
        "跨窗IR": float(ic.mean() / ic.std()) if ic.std() > 0 else float("nan"),
        "平均入选因子": float(wf["入选因子数"].mean()),
    }


print(f"\n{RULE}\n单因子 walk-forward 样本外（基本面，覆盖率中位 46%）\n{RULE}")
rows = [wf_one(n, p) for n, p in ff.items()]
print(pd.DataFrame([r for r in rows if r]).round(4).to_string(index=False))

print(f"\n{RULE}\n单因子 walk-forward 样本外（大宗，频率因子覆盖 100%）\n{RULE}")
rows = [wf_one(n, p) for n, p in af.items()]
print(pd.DataFrame([r for r in rows if r]).round(4).to_string(index=False))

print(f"\n{RULE}\n分组组合 walk-forward 样本外\n{RULE}")
combos = {
    "基本面组(等权)": ff,
    "大宗组(等权)": af,
    "基本面+大宗(等权)": {**ff, **af},
}
crows = []
for label, fac in combos.items():
    wf = factor_direction.walk_forward_direction(fac, fwd, cfg, ic_floor=0.0)
    if wf.empty:
        print(f"  {label}: 样本不足")
        continue
    ic = wf["IC均值"]
    print(f"\n  [{label}] 样本外IC均值 {ic.mean():+.4f}  正窗口 {int((ic>0).sum())}/{len(ic)}"
          f"  跨窗IR {ic.mean()/ic.std() if ic.std()>0 else float('nan'):+.3f}")
    print(wf.round(4).to_string(index=False))
    crows.append({"组合": label, "样本外IC均值": round(float(ic.mean()), 4),
                  "IC为正的窗口": f"{int((ic>0).sum())}/{len(ic)}",
                  "跨窗IR": round(float(ic.mean()/ic.std()) if ic.std()>0 else float('nan'),3)})
print("\n组合汇总:")
print(pd.DataFrame(crows).to_string(index=False))

# 分年度符号稳定性（大宗频率因子 vs 基本面最佳）
print(f"\n{RULE}\n分年度 IC（符号稳定性）：最强单因子 + 基本面最佳\n{RULE}")
focus = {"block_freq_inv": af["block_freq_inv"], "ep_ttm": ff["ep_ttm"]}
yic = factor_direction.yearly_ic(focus, fwd)
print(yic.round(4).to_string())
for n in yic.columns:
    s = yic[n].dropna()
    if len(s):
        print(f"  {n:<14} 正值年份 {int((s>0).sum())}/{len(s)}  均值 {s.mean():+.4f}")
