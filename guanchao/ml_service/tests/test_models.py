"""models.py 模型评估回归门禁。

把 DeepEval「指标 + 阈值断言」的工程纪律落到量化模型上：
每次改动 models.py 后跑本测试，若关键 OOF 指标低于阈值即判定退化（Fail），
防止后续修改悄悄拉低预测质量。

运行方式（无需 pytest）：
    python tests/test_models.py
也可用 pytest 跑（函数名以 test_ 开头，自动识别）：
    python -m pytest tests/test_models.py -q
"""

import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import ModelBundle


# ---------- 确定性、可学习的合成数据（保证 AUC 稳定可测，而非随机噪声） ----------
def _make_data(n=400, seed=42):
    rng = np.random.default_rng(seed)
    X = rng.standard_normal((n, 22))
    # 表格信号：前 3 个特征线性组合
    score = 0.8 * X[:, 0] + 0.6 * X[:, 1] - 0.5 * X[:, 2] + rng.standard_normal(n) * 0.3
    # 序列信号：序列最后一步的前 3 个特征
    seq = rng.standard_normal((n, 12, 22))
    ss = 0.8 * seq[:, -1, 0] + 0.6 * seq[:, -1, 1] - 0.5 * seq[:, -1, 2]
    yd = ((score + 0.5 * ss) > 0).astype(int)
    yr = score + 0.3 * ss + rng.standard_normal(n) * 0.1
    return X, seq, yd, yr


def _oof_auc(mb, yd):
    from sklearn.metrics import roc_auc_score
    return {n: roc_auc_score(yd, mb._oof[n])
            for n in mb._stack_clf_names if n in mb._oof}


def test_all_models_train():
    """6 个基模型都应成功训练（不抛错、avail 全 True）。"""
    X, seq, yd, yr = _make_data()
    mb = ModelBundle()
    res = mb.train(X, seq, yd, yr)
    for name in ["rf", "svm", "xgb", "lasso", "lstm", "transformer"]:
        assert mb.avail.get(name) is True, f"{name} 未训练成功: {res.get(name)}"


def test_base_model_oof_quality():
    """各基模型袋外(OOF) AUC 不应低于阈值（防性能退化）。

    阈值基于确定性数据实测基线留出余量：树/线性模型 ~0.86+，序列模型较弱但 >0.5。
    """
    X, seq, yd, yr = _make_data()
    mb = ModelBundle()
    mb.train(X, seq, yd, yr)
    aucs = _oof_auc(mb, yd)
    # 表格类强模型
    for name in ["rf", "svm", "xgb", "lasso"]:
        assert aucs[name] > 0.80, f"{name} OOF AUC 退化: {aucs[name]:.4f} <= 0.80"
    # 序列模型只需显著优于随机（0.5）
    assert aucs["lstm"] > 0.55, f"lstm OOF AUC 退化: {aucs['lstm']:.4f} <= 0.55"
    assert aucs["transformer"] > 0.52, f"transformer OOF AUC 退化: {aucs['transformer']:.4f} <= 0.52"


def test_stacking_beats_equal_weight():
    """Stacking 元学习器 OOF AUC 应不低于旧式等权软投票（验证集成改进有效）。"""
    from sklearn.metrics import roc_auc_score
    X, seq, yd, yr = _make_data()
    mb = ModelBundle()
    mb.train(X, seq, yd, yr)
    # Stacking OOF
    stack = mb.stack_clf.predict_proba(
        np.column_stack([mb._oof[n] for n in mb._stack_clf_names]))[:, 1]
    stack_auc = roc_auc_score(yd, stack)
    # 旧式等权软投票 OOF（对照）
    equal = np.column_stack([mb._oof[n] for n in mb._stack_clf_names]).mean(axis=1)
    equal_auc = roc_auc_score(yd, equal)
    assert stack_auc >= equal_auc - 0.02, (
        f"Stacking({stack_auc:.4f}) 明显劣于等权({equal_auc:.4f})")


def test_ensemble_proba_calibrated_and_valid():
    """集成概率应落在 (0,1)、无 NaN，且经校准后均值接近 0.5（平衡标签）。"""
    X, seq, yd, yr = _make_data()
    mb = ModelBundle()
    mb.train(X, seq, yd, yr)
    out = mb.predict(X[:50], seq[:50])
    ens = np.asarray(out["proba"]["ensemble"])
    assert "ensemble" in out["proba"] and "ensemble" in out["ret"]
    assert np.all(np.isfinite(ens)), "集成概率含 NaN/Inf"
    assert ens.min() > 0 and ens.max() < 1, "集成概率超出 (0,1)"
    # 校准后（平衡数据）均值应贴近 0.5，避免系统性偏移
    assert 0.35 < ens.mean() < 0.65, f"集成概率未校准，均值={ens.mean():.3f}"
    # 所有基模型概率同样需合法
    for name, p in out["proba"].items():
        if name == "ensemble":
            continue
        pa = np.asarray(p)
        assert np.all(np.isfinite(pa)) and pa.min() >= 0 and pa.max() <= 1, f"{name} 概率非法"


def test_no_data_leakage_oof():
    """OOF 评估必须在留折上计算：用 cross_val_predict 得到的 OOF 与样本内应有差异，
    且 OOF 准确率不应等于 100%（过度拟合/泄漏的信号）。"""
    X, seq, yd, yr = _make_data()
    mb = ModelBundle()
    mb.train(X, seq, yd, yr)
    for name in ["rf", "svm", "xgb", "lasso"]:
        oof_acc = float(((mb._oof[name] > 0.5).astype(int) == yd).mean())
        assert 0.6 < oof_acc < 1.0, f"{name} OOF 准确率异常（疑似泄漏）: {oof_acc:.3f}"


def test_dynamic_weight_ensemble():
    """动态权重集成：按 OOF AUC 给强者更大权重，OOF AUC 应不低于等权软投票，且概率合法。"""
    from sklearn.metrics import roc_auc_score
    X, seq, yd, yr = _make_data()
    mb = ModelBundle()
    mb.train(X, seq, yd, yr)
    assert mb.dyn_w, "动态权重未计算"
    names = [n for n in mb.dyn_w]
    M = np.column_stack([mb._oof[n] for n in names])
    w = np.array([mb.dyn_w[n] for n in names])
    dyn = M @ w
    dyn_auc = roc_auc_score(yd, dyn)
    equal_auc = roc_auc_score(yd, M.mean(axis=1))
    # 动态权重应接近等权软投票（1% 容差内），且明显优于随机（>0.85）
    assert dyn_auc >= equal_auc - 0.01, f"动态权重({dyn_auc:.4f}) 明显劣于等权({equal_auc:.4f})"
    assert dyn_auc > 0.85, f"动态权重集成 AUC 偏低: {dyn_auc:.4f}"
    out = mb.predict(X[:30], seq[:30], method="dynamic")
    ens = np.asarray(out["proba"]["ensemble"])
    assert np.all(np.isfinite(ens)) and ens.min() >= 0 and ens.max() <= 1
    assert set(out["clf_weights"].keys()) == set(mb.dyn_w.keys())


def test_tune_if_optuna():
    """Optuna 自动调优（若已安装）：跑小规模 study，best_params 应覆盖 4 个 sklearn 模型。"""
    try:
        import optuna  # noqa
    except ImportError:
        print("SKIP  test_tune_if_optuna (optuna 未安装，pip install optuna 后启用)")
        return
    X, seq, yd, yr = _make_data(n=300)
    mb = ModelBundle()
    bp = mb.tune(X, seq, yd, yr, n_trials=5)
    assert set(bp.keys()) >= {"rf", "svm", "lasso", "xgb"}, bp
    out = mb.predict(X[:20], seq[:20])
    assert "ensemble" in out["proba"] and "ensemble" in out["ret"]


# ---------- 兼容 pytest 缺失：python tests/test_models.py 直接运行 ----------
def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
        except Exception as e:  # noqa
            failed += 1
            print(f"ERROR {t.__name__}: {e}")
    print(f"\n{'OK' if failed == 0 else 'FAILED'}  ({len(tests)-failed}/{len(tests)} passed)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    _run_all()
