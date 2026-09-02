"""因子方向检验：A 股周线到底是动量还是反转？

## 背景

第一次全样本跑完，8 个因子里 5 个动量为负、1 个反转为正，方向出奇地一致。
但**直接按样本内 IC 的符号翻转，是典型的自欺**——同样的样本既用来定方向
又用来评价，得到的 IC 必然好看，却没有任何预测意义。

所以这个脚本只做两件能站得住脚的事：
  1. **分年度符号稳定性**：真规律应该在多数年份同号，而不是被某一年撑起来。
  2. **walk-forward 样本外检验**：在训练窗里定方向，到**没见过**的测试窗里验证，
     中间用 embargo 隔开，杜绝标签跨窗泄漏。

只有第 2 步的样本外 IC 才算证据。

用法：
    python factor_direction.py
"""
from __future__ import annotations

from typing import Dict, List

import numpy as np
import pandas as pd

import datasource
import evaluate
import features
import labeling
import universe
from config import Config, OUTPUT_DIR

RULE = "=" * 78


def yearly_ic(
    factors: Dict[str, pd.DataFrame],
    fwd_excess: pd.DataFrame,
    min_periods: int = 20,
) -> pd.DataFrame:
    """逐年算每个因子的 IC，用来看符号是否稳定。"""
    out: Dict[str, pd.Series] = {}
    for name, panel in factors.items():
        ic = evaluate.compute_ic(panel, fwd_excess)
        s = ic.groupby(ic.index.year).mean()
        cnt = ic.groupby(ic.index.year).count()
        s = s.where(cnt >= min_periods)   # 期数太少的年份不参与
        out[name] = s
    return pd.DataFrame(out)


def walk_forward_direction(
    factors: Dict[str, pd.DataFrame],
    fwd_excess: pd.DataFrame,
    cfg: Config,
    ic_floor: float = 0.0,
) -> pd.DataFrame:
    """滚动前进：训练窗定方向与权重，测试窗验证。

    Args:
        ic_floor: 训练窗 IC 绝对值的入选门槛。低于此值的因子方向不可信，
            直接弃用（权重 0），而不是硬给它一个符号。

    Returns:
        每个测试窗的样本外 IC / IR / 选中的因子数。
    """
    index = fwd_excess.index
    names = list(factors)
    rows: List[dict] = []

    for k, (tr, te) in enumerate(
        evaluate.walk_forward_splits(
            index, cfg.train_bars, cfg.test_bars, cfg.embargo_bars
        ),
        1,
    ):
        # --- 训练窗：只在这里看数据，决定符号与权重 ---
        signs, weights = {}, {}
        for name in names:
            ic_tr = evaluate.compute_ic(factors[name].loc[tr], fwd_excess.loc[tr])
            ic_tr = ic_tr.dropna()
            if len(ic_tr) < 10:
                continue
            val = float(ic_tr.mean())
            if abs(val) < ic_floor:
                continue                      # 方向不可信，弃用
            signs[name] = 1.0 if val > 0 else -1.0
            weights[name] = abs(val)          # 按 IC 强度加权

        if not signs:
            continue
        wsum = sum(weights.values())

        # --- 测试窗：用训练窗定好的符号打分，全程没碰过测试数据 ---
        z = {
            name: features.winsorize_and_zscore(factors[name].loc[te], cfg.winsor)
            for name in signs
        }
        score = sum(
            (weights[n] / wsum) * signs[n] * z[n] for n in signs
        )

        ic_te = evaluate.compute_ic(score, fwd_excess.loc[te]).dropna()
        if len(ic_te) < 5:
            continue
        s = evaluate.ic_summary(ic_te, overlap=cfg.max_hold)

        rows.append({
            "窗序": k,
            "训练区间": f"{tr[0].date()}~{tr[-1].date()}",
            "测试区间": f"{te[0].date()}~{te[-1].date()}",
            "入选因子数": len(signs),
            **{kk: s[kk] for kk in ("IC均值", "IR", "IC正率")},
        })

    return pd.DataFrame(rows)


def main(cfg: Config) -> None:
    cfg.ensure_dirs()

    print(RULE)
    print("因子方向检验：动量 vs 反转")
    print(RULE)

    uni_df = datasource.fetch_universe(pages=cfg.universe_pages)
    codes = uni_df["code"].tolist()[: cfg.universe_size]
    panels = datasource.build_panels(
        codes, period=cfg.period, bars=cfg.bars,
        workers=cfg.workers, use_cache=not cfg.refresh,
    )
    if cfg.cross_check:
        bad = datasource.cross_check_prices(panels, uni_df, tol=cfg.cross_check_tol)
        if not bad.empty:
            panels = datasource.drop_codes(panels, bad["code"].tolist())

    close = panels["close"]
    enough = close.notna().sum() >= cfg.min_history
    for k in panels:
        panels[k] = panels[k].loc[:, close.columns[enough]]
    close = panels["close"]

    pit_mask = universe.point_in_time_universe(
        panels, min_history=cfg.min_history, liq_window=cfg.pit_liq_window,
        min_price=cfg.pit_min_price, max_names=cfg.pit_max_names,
    )
    valid_idx = universe.trim_thin_periods(pit_mask, min_names=cfg.pit_min_names)
    if cfg.start:
        valid_idx = valid_idx[valid_idx >= pd.Timestamp(cfg.start)]
    for k in panels:
        panels[k] = panels[k].loc[valid_idx]
    pit_mask = pit_mask.loc[valid_idx]
    close = panels["close"]
    print(f"样本: {close.shape[1]} 只 × {close.shape[0]} 期"
          f"（{close.index[0].date()} ~ {close.index[-1].date()}）\n")

    factors = features.compute_factors(panels)
    pct = close.pct_change().where(pit_mask)
    bench_ret = pct.median(axis=1) if cfg.bench_mode == "median" else pct.mean(axis=1)
    lab = labeling.triple_barrier_labels(
        close=panels["close"], high=panels["high"], low=panels["low"],
        bench_ret=bench_ret,
        max_hold=cfg.max_hold, upper_mult=cfg.upper_mult, lower_mult=cfg.lower_mult,
        vol_window=cfg.atr_window, min_sigma=cfg.min_sigma, ambiguity=cfg.ambiguity,
    )
    fwd_excess = lab["fwd_excess"].where(pit_mask)
    for name in factors:
        factors[name] = factors[name].where(pit_mask)

    # ---------------------------------------------------------- 1 符号稳定性
    print(RULE)
    print("1 / 分年度 IC（看符号是否稳定，而不是被某一年撑起来）")
    print(RULE)
    yic = yearly_ic(factors, fwd_excess)
    print(yic.round(4).to_string())
    print()
    nonzero = yic.replace(0, np.nan)
    for name in yic.columns:
        s = yic[name].dropna()
        if not len(s):
            continue
        pos = int((s > 0).sum())
        print(f"  {name:<14} 正值年份 {pos}/{len(s)}"
              f"  均值 {s.mean():+.4f}  最正 {s.max():+.4f}  最负 {s.min():+.4f}")

    # ---------------------------------------------------------- 2 walk-forward
    print()
    print(RULE)
    print("2 / walk-forward 样本外检验（训练窗定方向，测试窗验证）")
    print(RULE)
    print(f"训练 {cfg.train_bars} 期 / 测试 {cfg.test_bars} 期 / 禁运 {cfg.embargo_bars} 期")
    print()
    wf = walk_forward_direction(factors, fwd_excess, cfg, ic_floor=0.0)
    if wf.empty:
        print("样本不足以切分，调小 train_bars / test_bars。")
        return
    print(wf.round(4).to_string(index=False))
    print()
    ic_oos = wf["IC均值"]
    print(f"样本外 IC 均值 {ic_oos.mean():+.4f}（各窗标准差 {ic_oos.std():.4f}）")
    print(f"样本外 IC 为正的窗口 {int((ic_oos > 0).sum())}/{len(ic_oos)}")
    print(f"样本外 IR（均值/标准差）{ic_oos.mean() / ic_oos.std() if ic_oos.std() > 0 else float('nan'):.3f}")
    print()
    print("判定: " + evaluate.ic_verdict(
        {"IC均值": float(ic_oos.mean()),
         "IR": float(ic_oos.mean() / ic_oos.std() if ic_oos.std() > 0 else 0.0),
         "IC正率": float((ic_oos > 0).mean())},
        cfg.ic_threshold, cfg.ir_threshold,
    ))
    print("注意：这里的 IR 是「各窗 IC 均值 / 各窗 IC 标准差」，衡量方向能否稳定复现，")
    print("      与单期 IR（IC 均值 / IC 标准差）不是同一个量，但两者结论方向一致。")

    # ---------------------------------------------- 2b 门槛敏感性
    print()
    print(RULE)
    print("2b / 方向置信度门槛敏感性（训练窗 |IC| 太小的因子直接弃用）")
    print(RULE)
    print("  门槛越高，入选因子越少，但每个方向都更有把握。若高门槛下样本外 IC 反而变好，")
    print("  说明多数因子只是在贡献噪声。")
    print()
    sens = []
    for floor in (0.0, 0.01, 0.02, 0.03, 0.05):
        w = walk_forward_direction(factors, fwd_excess, cfg, ic_floor=floor)
        if w.empty:
            continue
        ic = w["IC均值"]
        sens.append({
            "门槛": floor,
            "平均入选因子数": round(float(w["入选因子数"].mean()), 1),
            "样本外IC均值": round(float(ic.mean()), 4),
            "样本外IC标准差": round(float(ic.std()), 4),
            "IC为正的窗口": f"{int((ic > 0).sum())}/{len(ic)}",
            "跨窗IR": round(float(ic.mean() / ic.std()) if ic.std() > 0 else float("nan"), 3),
        })
    print(pd.DataFrame(sens).to_string(index=False))

    # ---------------------------------------------------------- 3 稳定性对照
    print()
    print(RULE)
    print("3 / 对照：只用反转因子 vs 只用动量因子（不调方向，全样本）")
    print(RULE)
    for tag, names in (
        ("反转 rev_4", ["rev_4"]),
        ("动量类取负", ["mom_12_1", "trend_dev", "trend_slope", "pos_52"]),
    ):
        z = [features.winsorize_and_zscore(factors[n], cfg.winsor) for n in names]
        sc = sum(z) / len(z)
        if tag.startswith("动量"):
            sc = -sc
        s = evaluate.ic_summary(
            evaluate.compute_ic(sc.where(pit_mask), fwd_excess), overlap=cfg.max_hold
        )
        print(f"  {tag:<14} IC {s['IC均值']:+.4f}  IR {s['IR']:+.3f}  "
              f"IC正率 {s['IC正率']:.1%}  t {s['t统计量']:+.2f}")

    wf.to_csv(OUTPUT_DIR / "walk_forward_direction.csv", index=False, encoding="utf-8-sig")
    yic.to_csv(OUTPUT_DIR / "yearly_ic.csv", encoding="utf-8-sig")


if __name__ == "__main__":
    main(Config(start="2011-12-04"))
