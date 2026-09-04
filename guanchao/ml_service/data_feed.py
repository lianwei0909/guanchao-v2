"""K 线数据获取（零额外依赖，仅用标准库 urllib）。
源：东方财富 push2his（返回 JSON，字段清晰，含成交额/换手）。
含：secid 推导、带重试的请求、本地磁盘缓存（避免重复请求触发限流）。
"""
import json
import os
import time
import urllib.request
import urllib.parse

CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "ml_cache")
CACHE_DIR = os.path.abspath(CACHE_DIR)
os.makedirs(CACHE_DIR, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

# klt 周期代码：101 日 / 102 周 / 103 月
KLT = {"day": "101", "week": "102", "month": "103"}

# 默认回测/预测使用的代表性流动性样本（蓝筹+宽基权重股，便于快速验证）
DEFAULT_UNIVERSE = [
    "600519", "601318", "600036", "000858", "000333",
    "300750", "002594", "600276", "601012", "600900",
    "000001", "600030", "601899", "603259", "600887",
]


def secid_of(code: str) -> str:
    """股票代码 -> 东财 secid（market.code）。1=沪 0=深。"""
    c = str(code).strip()
    if c.startswith(("60", "68", "90", "11", "13", "50", "51", "58")):
        return "1." + c          # 沪市
    return "0." + c              # 深市（00/30/02/03 等）


def _cache_path(secid: str, klt: str, lmt: int) -> str:
    return os.path.join(CACHE_DIR, f"{secid.replace('.', '_')}_{klt}_{lmt}.json")


def _market_prefix(code: str) -> str:
    """腾讯/新浪行情代码前缀：sh/sz/bj。"""
    c = str(code).strip()
    if c.startswith(("60", "68", "90", "11", "13", "50", "51", "58")):
        return "sh"
    if c.startswith(("8", "4", "92")):
        return "bj"
    return "sz"


def _from_tencent(secid: str, period: str, lmt: int):
    """腾讯 fqkline（web.ifzq.gtimg.cn），Python urllib 可直连，不受东财 WAF 限制。
    返回 [date, open, close, high, low, vol(手)] 行。用后复权(hfq)避免早期负价。"""
    fq = "hfq"
    fq_key = f"{fq}{period}"                  # hfqday / hfqweek / hfqmonth
    num = secid.split(".")[-1]
    sym = _market_prefix(num) + num          # 腾讯用 sh/sz/bj 前缀，非东财 secid
    url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
           f"?param={sym},{period},,,{lmt},{fq}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=12) as resp:
        obj = json.loads(resp.read().decode("utf-8"))
    # 腾讯返回结构：data.<sym>.<hfqday> 或 外层 <sym>.<hfqday>
    block = None
    for top in (obj.get("data"), obj):
        if isinstance(top, dict) and sym in top and isinstance(top[sym], dict):
            block = top[sym].get(fq_key) or top[sym].get("qfqday")
            if block:
                break
    if not block:
        return None
    out = []
    for row in block:
        if not isinstance(row, list) or len(row) < 6:
            continue
        out.append({
            "date": str(row[0]),
            "open": float(row[1]), "close": float(row[2]),
            "high": float(row[3]), "low": float(row[4]),
            "vol": float(row[5]),
            # 腾讯无成交额字段，按 1手=100股 估算（amount 仅用于金额动量比值，近似无损）
            "amount": float(row[2]) * float(row[5]) * 100,
        })
    return out


def _from_sina(secid: str, lmt: int):
    """新浪日K（仅日线），Python urllib 可直连，作腾讯的补充源。"""
    prefix = _market_prefix(secid.split(".")[-1])
    sym = prefix + secid.split(".")[-1]
    url = (f"https://money.finance.sina.com.cn/quotes_service/api/json_v2.php"
           f"/CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen={lmt}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=12) as resp:
        arr = json.loads(resp.read().decode("utf-8"))
    if not isinstance(arr, list) or not arr:
        return None
    out = []
    for x in arr:
        o, h, l, c, v = (float(x.get(k, 0)) for k in ("open", "high", "low", "close", "volume"))
        if c <= 0:
            continue
        out.append({
            "date": str(x.get("day")),
            "open": o, "close": c, "high": h, "low": l, "vol": v,
            "amount": c * v * 100,
        })
    return out


def _from_eastmoney(secid: str, klt: str, lmt: int):
    """东财 push2his（原数据源）。部分网络下被 WAF 掐断（RemoteDisconnected），
    作为最后的兜底源：先 HTTPS 后明文 HTTP。"""
    qs = urllib.parse.urlencode({
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        "klt": klt,
        "secid": secid,
        "beg": "0",
        "end": "20500101",
        "lmt": str(lmt),
        "fqt": "1",          # 前复权（与东财 App 一致，回测自洽）
        "_": str(int(time.time() * 1000)),
    })
    paths = ["https://push2his.eastmoney.com/api/qt/stock/kline/get?" + qs,
             "http://push2his.eastmoney.com/api/qt/stock/kline/get?" + qs]
    last_err = None
    for url in paths:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=12) as resp:
                obj = json.loads(resp.read().decode("utf-8"))
            klines = obj.get("data", {}).get("klines") or []
            out = []
            for row in klines:
                p = row.split(",")
                if len(p) < 11:
                    continue
                out.append({
                    "date": p[0],
                    "open": float(p[1]), "close": float(p[2]),
                    "high": float(p[3]), "low": float(p[4]),
                    "vol": float(p[5]), "amount": float(p[6]),
                    "amp": float(p[7]), "pct": float(p[8]),
                    "change": float(p[9]), "turnover": float(p[10]),
                })
            return out or None
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(f"eastmoney failed: {last_err}")


def fetch_kline(code: str, period: str = "day", lmt: int = 500,
                use_cache: bool = True, max_age: int = 3600) -> list:
    """拉取单只股票 K 线，返回按时间升序的 dict 列表：
    {date, open, close, high, low, vol, amount, pct, amp, turnover}
    date 格式 YYYY-MM-DD；价格为元；vol 为手；amount 为元。

    数据源优先级（多源容错，避免单点上游被限流/墙导致整批训练失败）：
      腾讯 fqkline（day/week/month）→ 新浪日K → 东财 push2his（兜底）。
    """
    secid = secid_of(code)
    klt = KLT.get(period, "101")
    cp = _cache_path(secid, klt, lmt)
    if use_cache and os.path.exists(cp):
        try:
            age = time.time() - os.path.getmtime(cp)
            if age < max_age:
                with open(cp, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception:
            pass

    raw = None
    last_err = None
    for fn in (_from_tencent, _from_sina if period == "day" else (lambda *a: None), _from_eastmoney):
        try:
            if fn is _from_eastmoney:
                r = fn(secid, klt, lmt)
            elif fn is _from_tencent:
                r = fn(secid, period, lmt)
            else:
                r = fn(secid, lmt)
            if r:
                raw = r
                break
        except Exception as e:
            last_err = str(e)
            time.sleep(0.3)

    if not raw:
        raise RuntimeError(f"fetch_kline failed for {code} ({secid}): {last_err or 'all sources empty'}")

    # 过滤非法价格行并裁剪到最近 lmt 根；补齐 features 需要但源未提供的字段
    out = [r for r in raw if r["open"] > 0 and r["close"] > 0 and r["low"] > 0]
    if lmt and len(out) > lmt:
        out = out[-lmt:]
    prev_close = None
    for r in out:
        r.setdefault("pct", round((r["close"] / prev_close - 1) * 100, 2) if prev_close else 0.0)
        r.setdefault("amp", round((r["high"] / r["close"] - 1) * 100, 2) if r["close"] else 0.0)
        r.setdefault("turnover", 0.0)
        prev_close = r["close"]
    if out:
        if use_cache:
            try:
                with open(cp, "w", encoding="utf-8") as f:
                    json.dump(out, f)
            except Exception:
                pass
        return out
    raise RuntimeError(f"fetch_kline empty for {code} ({secid})")


def fetch_universe(codes=None, period="day", lmt=500):
    codes = codes or DEFAULT_UNIVERSE
    res = {}
    for c in codes:
        try:
            res[c] = fetch_kline(c, period, lmt)
        except Exception as e:
            res[c] = {"error": str(e)}
    return res
