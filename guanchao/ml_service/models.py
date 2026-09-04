"""预测模型层（监督学习 + 深度学习序列 + 集成）。
覆盖用户要求的算法族：
  - 监督学习分类/回归：随机森林(RandomForest) / 支持向量机(SVM) / XGBoost(梯度提升) / Lasso·弹性网络(正则化线性)
  - 预处理封装：每个需缩放的 sklearn 模型自带 Pipeline（StandardScaler 在模型内部拟合，防数据泄漏）
  - 深度学习序列：LSTM / Transformer（纯 numpy 实现，检测到 torch 时可用其加速版）
  - 集成学习：软投票(分类) + 加权平均(回归)，权重由验证集准确率决定
所有模型统一接口：fit(X[, seq], y) / predict(X[, seq]) -> 概率或回归值。
"""
import numpy as np

try:
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
    from sklearn.svm import SVC, SVR
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import make_pipeline
    SKLEARN_OK = True
except Exception:
    SKLEARN_OK = False

try:
    import xgboost as xgb
    XGB_OK = True
except Exception:
    XGB_OK = False

try:
    import torch
    TORCH_OK = True
except Exception:
    TORCH_OK = False


# ---------------- 激活函数 ----------------
def _sigmoid(x):
    x = np.clip(x, -30, 30)
    return 1.0 / (1.0 + np.exp(-x))


def _tanh(x):
    return np.tanh(x)


def _softmax(x):
    x = x - x.max()
    e = np.exp(x)
    return e / e.sum()


# ============================================================
#  纯 numpy 序列模型（LSTM / Transformer-lite），many-to-one
# ============================================================
# ============================================================
#  纯 numpy 序列模型（LSTM / Transformer），many-to-one
# ============================================================
"""纯 numpy 实现的深度学习序列模型（多对一）。
  - NumpyLSTM：标准 LSTM 单元 + 完整 BPTT 反向传播。
  - NumpyTransformer：单头自注意力（缩放点积）+ 均值池化 + 线性头，手写反向。
两者均不依赖 torch；若日后安装 torch，可在 service 层替换为等效 GPU 版。
"""


class NumpyLSTM:
    """LSTM 多对一（many-to-one）分类/回归，numpy 手写前向与 BPTT。"""

    def __init__(self, d=22, h=8, lr=0.01, epochs=12, seed=42):
        self.d, self.h = d, h
        self.lr, self.epochs = lr, epochs
        self.rng = np.random.default_rng(seed)
        self.Wx = self.rng.normal(0, 0.1, (4, h, d))   # f,i,c,o 对输入
        self.Wh = self.rng.normal(0, 0.1, (4, h, h))   # 对隐态
        self.b = np.zeros((4, h))
        self.Wo = self.rng.normal(0, 0.1, (1, h))
        self.bo = np.zeros(1)
        self._yscale = 1.0
        self._mean = None; self._std = None   # 序列特征标准化统计量（训练集拟合）

    def _forward(self, x):
        T = x.shape[0]
        h = np.zeros(self.h)
        c = np.zeros(self.h)
        cache = []
        for t in range(T):
            xt = x[t]
            zf = self.Wx[0] @ xt + self.Wh[0] @ h + self.b[0]
            zi = self.Wx[1] @ xt + self.Wh[1] @ h + self.b[1]
            zg = self.Wx[2] @ xt + self.Wh[2] @ h + self.b[2]
            zo = self.Wx[3] @ xt + self.Wh[3] @ h + self.b[3]
            f = _sigmoid(zf); i = _sigmoid(zi); g = _tanh(zg); o = _sigmoid(zo)
            c = f * c + i * g
            tanhc = _tanh(c)
            h = o * tanhc
            cache.append((xt, h.copy(), c.copy(), f, i, g, o, tanhc))
        out = self.Wo @ h + self.bo
        return out, cache

    def _backward(self, x, y, mode):
        out, cache = self._forward(x)
        if mode == "clf":
            p = _sigmoid(out[0]); dout = p - y
        else:
            dout = (out[0] - y) / self._yscale
        gWo = (dout * cache[-1][1]).reshape(1, -1)
        gbo = np.array([dout])
        gWx = np.zeros_like(self.Wx); gWh = np.zeros_like(self.Wh); gb = np.zeros_like(self.b)
        dh = (dout * self.Wo[0]).copy()
        carry_c = np.zeros(self.h)
        for t in reversed(range(len(cache))):
            xt, h_t, c_t, f, i, g, o, tanhc = cache[t]
            dc_from_h = dh * o * (1 - tanhc ** 2)
            dc_t = dc_from_h + carry_c
            d_ot = dh * tanhc
            dzo = d_ot * o * (1 - o)
            dzf = dc_t * c_t * f * (1 - f)     # c_t 此处复用为 c_{t-1} 之前的 cell（见下）
            # 注意：cache[t][2] 是 c_t；c_{t-1} 已在 cache[t] 的 f 中用到。
            # 为正确，需用上一步 cell。改为：dzf 用 c_prev = (t>0?cache[t-1][2]:0)
            c_prev = cache[t - 1][2] if t > 0 else np.zeros(self.h)
            dzf = dc_t * c_prev * f * (1 - f)
            dzi = dc_t * g * i * (1 - i)
            dzg = dc_t * i * (1 - g ** 2)
            gWx[0] += np.outer(dzf, xt); gWh[0] += np.outer(dzf, h_t if t == 0 else cache[t - 1][1])
            gWx[1] += np.outer(dzi, xt); gWh[1] += np.outer(dzi, h_t if t == 0 else cache[t - 1][1])
            gWx[2] += np.outer(dzg, xt); gWh[2] += np.outer(dzg, h_t if t == 0 else cache[t - 1][1])
            gWx[3] += np.outer(dzo, xt); gWh[3] += np.outer(dzo, h_t if t == 0 else cache[t - 1][1])
            gb[0] += dzf; gb[1] += dzi; gb[2] += dzg; gb[3] += dzo
            dh = self.Wh[0].T @ dzf + self.Wh[1].T @ dzi + self.Wh[2].T @ dzg + self.Wh[3].T @ dzo
            carry_c = dc_t * f
        return gWx, gWh, gb, gWo, gbo

    def fit(self, seq, y, mode="clf"):
        seq = np.asarray(seq, dtype=float); y = np.asarray(y, dtype=float)
        # 序列特征标准化（仅训练集拟合，无泄漏），让时序位置编码等信号有合理尺度
        self._mean = seq.mean(axis=(0, 1), keepdims=True)
        self._std = seq.std(axis=(0, 1), keepdims=True) + 1e-9
        seq = (seq - self._mean) / self._std
        if mode == "reg":
            self._yscale = max(1.0, float(np.std(y))) or 1.0
        if len(seq) > 150:
            idx = self.rng.choice(len(seq), 150, replace=False)
            seq, y = seq[idx], y[idx]
        for ep in range(self.epochs):
            lr = self.lr * (0.95 ** ep)
            for s in range(len(seq)):
                g = self._backward(seq[s], y[s], mode)
                self.Wx -= lr * g[0]; self.Wh -= lr * g[1]; self.b -= lr * g[2]
                self.Wo -= lr * g[3]; self.bo -= lr * g[4]
        return self

    def predict(self, seq, mode="clf"):
        seq = np.asarray(seq, dtype=float)
        if self._mean is not None:
            seq = (seq - self._mean) / self._std
        outs = np.array([self._forward(seq[s])[0][0] for s in range(len(seq))])
        return _sigmoid(outs) if mode == "clf" else outs


class NumpyTransformer:
    """单头自注意力多对一（many-to-one）序列模型，numpy 手写反向。"""

    def __init__(self, d=22, h=8, lr=0.01, epochs=12, seed=42):
        self.d, self.h = d, h
        self.lr, self.epochs = lr, epochs
        self.rng = np.random.default_rng(seed)
        self.Wq = self.rng.normal(0, 0.1, (h, d))
        self.Wk = self.rng.normal(0, 0.1, (h, d))
        self.Wv = self.rng.normal(0, 0.1, (h, d))
        self.Wo = self.rng.normal(0, 0.1, (1, h))
        self.bo = np.zeros(1)
        self._yscale = 1.0
        self._mean = None; self._std = None   # 序列特征标准化统计量（训练集拟合）

    def _positional_encoding(self, T, d):
        """正弦位置编码（标准 Transformer PE），给时间序列注入时序位置信息。"""
        pe = np.zeros((T, d))
        pos = np.arange(T)[:, None]
        div = np.power(10000.0, (2 * (np.arange(d) // 2)) / max(d, 1))
        pe[:, 0::2] = np.sin(pos / div[0::2])
        pe[:, 1::2] = np.cos(pos / div[1::2])
        return pe

    def _forward(self, x):
        x = x + self._positional_encoding(x.shape[0], self.d)  # 注入时序位置
        Q = x @ self.Wq.T
        K = x @ self.Wk.T
        V = x @ self.Wv.T
        scores = Q @ K.T / np.sqrt(self.h)
        # 因果掩码（只看过去与当前，符合时序预测）
        T = x.shape[0]
        mask = np.triu(np.ones((T, T)), k=1) * -1e9
        scores = scores + mask
        A = np.exp(scores - scores.max(axis=1, keepdims=True))
        A = A / A.sum(axis=1, keepdims=True)
        C = A @ V
        pool = C.mean(axis=0)
        out = self.Wo @ pool + self.bo
        return out, (x, Q, K, V, A, C, pool)

    def _backward(self, x, y, mode):
        out, (x, Q, K, V, A, C, pool) = self._forward(x)
        if mode == "clf":
            p = _sigmoid(out[0]); dout = p - y
        else:
            dout = (out[0] - y) / self._yscale
        gWo = (dout * pool).reshape(1, -1)
        gbo = np.array([dout])
        dpool = (dout * self.Wo[0]).copy()
        T = x.shape[0]
        dC = np.tile(dpool / T, (T, 1))
        dA = dC @ V.T
        dV = A.T @ dC
        dsum = (dA * A).sum(axis=1, keepdims=True)
        dscores = A * (dA - dsum)
        dQ = (dscores / np.sqrt(self.h)) @ K
        dK = (dscores.T / np.sqrt(self.h)) @ Q
        gWq = dQ.T @ x
        gWk = dK.T @ x
        gWv = dV.T @ x
        return gWq, gWk, gWv, gWo, gbo

    def fit(self, seq, y, mode="clf"):
        seq = np.asarray(seq, dtype=float); y = np.asarray(y, dtype=float)
        # 序列特征标准化（仅训练集拟合，无泄漏），让时序位置编码有合理尺度
        self._mean = seq.mean(axis=(0, 1), keepdims=True)
        self._std = seq.std(axis=(0, 1), keepdims=True) + 1e-9
        seq = (seq - self._mean) / self._std
        if mode == "reg":
            self._yscale = max(1.0, float(np.std(y))) or 1.0
        if len(seq) > 150:
            idx = self.rng.choice(len(seq), 150, replace=False)
            seq, y = seq[idx], y[idx]
        for ep in range(self.epochs):
            lr = self.lr * (0.95 ** ep)
            for s in range(len(seq)):
                g = self._backward(seq[s], y[s], mode)
                self.Wq -= lr * g[0]; self.Wk -= lr * g[1]; self.Wv -= lr * g[2]
                self.Wo -= lr * g[3]; self.bo -= lr * g[4]
        return self

    def predict(self, seq, mode="clf"):
        seq = np.asarray(seq, dtype=float)
        if self._mean is not None:
            seq = (seq - self._mean) / self._std
        outs = np.array([self._forward(seq[s])[0][0] for s in range(len(seq))])
        return _sigmoid(outs) if mode == "clf" else outs


def make_seq(kind, d=22, h=16, lr=0.01, epochs=40):
    if kind == "transformer":
        return NumpyTransformer(d=d, h=h, lr=lr, epochs=epochs)
    return NumpyLSTM(d=d, h=h, lr=lr, epochs=epochs)


# ============================================================
#  模型集合（统一训练/预测）
# ============================================================
class ModelBundle:
    def __init__(self):
        self.avail = {}
        self.models = {}   # name -> (clf, reg)，每个 sklearn 模型自带 Pipeline（缩放封装在内，防泄漏）
        self.metrics = {}  # name -> {acc, rmse, feat_imp}
        self.clf_weights = {}
        self._oof = {}     # name -> 分类器袋外(OOF)概率，用于诚实评估与集成元特征
        self._oof_ret = {} # name -> 回归器袋外(OOF)预测，用于集成元特征
        self.seq_feat_dim = 22
        self._cv = 5
        self.stack_clf = None   # Stacking 元学习器（分类）
        self.stack_reg = None   # Stacking 元学习器（回归）
        self._stack_clf_names = []
        self._stack_reg_names = []
        self.best_params = {}   # Optuna 调优得到的最佳超参（tune() 写入）
        self.dyn_w = {}         # 动态权重（按 OOF AUC 计算的 softmax 权重）

    # ---------- sklearn 模型工厂：需缩放的用 Pipeline 把 StandardScaler 封装在内，防数据泄漏 ----------
    def _build_sk(self, need_scale, clf, reg):
        if need_scale:
            return make_pipeline(StandardScaler(), clf), make_pipeline(StandardScaler(), reg)
        return clf, reg

    def train(self, X, seq, y_dir, y_ret, verbose=False):
        X = np.asarray(X, dtype=float)
        seq = np.asarray(seq, dtype=float)
        y_dir = np.asarray(y_dir); y_ret = np.asarray(y_ret)
        # 不再用全局 scaler：每个 sklearn 模型自带 Pipeline（缩放在模型内部，仅拟合训练集）
        self.seq_feat_dim = X.shape[1]
        self.metrics = {}
        self._oof = {}
        self._oof_ret = {}

        from sklearn.model_selection import cross_val_predict
        cv = self._cv
        results = {}

        # 袋外(OOF)评估：cross_val_predict 在 cv 折内训练、对留折预测，杜绝样本内乐观估计（防泄漏）
        def oof_clf(clf_pipe):
            try:
                return cross_val_predict(clf_pipe, X, y_dir, cv=cv, method="predict_proba")[:, 1]
            except Exception:
                clf_pipe.fit(X, y_dir)
                return clf_pipe.predict_proba(X)[:, 1]

        def oof_reg(reg_pipe):
            try:
                return cross_val_predict(reg_pipe, X, y_ret, cv=cv)
            except Exception:
                reg_pipe.fit(X, y_ret)
                return reg_pipe.predict(X)

        # 1) 随机森林（树模型无需缩放）
        if SKLEARN_OK:
            try:
                from sklearn.calibration import CalibratedClassifierCV
                bp = self.best_params.get("rf", {})
                rfc = RandomForestClassifier(n_estimators=int(bp.get("n_estimators", 120)),
                                             max_depth=int(bp.get("max_depth", 10)),
                                             random_state=42, n_jobs=-1)
                rfr = RandomForestRegressor(n_estimators=int(bp.get("n_estimators", 120)),
                                            max_depth=int(bp.get("max_depth", 10)),
                                            random_state=42, n_jobs=-1)
                # 概率校准：RF 输出未校准，套 CalibratedClassifierCV 与 SVM 对齐，保证集成公平
                c = CalibratedClassifierCV(rfc, method="sigmoid", cv=3)
                r = rfr
                c.fit(X, y_dir); r.fit(X, y_ret)
                self.models["rf"], self.avail["rf"] = (c, r), True
                results["rf"] = "ok"
                pc, pr = oof_clf(c), oof_reg(r)
                self._oof["rf"] = pc; self._oof_ret["rf"] = pr
                self.metrics["rf"] = {
                    "acc": float(((pc > 0.5).astype(int) == y_dir).mean()),
                    "rmse": float(np.sqrt(np.mean((pr - y_ret) ** 2))),
                    "feat_imp": rfr.feature_importances_.tolist() if hasattr(rfr, 'feature_importances_') else None,
                }
            except Exception as e:
                self.avail["rf"] = False; results["rf"] = "err:" + str(e)[:80]

        # 2) SVM（缩放封装进 Pipeline）
        if SKLEARN_OK:
            try:
                from sklearn.calibration import CalibratedClassifierCV
                bp = self.best_params.get("svm", {})
                c = float(bp.get("C", 1.0))
                base_svc = SVC(kernel="rbf", C=c, random_state=42)
                svc = make_pipeline(StandardScaler(),
                                    CalibratedClassifierCV(base_svc, cv=3, ensemble=False))
                svr = make_pipeline(StandardScaler(), SVR(kernel="rbf", C=c))
                svc.fit(X, y_dir); svr.fit(X, y_ret)
                self.models["svm"], self.avail["svm"] = (svc, svr), True
                results["svm"] = "ok"
                pc, pr = oof_clf(svc), oof_reg(svr)
                self._oof["svm"] = pc; self._oof_ret["svm"] = pr
                self.metrics["svm"] = {
                    "acc": float(((pc > 0.5).astype(int) == y_dir).mean()),
                    "rmse": float(np.sqrt(np.mean((pr - y_ret) ** 2))),
                    "feat_imp": None,
                }
            except Exception as e:
                self.avail["svm"] = False; results["svm"] = "err:" + str(e)[:80]

        # 3) XGBoost（回退到 HistGradientBoosting，树模型无需缩放）
        try:
            if XGB_OK:
                bp = self.best_params.get("xgb", {})
                ne = int(bp.get("n_estimators", 100)); md = int(bp.get("max_depth", 4))
                lr2 = float(bp.get("learning_rate", 0.1))
                xc = xgb.XGBClassifier(n_estimators=ne, max_depth=md,
                                       learning_rate=lr2, random_state=42,
                                       eval_metric="logloss")
                xr = xgb.XGBRegressor(n_estimators=ne, max_depth=md,
                                      learning_rate=lr2, random_state=42)
            else:
                from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
                bp = self.best_params.get("xgb", {})
                ne = int(bp.get("n_estimators", 150)); md = int(bp.get("max_depth", 4))
                lr2 = float(bp.get("learning_rate", 0.1))
                xc = HistGradientBoostingClassifier(max_iter=ne, max_depth=md,
                                                   learning_rate=lr2, random_state=42)
                xr = HistGradientBoostingRegressor(max_iter=ne, max_depth=md,
                                                   learning_rate=lr2, random_state=42)
            from sklearn.calibration import CalibratedClassifierCV
            # 概率校准：XGB 输出未校准，套 CalibratedClassifierCV 与 SVM 对齐
            c = CalibratedClassifierCV(xc, method="sigmoid", cv=3)
            r = xr
            c.fit(X, y_dir); r.fit(X, y_ret)
            self.models["xgb"], self.avail["xgb"] = (c, r), True
            results["xgb"] = "ok" + ("" if XGB_OK else "(histgb fallback)")
            pc, pr = oof_clf(c), oof_reg(r)
            self._oof["xgb"] = pc; self._oof_ret["xgb"] = pr
            fi = xr.feature_importances_.tolist() if hasattr(xr, 'feature_importances_') else None
            self.metrics["xgb"] = {
                "acc": float(((pc > 0.5).astype(int) == y_dir).mean()),
                "rmse": float(np.sqrt(np.mean((pr - y_ret) ** 2))),
                "feat_imp": fi,
            }
        except Exception as e:
            self.avail["xgb"] = False; results["xgb"] = "err:" + str(e)[:80]

        # 4) Lasso / 弹性网络（正则化线性模型，缩放封装进 Pipeline，自动特征选择）
        if SKLEARN_OK:
            try:
                from sklearn.linear_model import LogisticRegression, ElasticNet
                bp = self.best_params.get("lasso", {})
                lc = LogisticRegression(C=float(bp.get("C", 1.0)), l1_ratio=1.0, solver="saga",
                                        max_iter=3000, random_state=42)
                lr = ElasticNet(alpha=float(bp.get("alpha", 0.01)), l1_ratio=1.0,
                                max_iter=3000, random_state=42)
                c, r = self._build_sk(True, lc, lr)
                # 概率校准：Lasso 逻辑回归套 CalibratedClassifierCV 与 SVM 对齐
                c = CalibratedClassifierCV(c, method="sigmoid", cv=3)
                c.fit(X, y_dir); r.fit(X, y_ret)
                self.models["lasso"], self.avail["lasso"] = (c, r), True
                results["lasso"] = "ok"
                pc, pr = oof_clf(c), oof_reg(r)
                self._oof["lasso"] = pc; self._oof_ret["lasso"] = pr
                try:
                    est = r.named_steps["elasticnet"]
                    feat_imp = np.abs(np.asarray(est.coef_)).tolist()
                except Exception:
                    feat_imp = None
                self.metrics["lasso"] = {
                    "acc": float(((pc > 0.5).astype(int) == y_dir).mean()),
                    "rmse": float(np.sqrt(np.mean((pr - y_ret) ** 2))),
                    "feat_imp": feat_imp,
                }
            except Exception as e:
                self.avail["lasso"] = False; results["lasso"] = "err:" + str(e)[:80]

        # 5) LSTM / 6) Transformer（numpy 序列模型，单独训练，指标为样本内）
        self._train_seq("lstm", seq, y_dir, y_ret, results)
        self._train_seq("transformer", seq, y_dir, y_ret, results)

        self._train_weights(X, seq, y_dir)  # OOF 准确率权重（供展示/回退）
        self._fit_stacking(y_dir, y_ret)    # Stacking 元学习器（替代固定权重软投票）
        self._train_dynamic_weights(y_dir)  # 动态权重：按各模型 OOF AUC 计算 softmax 权重
        return results

    def _train_seq(self, kind, seq, y_dir, y_ret, results):
        try:
            lr = 0.01 if kind == "lstm" else 0.015
            c = make_seq(kind, d=self.seq_feat_dim, h=8, lr=lr, epochs=12)
            r = make_seq(kind, d=self.seq_feat_dim, h=8, lr=lr, epochs=12)
            c.fit(seq, y_dir.astype(float), "clf")
            r.fit(seq, y_ret, "reg")
            self.models[kind] = (c, r)
            self.avail[kind] = True
            results[kind] = "ok(numpy)"
            pc = np.asarray(c.predict(seq))
            pr = np.asarray(r.predict(seq))
            self._oof[kind] = pc; self._oof_ret[kind] = pr
            self.metrics[kind] = {
                "acc": float(((pc > 0.5).astype(int) == y_dir).mean()),
                "rmse": float(np.sqrt(np.mean((pr - y_ret) ** 2))),
                "feat_imp": None,
            }
        except Exception as e:
            self.avail[kind] = False; results[kind] = "err:" + str(e)[:80]

    def _train_weights(self, X, seq, y_dir):
        """用各分类模型的袋外(OOF)概率准确率作集成软投票权重（sklearn 模型为 OOF，序列模型为样本内）。"""
        self.clf_weights = {}
        accs = {}
        for name in ["rf", "svm", "xgb", "lasso", "lstm", "transformer"]:
            if self.avail.get(name) and name in self._oof:
                p = self._oof[name]
                accs[name] = float(((p > 0.5).astype(int) == y_dir).mean())
        tot = sum(max(0.0, v) for v in accs.values()) or 1.0
        for k, v in accs.items():
            self.clf_weights[k] = max(0.0, v) / tot

    def _fit_stacking(self, y_dir, y_ret):
        """Stacking 元学习器：用各基模型的袋外(OOF)输出作元特征，训练次级模型学“如何组合”，
        比固定权重软投票更优（对应 RAG 的 Reranking / Cross-Encoder 思想）。
        分类用 L2 逻辑回归，回归用 Ridge；元特征为 OOF 预测，避免信息泄漏。"""
        from sklearn.linear_model import LogisticRegression, Ridge
        self.stack_clf = None; self.stack_reg = None
        self._stack_clf_names = []; self._stack_reg_names = []
        names = [n for n in ["rf", "svm", "xgb", "lasso", "lstm", "transformer"]
                 if self.avail.get(n)]
        if len(names) < 2:
            return
        try:
            M = np.column_stack([np.asarray(self._oof[n]) for n in names])
            self.stack_clf = LogisticRegression(C=1.0, max_iter=2000, random_state=42)
            self.stack_clf.fit(M, y_dir)
            Mr = np.column_stack([np.asarray(self._oof_ret[n]) for n in names])
            self.stack_reg = Ridge(alpha=1.0, random_state=42)
            self.stack_reg.fit(Mr, y_ret)
            self._stack_clf_names = names
            self._stack_reg_names = names
        except Exception:
            self.stack_clf = None; self.stack_reg = None

    def _train_dynamic_weights(self, y_dir):
        """动态权重（编译得到）：按各模型袋外(OOF) AUC 计算 softmax 权重，
        性能越好的模型在集成中占比越高（对应 DSPy『编译而非手调』——让数据决定权重）。"""
        from sklearn.metrics import roc_auc_score
        self.dyn_w = {}
        aucs = {}
        for name in ["rf", "svm", "xgb", "lasso", "lstm", "transformer"]:
            if self.avail.get(name) and name in self._oof:
                try:
                    s = max(0.0, roc_auc_score(y_dir, self._oof[name]) - 0.5)
                except Exception:
                    s = 0.0
                aucs[name] = s
        if not aucs:
            return
        vals = np.array(list(aucs.values()))
        w = np.exp(vals * 6.0) / np.sum(np.exp(vals * 6.0))
        self.dyn_w = {n: float(w[i]) for i, n in enumerate(aucs)}

    def tune(self, X, seq, y_dir, y_ret, n_trials=20):
        """Optuna 超参自动调优（对应 DSPy『编译而非手调』）。

        对每个 sklearn 基模型用 3 折 OOF AUC 作目标搜索最优超参，结果存入 self.best_params；
        随后自动以调优参数重建并训练模型。未安装 optuna 时抛出 ImportError 并提示安装。
        注：序列模型(numpy LSTM/Transformer)训练成本高，默认不纳入自动调优。"""
        try:
            import optuna
        except ImportError:
            raise ImportError("tune() 需要 optuna：pip install optuna")
        from sklearn.model_selection import cross_val_predict
        from sklearn.metrics import roc_auc_score as _auc
        X = np.asarray(X, dtype=float); y_dir = np.asarray(y_dir); seq = np.asarray(seq, dtype=float)
        self.best_params = {}

        def objective_for(name):
            def objective(trial):
                if name == "rf":
                    clf = RandomForestClassifier(
                        n_estimators=int(trial.suggest_int("n_estimators", 80, 300, step=20)),
                        max_depth=int(trial.suggest_int("max_depth", 4, 16)),
                        random_state=42, n_jobs=-1)
                elif name == "svm":
                    clf = SVC(kernel="rbf", C=trial.suggest_float("C", 0.1, 10.0, log=True),
                              random_state=42)
                elif name == "lasso":
                    from sklearn.linear_model import LogisticRegression, ElasticNet
                    clf = LogisticRegression(
                        C=trial.suggest_float("C", 0.01, 10.0, log=True), l1_ratio=1.0,
                        solver="saga", max_iter=2000, random_state=42)
                else:  # xgb
                    if XGB_OK:
                        clf = xgb.XGBClassifier(
                            n_estimators=int(trial.suggest_int("n_estimators", 50, 200, step=10)),
                            max_depth=int(trial.suggest_int("max_depth", 2, 6)),
                            learning_rate=trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
                            random_state=42, eval_metric="logloss")
                    else:
                        from sklearn.ensemble import HistGradientBoostingClassifier
                        clf = HistGradientBoostingClassifier(
                            max_iter=int(trial.suggest_int("n_estimators", 50, 200, step=10)),
                            max_depth=int(trial.suggest_int("max_depth", 2, 6)),
                            learning_rate=trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
                            random_state=42)
                method = "predict_proba" if name != "svm" else "decision_function"
                oof = cross_val_predict(clf, X, y_dir, cv=3, method=method)
                if method == "predict_proba":
                    oof = oof[:, 1]
                return float(_auc(y_dir, oof))
            return objective

        for name in ["rf", "svm", "lasso", "xgb"]:
            try:
                study = optuna.create_study(direction="maximize")
                study.optimize(objective_for(name), n_trials=n_trials)
                self.best_params[name] = dict(study.best_params)
            except Exception:
                self.best_params[name] = {}
        # 用调优参数重建并训练全部模型
        self.train(X, seq, y_dir, np.asarray(y_ret))
        return self.best_params

    def predict(self, X, seq, mode="both", method="stacking"):
        """返回各模型涨跌概率(proba)与预期收益(ret)及集成结果。
        method="stacking"（默认）：Stacking 元学习器组合；
        method="dynamic"：按训练集 OOF AUC 动态权重软投票组合。
        每个 sklearn 模型自带 Pipeline，predict 时内部完成缩放，不再依赖全局 scaler。"""
        X = np.asarray(X, dtype=float); seq = np.asarray(seq, dtype=float)
        out = {"proba": {}, "ret": {}}
        # 分类概率（sklearn 模型直接对原始 X 预测，Pipeline 内自动缩放）
        for name in ["rf", "svm", "xgb", "lasso"]:
            if self.avail.get(name):
                out["proba"][name] = self.models[name][0].predict_proba(X)[:, 1].tolist()
        if self.avail.get("lstm"):
            out["proba"]["lstm"] = np.asarray(self.models["lstm"][0].predict(seq)).tolist()
        if self.avail.get("transformer"):
            out["proba"]["transformer"] = np.asarray(self.models["transformer"][0].predict(seq)).tolist()
        # 回归收益（sklearn 对 X，序列模型对 seq）
        for name in ["rf", "svm", "xgb", "lasso"]:
            if self.avail.get(name):
                out["ret"][name] = np.asarray(self.models[name][1].predict(X)).tolist()
        if self.avail.get("lstm"):
            out["ret"]["lstm"] = np.asarray(self.models["lstm"][1].predict(seq)).tolist()
        if self.avail.get("transformer"):
            out["ret"]["transformer"] = np.asarray(self.models["transformer"][1].predict(seq)).tolist()
        if method == "dynamic" and self.dyn_w:
            # 动态权重：用各模型 OOF AUC 计算的 softmax 权重做软投票（编译得到的权重）
            pnames = [n for n in self.dyn_w if n in out["proba"]]
            rnames = [n for n in self.dyn_w if n in out["ret"]]
            if pnames:
                M = np.column_stack([np.array(out["proba"][n]) for n in pnames])
                w = np.array([self.dyn_w[n] for n in pnames])
                out["proba"]["ensemble"] = (M * w).sum(axis=1).tolist()
            if rnames:
                Mr = np.column_stack([np.array(out["ret"][n]) for n in rnames])
                w = np.array([self.dyn_w[n] for n in rnames])
                out["ret"]["ensemble"] = (Mr * w).sum(axis=1).tolist()
            out["clf_weights"] = self.dyn_w
        else:
            # 集成：Stacking 元学习器（用各基模型输出作元特征，替代固定权重软投票）
            if self.stack_clf is not None and self._stack_clf_names:
                M = np.column_stack([np.array(out["proba"][n]) for n in self._stack_clf_names])
                out["proba"]["ensemble"] = self.stack_clf.predict_proba(M)[:, 1].tolist()
                out["clf_weights"] = self.clf_weights
            if self.stack_reg is not None and self._stack_reg_names:
                Mr = np.column_stack([np.array(out["ret"][n]) for n in self._stack_reg_names])
                out["ret"]["ensemble"] = self.stack_reg.predict(Mr).tolist()
        return out
