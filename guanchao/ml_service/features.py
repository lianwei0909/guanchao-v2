"""特征工程 + 标签构造（无前瞻泄漏）。
输入：data_feed.fetch_kline 返回的 K 线列表。
输出：X（截面特征矩阵）、序列张量（供 LSTM/Transformer）、涨跌方向标签、收益率标签、日期。

设计原则（与 Node 端 forecast 的 8 因子口径对齐，并补齐经典技术指标）：
  1. 特征在 t 收盘后算，标签用 t+1..t+H 的已实现收益，杜绝未来函数。
  2. 全部「越大越看多」方向统一，便于横截面与模型学习。
"""
import numpy as np

# 不同周期下的「持有窗口」对应前向天数（日K=交易日，周K=自然周，月K=自然月）
HORIZON_FWD = {
    "day":   {"ultra": 3,  "short": 5,  "mid": 20, "long": 60},
    "week":  {"ultra": 2,  "short": 3,  "mid": 8,  "long": 26},
    "month": {"ultra": 3,  "short": 6,  "mid": 12, "long": 24},
}


def ema(arr, n):
    arr = np.asarray(arr, dtype=float)
    if len(arr) < 2:
        return arr
    k = 2.0 / (n + 1)
    out = np.empty_like(arr)
    out[0] = arr[0]
    for i in range(1, len(arr)):
        out[i] = arr[i] * k + out[i - 1] * (1 - k)
    return out


def rsi(closes, n=14):
    closes = np.asarray(closes, dtype=float)
    if len(closes) < n + 2:
        return np.zeros(len(closes))
    diffs = np.diff(closes)
    out = np.zeros(len(closes))
    for i in range(n, len(closes)):
        w = diffs[i - n:i]
        up = np.sum(np.maximum(w, 0))
        dn = np.sum(np.maximum(-w, 0))
        rs = up / dn if dn > 0 else (np.inf if up > 0 else 0.0)
        out[i] = 100 - 100 / (1 + rs) if rs != np.inf else 100.0
    return out


def macd(closes, fast=12, slow=26, sig=9):
    closes = np.asarray(closes, dtype=float)
    ef, es = ema(closes, fast), ema(closes, slow)
    dif = ef - es
    dea = ema(dif, sig)
    hist = (dif - dea) * 2
    return dif, dea, hist


def build_dataset(klines, period="day", horizon="mid", feat_window=30):
    """构造监督学习样本。
    返回 dict：
      dates, X(2D, 每行一个 t 的特征), seq(3D: n x feat_window x n_feat),
      y_dir(0/1 涨跌), y_ret(前向收益率%), valid_mask
    """
    closes = np.array([k["close"] for k in klines], dtype=float)
    highs = np.array([k["high"] for k in klines], dtype=float)
    lows = np.array([k["low"] for k in klines], dtype=float)
    vols = np.array([k["vol"] for k in klines], dtype=float)
    amounts = np.array([k["amount"] for k in klines], dtype=float)
    dates = [k["date"] for k in klines]
    n = len(closes)
    H = HORIZON_FWD[period][horizon]

    # ---- 标签 ----
    fwd_ret = np.zeros(n)
    for t in range(n):
        if t + H < n:
            fwd_ret[t] = closes[t + H] / closes[t] - 1
    y_dir = (fwd_ret > 0).astype(int)
    y_ret = fwd_ret * 100.0

    # ---- 滚动特征 ----
    def ma(arr, w):
        out = np.full(len(arr), np.nan)
        for i in range(w - 1, len(arr)):
            out[i] = arr[i - w + 1:i + 1].mean()
        return out

    ma5, ma20, ma60 = ma(closes, 5), ma(closes, 20), ma(closes, 60)
    rets = np.zeros(n)
    rets[1:] = closes[1:] / closes[:-1] - 1
    dif, dea, hist = macd(closes)
    rsi14 = rsi(closes, 14)
    # 布林带
    mid = ma(closes, 20)
    sd = np.array([closes[max(0, i - 19):i + 1].std() for i in range(n)])
    up_b, dn_b = mid + 2 * sd, mid - 2 * sd
    bb_pos = np.where(up_b > dn_b, (closes - dn_b) / (up_b - dn_b + 1e-9), 0.5)
    # 成交量均线
    vma5 = ma(vols, 5)
    vma12 = ma(vols, 12)
    ama4 = ma(amounts, 4)
    ama12 = ma(amounts, 12)
    hi52 = np.array([np.max(highs[max(0, i - 51):i + 1]) for i in range(n)])
    lo20 = np.array([np.min(lows[max(0, i - 19):i + 1]) for i in range(n)])

    feats = np.full((n, 22), np.nan)
    for i in range(n):
        if np.isnan(ma20[i]) or np.isnan(ma60[i]) or i < 1:
            continue
        win = rets[max(0, i - 19):i + 1]
        row = [
            closes[i] / closes[i - 1] - 1 if i >= 1 else 0,        # ret_1
            closes[i] / closes[max(0, i - 5)] - 1,                  # ret_5
            closes[i] / closes[max(0, i - 20)] - 1,                 # ret_20
            np.std(win) if len(win) else 0,                        # vol_5
            np.std(rets[max(0, i - 19):i + 1]),                     # vol_20
            (ma5[i] / ma20[i] - 1) if not np.isnan(ma5[i]) else 0,  # ma5/ma20
            ma20[i] / ma60[i] - 1,                                 # ma20/ma60
            closes[i] / ma20[i] - 1,                               # trend_dev
            rsi14[i] / 100.0 - 0.5,                                # rsi(中心化)
            hist[i] / closes[i] if closes[i] else 0,               # macd hist 占比
            bb_pos[i] - 0.5,                                       # 布林位置
            (ama4[i] / ama12[i] - 1) if ama12[i] else 0,           # amount_trend
            (vols[i] / vma5[i] - 1) if vma5[i] else 0,             # volume_ratio
            closes[i] / closes[max(0, i - 13)] - 1,                # mom_12_1
            -(closes[i] / closes[max(0, i - 5)] - 1),              # rev_4
            -np.std(rets[max(0, i - 12):i + 1]),                   # low_vol_12
            closes[i] / hi52[i] - 1,                               # pos_52
            -np.mean(rets[max(0, i - 8):i + 1]),                   # low_amp_8
            closes[i] / lo20[i] - 1 if lo20[i] > 0 else 0,         # 距20低
            (closes[i] - ma20[i]) / (ma20[i] if ma20[i] else 1),   # 偏离MA20
            dif[i] - dea[i],                                      # DIF-DEA
            (highs[i] - lows[i]) / closes[i] if closes[i] else 0,  # 当日振幅
        ]
        feats[i] = row

    # 清洗：除零/缺失可能产生 inf/nan，统一置 0，避免污染模型数值
    feats = np.nan_to_num(feats, nan=0.0, posinf=0.0, neginf=0.0)

    # valid: 需要足够历史，且标签存在（t+H < n）
    valid = ~np.isnan(feats).any(axis=1) & (np.arange(n) + H < n) & (np.arange(n) >= 60)

    # 序列张量：每个样本取 [t-feat_window+1, t] 的特征窗口
    seq = np.full((n, feat_window, feats.shape[1]), np.nan)
    fpad = np.zeros(feats.shape[1])
    for i in range(n):
        # 最后一根K线即使没有标签（不参与训练）也要构造序列，供「当前信号」预测用
        if not valid[i] and i != n - 1:
            continue
        start = max(0, i - feat_window + 1)
        win = feats[start:i + 1]
        if len(win) < feat_window:
            pad = np.vstack([np.tile(fpad, (feat_window - len(win), 1)), win])
        else:
            pad = win
        # 用列均值填充任意 nan（稳健），并清除 inf
        col_mean = np.nanmean(pad, axis=0)
        pad = np.where(np.isnan(pad), np.nan_to_num(col_mean, 0), pad)
        pad = np.nan_to_num(pad, nan=0.0, posinf=0.0, neginf=0.0)
        seq[i] = pad

    return {
        "dates": dates, "X": feats, "seq": seq,
        "y_dir": y_dir, "y_ret": y_ret, "valid": valid, "H": H,
        "n_feat": feats.shape[1],
    }


def train_test_split_mask(ds, train_ratio=0.8):
    """按时间顺序切分（前 80% 训练，后 20% 测试），避免随机打乱造成泄漏。"""
    valid_idx = np.where(ds["valid"])[0]
    if len(valid_idx) < 10:
        return valid_idx, valid_idx
    k = int(len(valid_idx) * train_ratio)
    return valid_idx[:k], valid_idx[k:]
