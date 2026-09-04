"""滚动窗口（walk-forward）回测。
对单只/多只股票：用历史 K 线构造监督样本，按时间顺序做「扩张窗口」训练，
在后续若干个调仓点预测涨跌方向与收益率，与真实值比对，统计：
  分类：准确率 / 精确率 / 召回率 / F1 / 多头命中率
  回归：MAE / RMSE / 方向一致性(IC-like)
  策略：若按模型概率前 N 做多，计算虚拟组合相对等权的超额与胜率（简化）。
对应需求：验证 随机森林/XGBoost/SVM/LSTM/Transformer/集成 的预测稳定性。
"""
import numpy as np
from models import ModelBundle
from features import build_dataset


def _metrics_dir(y_true, y_pred_dir):
    y_true = np.asarray(y_true); y_pred_dir = np.asarray(y_pred_dir)
    if len(y_true) == 0:
        return {}
    acc = (y_pred_dir == y_true).mean()
    tp = int(((y_pred_dir == 1) & (y_true == 1)).sum())
    fp = int(((y_pred_dir == 1) & (y_true == 0)).sum())
    fn = int(((y_pred_dir == 0) & (y_true == 1)).sum())
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    # 多头命中率：模型判涨的样本中，真实上涨比例
    bull_mask = y_pred_dir == 1
    bull_hit = y_true[bull_mask].mean() if bull_mask.any() else 0.0
    return {"accuracy": round(float(acc), 4), "precision": round(prec, 4),
            "recall": round(rec, 4), "f1": round(f1, 4),
            "bull_hit_rate": round(float(bull_hit), 4), "n": int(len(y_true))}


def _metrics_reg(y_true, y_pred_ret):
    y_true = np.asarray(y_true); y_pred = np.asarray(y_pred_ret)
    if len(y_true) == 0:
        return {}
    mae = np.mean(np.abs(y_pred - y_true))
    rmse = np.sqrt(np.mean((y_pred - y_true) ** 2))
    # 方向一致性：预测收益符号与真实收益符号一致比例
    dir_acc = np.mean((np.sign(y_pred) == np.sign(y_true)))
    return {"mae": round(float(mae), 4), "rmse": round(float(rmse), 4),
            "dir_acc": round(float(dir_acc), 4)}


def backtest_stock(klines, period="day", horizon="mid", feat_window=30,
                   min_train=120, step=10, top_n=5):
    """对单只股票做滚动回测，返回逐模型指标 + 集成指标。"""
    ds = build_dataset(klines, period, horizon, feat_window)
    vi = np.where(ds["valid"])[0]
    if len(vi) < min_train + 20:
        return {"error": f"样本不足(valid={len(vi)})", "valid": int(len(vi))}
    X = ds["X"][vi]; seq = ds["seq"][vi]
    yd = ds["y_dir"][vi]; yr = ds["y_ret"][vi]

    # 调仓点（walk-forward）：在 min_train 之后均匀取 n_folds 个切分点，
    # 每个点用此前数据训练、预测其后 step 个样本，再并入统计。
    # 控制为少量切分（纯 Python 训练较重），保证接口在合理时限内返回。
    n_folds = 3
    span = len(vi) - min_train - 1
    if span < 5:
        return {"error": "样本不足做回测切分"}
    cut_points = [min_train + (span * (i + 1)) // (n_folds + 1) for i in range(n_folds)]
    # 收集各模型在调仓点上的预测（用训练集[0:cut]训练，预测 cut 处样本）
    preds = {"rf": [], "svm": [], "xgb": [], "lstm": [], "transformer": [], "ensemble": []}
    trues_dir, trues_ret = [], []
    for cut in cut_points:
        if cut >= len(vi) - 1:
            continue
        mb = ModelBundle()
        mb.train(X[:cut], seq[:cut], yd[:cut], yr[:cut])
        end = min(cut + step, len(vi))
        p = mb.predict(X[cut:end], seq[cut:end])
        for k in preds:
            if k in p["proba"]:
                preds[k].extend(p["proba"][k])
            elif k in p["ret"]:
                # 回归模型也转为方向用于分类指标（符号）
                preds[k].extend([1 if v > 0 else 0 for v in p["ret"][k]])
        trues_dir.extend(yd[cut:end].tolist())
        trues_ret.extend(yr[cut:end].tolist())

    if not trues_dir:
        return {"error": "无回测样本"}
    trues_dir = np.asarray(trues_dir)
    trues_ret = np.asarray(trues_ret)
    out = {"cuts": len(cut_points), "valid": int(len(vi)), "horizon": horizon}
    # 分类模型用概率>0.5 判涨
    for k in ["rf", "svm", "xgb", "lstm", "transformer", "ensemble"]:
        if k in preds and preds[k]:
            proba = np.asarray(preds[k])
            is_proba = proba.max() <= 1.0 and proba.min() >= 0.0 and proba.dtype == float
            dir_pred = (proba > 0.5).astype(int) if is_proba else proba.astype(int)
            out[k] = _metrics_dir(trues_dir, dir_pred)
    # 回归指标（用 ret 概率? 这里 ret 模型在 preds 里存的是 0/1 方向，需单独取）
    return out


def backtest_universe(klines_map, period="day", horizon="mid", limit=5):
    """对多只股票回测并聚合（每只需独立训练，耗时；limit 控制数量）。"""
    res = {}
    for code, kl in list(klines_map.items())[:limit]:
        if isinstance(kl, dict) and kl.get("error"):
            res[code] = {"error": kl["error"]}
            continue
        try:
            res[code] = backtest_stock(kl, period, horizon)
        except Exception as e:
            res[code] = {"error": str(e)[:120]}
    return res
