"""观潮 ML 预测服务（Flask）。
供 Node 后端经 HTTP 调用。端点：
  GET  /health                引擎健康与可用模型
  POST /predict               {codes?, period, horizon, limit} -> 各股涨跌概率/收益预测(含模型分解)
  POST /backtest              {codes?, period, horizon, limit} -> 滚动窗口回测指标
设计：纯 numpy/sklearn/xgboost 实现，torch 可选；所有重计算异步在请求内完成，
      带超时与异常兜底，单模型失败不影响整体返回。
"""
import json
import os
import sys
import time

import numpy as np
from flask import Flask, request, jsonify

sys.path.insert(0, os.path.dirname(__file__))
from data_feed import fetch_universe, secid_of
from features import build_dataset
from models import ModelBundle, SKLEARN_OK, XGB_OK, TORCH_OK

app = Flask(__name__)
PORT = int(os.environ.get("ML_SERVICE_PORT", "8800"))


def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/health", methods=["GET", "OPTIONS"])
def health():
    if request.method == "OPTIONS":
        return _cors(("", 204))
    return _cors(jsonify({
        "status": "ok",
        "sklearn": SKLEARN_OK, "xgboost": XGB_OK, "torch": TORCH_OK,
        "models": ["random_forest", "svm", "xgboost", "lstm(numpy)",
                   "transformer(numpy)", "ensemble"],
    }))


# 进程内模型缓存：相同 code+period+horizon 复用已训练模型，避免重复训练
_MB_CACHE = {}
_MB_CACHE_TTL = 1800  # 秒


def _build_predict(code, period, horizon, feat_window=30):
    from data_feed import fetch_kline
    kl = fetch_kline(code, period, lmt=500)
    if not kl or len(kl) < 80:
        return {"code": code, "error": "kline 不足"}
    ds = build_dataset(kl, period, horizon, feat_window)
    vi = np.where(ds["valid"])[0]
    if len(vi) < 80:
        return {"code": code, "error": "有效样本不足(%d)" % len(vi)}
    X = ds["X"][vi]; seq = ds["seq"][vi]
    yd = ds["y_dir"][vi]; yr = ds["y_ret"][vi]
    key = "%s|%s|%s" % (code, period, horizon)
    was_cached = key in _MB_CACHE
    if not was_cached:
        mb = ModelBundle()
        train_res = mb.train(X, seq, yd, yr)
        _MB_CACHE[key] = (mb, train_res)
    else:
        mb, train_res = _MB_CACHE[key]
    # 预测最新一根 K 线（特征只依赖 t 及之前的数据，是真正的「当前」信号；
    # 原实现取的是最后一个带标签样本，信号会滞后 H 根K）
    px, pseq = ds["X"][-1:], ds["seq"][-1:]
    if not (np.isfinite(px).all() and np.isfinite(pseq).all()):
        px, pseq = X[-1:], seq[-1:]
    p = mb.predict(px, pseq)
    ens_p = float((p["proba"].get("ensemble") or [0.5])[0])
    ens_r = float((p["ret"].get("ensemble") or [0.0])[0])
    # NaN/Inf 会让 jsonify 产出非法 JSON（Node 端 JSON.parse 直接失败，拖垮整批结果）
    if not (np.isfinite(ens_p) and np.isfinite(ens_r)):
        return {"code": code, "error": "预测值非有限（样本数据质量不足）"}
    # 汇总各模型评估指标（参考 PKU 统计学习教程：RMSE/准确率/特征重要性）
    metrics = {}
    for mk, m in mb.metrics.items():
        entry = {"acc": round(m["acc"], 4), "rmse": round(m["rmse"], 3)}
        if m.get("feat_imp") is not None:
            # 特征重要性 Top-5（索引 + 名称在前端映射）
            fi = np.array(m["feat_imp"])
            top5_idx = np.argsort(fi)[-5:][::-1].tolist()
            entry["feat_top5"] = [{"idx": int(i), "imp": round(float(fi[i]), 4)} for i in top5_idx]
        metrics[mk] = entry
    return {
        "code": code, "name": kl[-1].get("name") if kl[-1].get("name") else code,
        "date": ds["dates"][-1], "H": ds["H"],
        "ensemble_prob_up": round(ens_p, 4),
        "ensemble_exp_return": round(ens_r, 3),
        "view": "看多" if ens_p > 0.55 else ("看空" if ens_p < 0.45 else "中性"),
        "proba": {k: round(float(v[0]), 4) for k, v in p["proba"].items()
                  if k != "ensemble" and np.isfinite(float(v[0]))},
        "ret": {k: round(float(v[0]), 3) for k, v in p["ret"].items()
                if k != "ensemble" and np.isfinite(float(v[0]))},
        "clf_weights": {k: round(float(w), 3) for k, w in p.get("clf_weights", {}).items()
                        if np.isfinite(float(w))},
        "metrics": metrics,
        "train": train_res,
        "cached": was_cached,
    }


@app.route("/predict", methods=["POST", "OPTIONS"])
def predict():
    if request.method == "OPTIONS":
        return _cors(("", 204))
    body = request.get_json(force=True, silent=True) or {}
    period = body.get("period", "day")
    horizon = body.get("horizon", "mid")
    codes = body.get("codes") or []
    limit = int(body.get("limit", 8))
    if not codes:
        from data_feed import DEFAULT_UNIVERSE
        codes = DEFAULT_UNIVERSE
    codes = codes[:limit]
    t0 = time.time()
    # 预测训练时长（秒）：已缓存的个股约 1s，需首训的约 35s/只。
    # 作为前端展示的「预测训练时长」，比固定系数估算更贴合实际（命中缓存时明显更短）
    eta_s = 0.0
    for c in codes:
        key = "%s|%s|%s" % (c, period, horizon)
        eta_s += 1.0 if key in _MB_CACHE else 35.0
    out = []
    for c in codes:
        try:
            out.append(_build_predict(c, period, horizon))
        except Exception as e:
            out.append({"code": c, "error": str(e)[:160]})
    return _cors(jsonify({"period": period, "horizon": horizon,
                          "elapsed_s": round(time.time() - t0, 2),
                          "eta_s": round(eta_s, 1),
                          "results": out}))


@app.route("/backtest", methods=["POST", "OPTIONS"])
def backtest():
    if request.method == "OPTIONS":
        return _cors(("", 204))
    body = request.get_json(force=True, silent=True) or {}
    period = body.get("period", "day")
    horizon = body.get("horizon", "mid")
    codes = body.get("codes") or []
    limit = int(body.get("limit", 5))
    if not codes:
        from data_feed import DEFAULT_UNIVERSE
        codes = DEFAULT_UNIVERSE
    km = fetch_universe(codes[:limit], period, lmt=500)
    from backtest import backtest_universe
    res = backtest_universe(km, period, horizon, limit=limit)
    return _cors(jsonify({"period": period, "horizon": horizon, "results": res}))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, threaded=True, debug=False)
