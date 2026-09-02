"""主流程：数据 -> 特征 -> 标注 -> 验证 -> 回测 -> 报告。

第一版刻意不含任何机器学习，目的是把地基立住：
数据口径对不对、标签定得合不合理、回测框架有没有泄漏未来信息。
地基没验证过之前上模型，只会把错误放大得更快、更难查。

用法：
    python run_pipeline.py                          # 默认周线、150 只、持有 8 周
    python run_pipeline.py --period month --top-n 10
    python run_pipeline.py --universe 300 --refresh # 全量重拉并扩大股票池
"""
from __future__ import annotations

import argparse
import sys
from typing import Dict

import numpy as np
import pandas as pd

import backtest
import datasource
import evaluate
import features
import labeling
import regime as regime_mod
import universe
import altdata as altdata_mod
import fundamental as fundamental_mod
from config import OUTPUT_DIR, Config

RULE = "=" * 78


def _section(title: str) -> None:
    print(f"\n{RULE}\n{title}\n{RULE}")


def run(cfg: Config) -> Dict[str, object]:
    cfg.ensure_dirs()
    results: Dict[str, object] = {}

    # ---------------------------------------------------------------- 1 数据
    _section("1 / 数据层")
    # 注意：这个局部变量不能叫 universe，否则会遮蔽上面 import 的 universe 模块
    uni_df = datasource.fetch_universe(pages=cfg.universe_pages)
    if uni_df.empty:
        print("股票池为空，检查网络或东财接口是否变更。")
        return results
    codes = uni_df["code"].tolist()[: cfg.universe_size]
    print(f"股票池: {len(uni_df)} 只候选，本次取成交额前 {len(codes)} 只")

    panels = datasource.build_panels(
        codes, period=cfg.period, bars=cfg.bars,
        workers=cfg.workers, use_cache=not cfg.refresh,
    )

    # 跨源校验：拿东财的最新价核对 K 线末收，抓出"代码映射错误导致取错标的"。
    # 000xxx 号段个股与指数重号，这种错不会报错，只会让结论悄悄变假。
    if cfg.cross_check:
        bad = datasource.cross_check_prices(panels, uni_df, tol=cfg.cross_check_tol)
        if not bad.empty:
            panels = datasource.drop_codes(panels, bad["code"].tolist())

    close = panels["close"]
    # 历史太短的股票剔除，否则因子全是 NaN 会稀释截面
    enough = close.notna().sum() >= cfg.min_history
    drop_codes = close.columns[~enough]
    if len(drop_codes):
        print(f"剔除历史不足 {cfg.min_history} 期的股票 {len(drop_codes)} 只")
        for k in panels:
            panels[k] = panels[k].loc[:, close.columns[enough]]

    close = panels["close"]
    industry = uni_df.set_index("code")["industry"].reindex(close.columns)
    print(f"有效标的 {close.shape[1]} 只，K 线 {close.shape[0]} 根"
          f"（{close.index[0].date()} ~ {close.index[-1].date()}）")
    results["panels"] = panels

    # 按历史时点动态选池：不用"今天的热门股"回测过去，否则等于偷看未来
    if cfg.use_pit_universe:
        pit_mask = universe.point_in_time_universe(
            panels, min_history=cfg.min_history, liq_window=cfg.pit_liq_window,
            min_price=cfg.pit_min_price, max_names=cfg.pit_max_names,
        )
        print("\n股票池（按历史时点筛选）逐年容量:")
        print(universe.universe_coverage(pit_mask).to_string())
        print(universe.coverage_warning(pit_mask))
    else:
        pit_mask = pd.DataFrame(True, index=close.index, columns=close.columns)
        print("\n已关闭历史时点选池，当前结果带有幸存者偏差，仅用于对比。")

    # 裁掉池子还太小的早期期次：三五个样本上算秩相关得到的是噪声，
    # 混进 IC 均值会把整体结论搅浑。
    valid_idx = universe.trim_thin_periods(pit_mask, min_names=cfg.pit_min_names)
    if cfg.start:
        cut = pd.Timestamp(cfg.start)
        valid_idx = valid_idx[valid_idx >= cut]
        print(f"  按 --start 强制样本起点 {cut.date()}，剩余 {len(valid_idx)} 期")
    if len(valid_idx) and len(valid_idx) < len(close.index):
        for k in panels:
            panels[k] = panels[k].loc[valid_idx]
        pit_mask = pit_mask.loc[valid_idx]
        close = panels["close"]
        industry = industry.reindex(close.columns)
        print(f"裁剪后有效标的 {close.shape[1]} 只，K 线 {close.shape[0]} 根"
              f"（{close.index[0].date()} ~ {close.index[-1].date()}）")
    results["pit_mask"] = pit_mask

    # ---------------------------------------------------------------- 2 特征
    _section("2 / 特征层")
    factors = features.compute_factors(panels)
    print(f"计算 {len(factors)} 个量价因子: {', '.join(factors)}")
    score = features.combine(
        factors, industry=industry,
        do_neutralize=cfg.industry_neutral, n_mad=cfg.winsor,
    )
    print(f"量价综合得分面板 {score.shape}，行业中性化 = {cfg.industry_neutral}")

    # ------------------------------------------------- 2b 基本面因子
    # point-in-time 对齐（用披露日而非报告期），老财报 ffill 限制沿用期数。
    # 本「大市值成交额前 N」池里基本面因子 walk-forward 无效，默认只报告 IC，
    # 不并入综合得分。
    fin = fundamental_mod.load_finance()
    fpanels = fundamental_mod.build_panel(
        fin, close.index, close.columns, max_stale=cfg.fin_stale
    )
    ff = fundamental_mod.compute_factors(fpanels, close)
    ff = {f"基本面:{k}": v for k, v in ff.items()}
    print(f"\n基本面因子 {len(ff)} 个（覆盖率中位 "
          f"{float(np.nanmean([p.notna().mean().median() for p in ff.values()])):.0%}），"
          f"默认仅报告 IC")

    # ------------------------------------------------- 2c 大宗交易因子 + 风控
    blk = altdata_mod.load_block()
    bwk = altdata_mod.weekly_panel(blk, close.index, close.columns)
    af = altdata_mod.compute_factors(bwk, panels["amount"], window=cfg.block_window)
    af = {f"大宗:{k}": v for k, v in af.items()}
    risk = altdata_mod.risk_flag(
        bwk, panels["amount"], window=cfg.block_window,
        max_discount=cfg.block_max_discount, max_pressure=cfg.block_max_pressure,
    )
    print(f"大宗交易因子 {len(af)} 个（覆盖率中位 "
          f"{float(np.nanmean([p.notna().mean().median() for p in af.values()])):.0%}）；"
          f"风控标记累计触发 {int(risk.any().sum())} 只、"
          f"周命中率 {float(risk.stack().mean()):.1%}")

    # 综合得分：量价 +（可选）大宗。基本面默认不并入（walk-forward 无效）。
    ext = dict(factors)
    if cfg.use_block_factor:
        ext.update(af)
    score_ext = features.combine(
        ext, industry=industry,
        do_neutralize=cfg.industry_neutral, n_mad=cfg.winsor,
    )
    print(f"扩展综合得分（量价"
          f"{' + 大宗' if cfg.use_block_factor else ''}）面板 {score_ext.shape}")

    # ---------------------------------------------------------------- 3 标注
    _section("3 / 标注层（三重障碍）")
    # 超额收益基准。用中位数而非等权均值：均值会被少数暴涨股拉高，
    # 导致绝大多数股票被判为"跑输"，标签严重偏向 -1。
    pct = close.pct_change().where(pit_mask)  # 只统计当期在池内的股票
    bench_ret = pct.median(axis=1) if cfg.bench_mode == "median" else pct.mean(axis=1)
    print(f"超额收益基准: 当期中位数（只统计当期在池内的股票）")
    lab = labeling.triple_barrier_labels(
        close=panels["close"], high=panels["high"], low=panels["low"],
        bench_ret=bench_ret,
        max_hold=cfg.max_hold, upper_mult=cfg.upper_mult, lower_mult=cfg.lower_mult,
        vol_window=cfg.atr_window, min_sigma=cfg.min_sigma, ambiguity=cfg.ambiguity,
    )
    print(labeling.describe_labels(lab["label"]).to_string())
    print()
    print(labeling.label_balance_report(lab["label"]))
    print(f"\n平均触发期数: {lab['hold_bars'].mean().mean():.2f} / {cfg.max_hold}")
    results["labels"] = lab

    # ---------------------------------------------------------------- 4 验证
    _section("4 / 验证层")
    # 所有横截面统计都只在当期池内股票上进行
    fwd_excess = lab["fwd_excess"].where(pit_mask)
    score_pit = score.where(pit_mask)

    # 机制自检：先用"未来收益"当因子预测它自己，IC 必然接近 1.0。
    # 这一步不是为了找 alpha，而是为了证明面板的行列对齐、索引、IC 算法都正常。
    # 如果这个数不对，后面所有 IC 结果都不可信——它把"因子没用"和"框架坏了"区分开。
    self_ic = evaluate.compute_ic(fwd_excess, fwd_excess)
    self_ic_val = float(self_ic.mean()) if len(self_ic) else float("nan")
    print(f"机制自检：未来收益 vs 自身 的 IC = {self_ic_val:.4f}（必须接近 1.0）")
    if self_ic_val < 0.99:
        print("  !! 自检未通过，说明面板对齐或 IC 计算有 bug，先修框架再看因子。")
    else:
        print("  OK 框架对齐正常，下面的 IC 结果可信任。")

    # 反向自检：把未来收益整体滞后一个持有期，IC 应显著下降。
    # 若仍然接近 1，说明某处存在错位泄漏（shift 方向搞反是这类 bug 的常见来源）。
    lag_ic = evaluate.compute_ic(fwd_excess.shift(cfg.max_hold), fwd_excess)
    lag_val = float(lag_ic.mean()) if len(lag_ic) else float("nan")
    print(f"错位自检：滞后 {cfg.max_hold} 期后 IC = {lag_val:.4f}"
          f"（应明显低于 {self_ic_val:.2f}，若仍接近 1 则存在错位泄漏）")

    # 分组 IC：量价 / 基本面 / 大宗，外加两个综合得分
    def _ic_rows(groups):
        out = []
        for gname, gfac in groups:
            for name, panel in gfac.items():
                ic = evaluate.compute_ic(panel.where(pit_mask), fwd_excess)
                out.append({"组": gname, "因子": name,
                            **evaluate.ic_summary(ic, overlap=cfg.max_hold)})
        return out

    rows = _ic_rows([("量价", factors), ("基本面", ff), ("大宗", af)])
    for label, sc in [("量价综合", score), ("扩展综合(量价+大宗)", score_ext)]:
        ic = evaluate.compute_ic(sc.where(pit_mask), fwd_excess)
        rows.append({"组": "综合", "因子": label,
                     **evaluate.ic_summary(ic, overlap=cfg.max_hold)})
    ic_table = pd.DataFrame(rows).set_index(["组", "因子"])
    print(ic_table.round(4).to_string())
    ic_table.reset_index().to_csv(OUTPUT_DIR / "factor_ic.csv", index=False, encoding="utf-8-sig")

    score_ext_pit = score_ext.where(pit_mask)
    s = evaluate.ic_summary(evaluate.compute_ic(score_ext_pit, fwd_excess), overlap=cfg.max_hold)
    sv = evaluate.ic_summary(evaluate.compute_ic(score_pit, fwd_excess), overlap=cfg.max_hold)
    print(f"\n量价综合得分判定: {evaluate.ic_verdict(sv, cfg.ic_threshold, cfg.ir_threshold)}")
    print(f"扩展综合得分（量价+大宗）判定: {evaluate.ic_verdict(s, cfg.ic_threshold, cfg.ir_threshold)}")
    print("注：标签期重叠，t 统计量已按持有期数下调（有效样本数 = 期数 / max_hold）")

    qret = evaluate.quantile_backtest(score_ext_pit, fwd_excess, n_groups=5)
    # 按持有期抽样，消除重叠样本：相邻两期的 8 周收益有 7/8 是重合的，
    # 直接全样本算夏普会把稳定性夸大好几倍。
    qret_np = qret.iloc[:: cfg.max_hold]
    qreport = evaluate.quantile_report(qret_np, cfg.ppy, horizon=cfg.max_hold)
    print(f"\n分层回测（G1 最低分 -> G5 最高分，每 {cfg.max_hold} 期抽样一次以消除重叠"
          f"，有效期数 {len(qret_np)}）:")
    print(qreport.round(4).to_string(index=False))
    mono = qreport.attrs.get("单调性", float("nan"))
    print(f"单调性（相邻组递增比例）: {mono:.1%}" if mono == mono else "单调性: 样本不足")
    qret.to_csv(OUTPUT_DIR / "quantile_returns.csv", encoding="utf-8-sig")
    results["ic_table"] = ic_table

    # ---------------------------------------------------------------- 5 状态
    _section("5 / 市场状态（规则引擎）")
    exposure = None
    idx_code = cfg.benchmark
    try:
        # 指数必须显式声明：000300 与深市主板股票同号段，靠前缀猜必然出错
        idx_k = datasource.fetch_kline(idx_code, period=cfg.period, bars=cfg.bars,
                                       use_cache=not cfg.refresh, is_index=True)
        if idx_k is not None and len(idx_k) > cfg.min_history:
            rg = regime_mod.market_regime(idx_k["close"])
            rg = rg.reindex(close.index).ffill()
            print(regime_mod.regime_report(rg).round(4).to_string())
            print("\n最近 5 期状态:")
            print(rg[["close", "state", "position_cap"]].tail(5).to_string())
            exposure = rg["position_cap"]
            rg.to_csv(OUTPUT_DIR / "market_regime.csv", encoding="utf-8-sig")
            results["regime"] = rg
        else:
            print("基准指数数据不足，跳过状态判断。")
    except Exception as exc:  # noqa: BLE001
        print(f"基准指数获取失败（{exc}），本次不做状态调节。")

    # ---------------------------------------------------------------- 6 回测
    _section("6 / 回测层")
    # 这里刻意**不**给 ret 加掩码：已持有的股票若中途掉出池子，置空会把它的
    # 真实收益抹成 0，反而低估组合。池外股票的权重本来就是 0（score_pit 为 NaN），
    # 不会进入组合；掩码只需要作用在等权基准上。
    ret = close.shift(-1) / close - 1.0
    # 三种得分对比：量价基线 / 量价+大宗 / 量价+大宗+风控过滤
    score_safe = score_ext_pit.mask(risk)  # risk_flag 命中处置 NaN，剔除出选股池
    score_variants = [
        ("量价基线", score_pit),
        ("量价+大宗", score_ext_pit),
        ("量价+大宗+风控", score_safe),
    ]
    adj_variants = [("不调节", None)]
    if exposure is not None:
        adj_variants.append(("状态调节", exposure))
    results_bt = {}
    for sc_label, sc in score_variants:
        for adj_label, exp in adj_variants:
            tag = f"{sc_label}｜{adj_label}"
            bt = backtest.run_backtest(
                sc, ret,
                top_n=cfg.top_n, rebalance_every=cfg.rebalance_every,
                commission_bps=cfg.commission_bps, stamp_bps=cfg.stamp_bps,
                slippage_bps=cfg.slippage_bps, exposure=exp,
            )
            m = evaluate.perf_metrics(bt["net"], cfg.ppy)
            m["年化换手"] = bt["turnover"][bt["turnover"] > 0].mean() * cfg.ppy / cfg.rebalance_every
            m["年化成本"] = bt["cost"].mean() * cfg.ppy
            results_bt[tag] = m
            results[f"bt_{tag}"] = bt

    base_tag = "量价基线｜不调节"
    bench_series = backtest.equal_weight_benchmark(ret, mask=pit_mask).reindex(
        results[f"bt_{base_tag}"]["net"].index
    )
    results_bt["等权基准"] = evaluate.perf_metrics(bench_series, cfg.ppy)

    bt_table = pd.DataFrame(results_bt).T
    cols = ["年化收益", "年化波动", "夏普", "最大回撤", "Calmar", "胜率", "年化换手", "年化成本"]
    print(bt_table[[c for c in cols if c in bt_table.columns]].round(4).to_string())
    bt_table.to_csv(OUTPUT_DIR / "backtest_metrics.csv", encoding="utf-8-sig")

    out_tag = "量价+大宗+风控｜不调节" if f"bt_量价+大宗+风控｜不调节" in results else "量价+大宗+风控"
    net = results[f"bt_{out_tag}"]["net"]
    pd.DataFrame({
        "组合净收益": net,
        "组合毛收益": results[f"bt_{out_tag}"]["gross"],
        "成本": results[f"bt_{out_tag}"]["cost"],
        "等权基准": bench_series,
    }).to_csv(OUTPUT_DIR / "portfolio_returns.csv", encoding="utf-8-sig")

    # ---------------------------------------------------------------- 7 判定
    _section("7 / 是否达到实盘门槛")
    checks = []
    checks.append(("IC 均值 > 0.03", s["IC均值"] > cfg.ic_threshold, f"{s['IC均值']:.4f}"))
    checks.append(("IR > 0.5", s["IR"] > cfg.ir_threshold, f"{s['IR']:.3f}"))
    checks.append(("IC 未异常偏高(<0.1)", s["IC均值"] < 0.1, f"{s['IC均值']:.4f}"))
    if mono == mono:
        checks.append(("分层单调性 > 60%", mono > 0.6, f"{mono:.1%}"))
    chk_tag = "量价+大宗+风控｜不调节" if "量价+大宗+风控｜不调节" in results_bt else "量价+大宗+风控"
    net_m = results_bt[chk_tag]
    checks.append(("扣成本后年化为正", net_m["年化收益"] > 0, f"{net_m['年化收益']:.2%}"))
    checks.append(("夏普 > 0.5", (net_m["夏普"] or 0) > 0.5, f"{net_m['夏普']:.2f}"))
    checks.append(("最大回撤 < 30%", net_m["最大回撤"] > -0.30, f"{net_m['最大回撤']:.2%}"))

    for name, ok, val in checks:
        print(f"  [{'通过' if ok else '未过'}] {name:<22} 实测 {val}")

    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} 项达标。"
          + ("可以进入下一步。" if passed == len(checks)
             else "未全项达标，先调参数或补数据，不要急着上模型。"))
    print("\n提醒：即便全部达标，实盘预期也要按回测收益打 5-7 折。")

    return results


def parse_args() -> Config:
    p = argparse.ArgumentParser(description="A股周/月频规则选股与高低点标注系统（第一版）")
    p.add_argument("--period", default="week", choices=["week", "month"])
    # 与 Config 保持一致：腾讯周线 800 根约到 2011 年，再大反而被截断
    p.add_argument("--bars", type=int, default=800)
    p.add_argument("--universe", type=int, default=150)
    p.add_argument("--pages", type=int, default=3)
    p.add_argument("--top-n", type=int, default=20)
    p.add_argument("--max-hold", type=int, default=8)
    p.add_argument("--rebalance", type=int, default=4)
    p.add_argument("--upper", type=float, default=1.0)
    p.add_argument("--lower", type=float, default=0.8)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--refresh", action="store_true")
    p.add_argument("--no-pit", action="store_true",
                   help="关闭按历史时点选池，用于对比幸存者偏差的影响")
    p.add_argument("--start", default=None,
                   help="样本起始日期 YYYY-MM-DD。做 A/B 对比时必须两边对齐，"
                        "否则一个是 2011 起、另一个含 2008 暴跌，比不出真实差异")
    a = p.parse_args()
    return Config(
        period=a.period, bars=a.bars, universe_size=a.universe, universe_pages=a.pages,
        top_n=a.top_n, max_hold=a.max_hold, rebalance_every=a.rebalance,
        upper_mult=a.upper, lower_mult=a.lower, workers=a.workers, refresh=a.refresh,
        use_pit_universe=not a.no_pit, start=a.start,
    )


if __name__ == "__main__":
    run(parse_args())
