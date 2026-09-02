"""数据层：A 股股票池与 K 线获取。

数据源选型（实测 2026-08）：
  - 股票池列表：东方财富 clist，**必须走 push2delay 域名**，push2 主域会按 IP 封禁
  - K 线：腾讯 web.ifzq.gtimg.cn，支持 day / week / month + 前复权(qfq)

两个关键坑（改代码前务必记住）：
  1. 腾讯 K 线数组顺序是 [日期, 开, 收, 高, 低, 量] —— 收盘价在第 3 位，不是第 2 位
  2. 东财 clist 的 pz 硬上限是 100，传 6000 也只回 100 条，全市场必须翻页

所有请求带 3 次指数退避重试，K 线结果落本地 CSV 缓存，避免重复请求被限流。
"""
from __future__ import annotations

import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd
import requests

from config import CACHE_DIR

EM_CLIST = "https://push2delay.eastmoney.com/api/qt/clist/get"
TX_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"

# 沪深 A 股（主板 + 创业板 + 科创板），排除北交所与三板
EM_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Referer": "https://gu.qq.com/",
}

# 名称里出现这些字样的股票直接剔除（ST / 退市 / 次新未定价）
_BAD_NAME = re.compile(r"ST|退|\*|N\s|C\s")


def _get_json(url: str, params: dict, retries: int = 3, timeout: int = 20):
    """带指数退避的 GET，上游偶发 socket 重置，单次失败多为瞬时抖动。"""
    last: Optional[Exception] = None
    for i in range(retries):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001 - 网络层异常统一兜底
            last = exc
            time.sleep(0.25 * (2 ** i) + random.random() * 0.1)
    raise RuntimeError(f"请求失败 {url} params={params}: {last}")


def canonical_index(index: pd.DatetimeIndex, period: str) -> pd.DatetimeIndex:
    """把 K 线日期规范化到统一的周/月标签。

    不同股票的周线日期天然对不齐：停牌会缺一周，节假日会让周K落在不同日期，
    当前未走完的一周尤其混乱。直接拼面板会取所有日期的并集，
    结果每只股票都被插入大量空洞，任何超过 20 期的滚动因子几乎全成 NaN
    （实测 52 期因子只剩 6 行有效）。

    这里统一映射到"该周/该月最后一天"，让所有股票共享同一套时间标签。
    """
    if period == "month":
        return index.to_period("M").to_timestamp(how="end").normalize()
    if period == "week":
        return index.to_period("W").to_timestamp(how="end").normalize()
    return index


def tx_symbol(code: str, is_index: bool = False) -> str:
    """6 位代码 -> 腾讯 symbol（sh / sz 前缀）。

    **000xxx 号段是双重占用的，不可能靠前缀区分**——这是本函数最大的坑：
      - sz000001 = 平安银行（深市主板股票）
      - sh000001 = 上证指数
      - sz000938 = 紫光股份（约 25 元）
      - sh000938 = 某个中证指数（约 2300 点）
    早期版本按前缀把 000xxx 一律判为指数，结果所有深市主板股票取回的
    都是指数数据，价格差百倍，且**全程不报错**——面板照样拼得出来，
    IC 照样算得出数，只是结论全是假的。所以指数必须显式声明。

    Args:
        code: 6 位代码。
        is_index: True 表示这是指数代码，False 表示个股。

    指数：000xxx（上证/中证系列）走 sh，399xxx（深证系列）走 sz。
    个股：6/9/5 开头与 11 开头走 sh（沪市主板/科创板/B股/基金），
          其余（000/001/002/003/300/301 等）走 sz。
    """
    if is_index:
        return ("sz" if code.startswith("399") else "sh") + code
    if code[0] in "569" or code[:2] == "11":
        return "sh" + code
    return "sz" + code


def fetch_universe(pages: int = 3) -> pd.DataFrame:
    """按成交额降序取 A 股股票池。

    Args:
        pages: 翻页数，每页最多 100 条。3 页 = 成交额前 300 只。

    Returns:
        DataFrame，列：code / name / industry / amount（成交额，元）/
        last_price（最新价，用于跨源校验 K 线是否取对了标的）。
    """
    rows: List[dict] = []
    for pn in range(1, pages + 1):
        payload = _get_json(
            EM_CLIST,
            {
                "pn": pn,
                "pz": 100,
                "po": 1,          # 降序
                "np": 1,
                "fltt": 2,        # 返回数值而非字符串
                "invt": 2,
                "fid": "f6",      # 按成交额排序
                "fs": EM_FS,
                # f2 = 最新价，用来和腾讯 K 线的末收交叉验证
                "fields": "f12,f13,f14,f100,f6,f2",
            },
        )
        diff = ((payload or {}).get("data") or {}).get("diff") or []
        # 新版接口 diff 可能是 dict（按序号索引）而非 list
        items = diff.values() if isinstance(diff, dict) else diff
        for it in items:
            if not isinstance(it, dict):
                continue
            code = str(it.get("f12") or "").strip()
            name = str(it.get("f14") or "").strip()
            if not re.fullmatch(r"\d{6}", code):
                continue
            if _BAD_NAME.search(name):
                continue
            rows.append(
                {
                    "code": code,
                    "name": name,
                    "industry": str(it.get("f100") or "UNK").strip() or "UNK",
                    "amount": pd.to_numeric(it.get("f6"), errors="coerce"),
                    "last_price": pd.to_numeric(it.get("f2"), errors="coerce"),
                }
            )

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = df.dropna(subset=["amount"]).drop_duplicates("code")
    return df.sort_values("amount", ascending=False).reset_index(drop=True)


def fetch_kline(
    code: str,
    period: str = "week",
    bars: int = 400,
    use_cache: bool = True,
    is_index: bool = False,
) -> Optional[pd.DataFrame]:
    """拉单只标的的前复权 K 线。

    Args:
        code: 6 位代码。
        period: day / week / month（腾讯不支持分钟级，分钟需换新浪）。
        bars: 拉取根数。实测腾讯周线上限约 800 根（≈2011 年至今），
              再往上会被静默截断成 641 根（≈2014 年），不要传更大的值。
        use_cache: 命中本地缓存则直接读取。
        is_index: True 表示拉的是指数。000xxx 号段个股与指数重号，必须显式指定。

    Returns:
        DataFrame，index=date(datetime)，列 open / close / high / low / volume；
        失败或返回空则 None。
    """
    sym = tx_symbol(code, is_index=is_index)
    # v3：修复了 000xxx 个股/指数混淆的 bug，旧缓存里的深市主板股票数据是错的，
    # 必须强制失效重拉。指数与个股用不同文件名，避免 000001 这类重号互相覆盖。
    suffix = "idx" if is_index else "stk"
    cache_path = CACHE_DIR / f"{code}_{period}_{bars}_v3_{suffix}.csv"
    if use_cache and cache_path.exists():
        try:
            cached = pd.read_csv(cache_path, parse_dates=["date"], index_col="date")
            if len(cached) > 0:
                return cached
        except Exception:  # noqa: BLE001 - 缓存损坏时重新拉取
            cache_path.unlink(missing_ok=True)

    payload = _get_json(TX_KLINE, {"param": f"{sym},{period},,,{bars},qfq"})
    node = ((payload or {}).get("data") or {}).get(sym) or {}
    # 前复权时键名带 qfq 前缀，兜底到无前缀键
    raw = node.get(f"qfq{period}") or node.get(period) or []
    if not raw:
        return None

    cols = ["date", "open", "close", "high", "low", "volume"]
    width = min(len(raw[0]), len(cols))
    df = pd.DataFrame([r[:width] for r in raw], columns=cols[:width])
    df["date"] = pd.to_datetime(df["date"])
    for col in cols[1:width]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["close"]).set_index("date").sort_index()
    # 统一时间标签，让不同股票共享同一套周/月网格
    df.index = canonical_index(df.index, period)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df[df["close"] > 0]

    if use_cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        df.to_csv(cache_path)
    return df


def build_panels(
    codes: List[str],
    period: str = "week",
    bars: int = 400,
    workers: int = 6,
    use_cache: bool = True,
    verbose: bool = True,
) -> Dict[str, pd.DataFrame]:
    """并发拉取多只股票并拼成宽表面板。

    Returns:
        dict，键 open / close / high / low / volume / amount，
        值均为 index=date、columns=code 的 DataFrame。
    """
    frames: Dict[str, pd.DataFrame] = {}
    total = len(codes)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_kline, c, period, bars, use_cache): c for c in codes}
        for i, fut in enumerate(as_completed(futures), 1):
            code = futures[fut]
            try:
                df = fut.result()
            except Exception as exc:  # noqa: BLE001 - 单只失败不影响整批
                if verbose:
                    print(f"  [跳过] {code}: {exc}")
                continue
            if df is not None and len(df) > 0:
                frames[code] = df
            if verbose and i % 50 == 0:
                print(f"  已拉取 {i}/{total}")

    if not frames:
        raise RuntimeError("没有拉到任何 K 线数据，检查网络或参数")

    panels: Dict[str, pd.DataFrame] = {}
    for col in ["open", "close", "high", "low", "volume"]:
        panels[col] = pd.DataFrame({c: d[col] for c, d in frames.items()}).sort_index()
    panels["amount"] = panels["close"] * panels["volume"]

    # 数据清洗：前复权与数据源偶发异常会让 close 落到 [low, high] 之外，
    # 这种脏数据会直接污染三重障碍的触及判定（用最高价判断却比收盘价还低）。
    hi, lo, cl = panels["high"], panels["low"], panels["close"]
    bad = int((hi.lt(cl) | lo.gt(cl) | hi.lt(lo)).sum().sum())
    if bad:
        if verbose:
            print(f"  修正高低价越界的单元格 {bad} 个")
        panels["high"] = hi.where(~hi.lt(cl), cl).where(lambda x: x >= panels["low"], panels["low"])
        panels["low"] = lo.where(~lo.gt(cl), cl).where(lambda x: x <= panels["high"], panels["high"])

    if verbose:
        print(f"  面板形状: {panels['close'].shape[0]} 根 K 线 × {panels['close'].shape[1]} 只股票")
    return panels


def cross_check_prices(
    panels: Dict[str, pd.DataFrame],
    uni: pd.DataFrame,
    tol: float = 0.20,
    verbose: bool = True,
) -> pd.DataFrame:
    """用东财的最新价核对腾讯 K 线的末收，抓"取回来的不是这只股票"。

    这类错误极其隐蔽：000xxx 号段个股与指数重号，一旦前缀判错，
    拿到的是价格差几十上百倍的另一只标的，但面板照样拼得出来、
    因子照样算得出 IC，只有最后的收益数字是假的。

    Args:
        panels: build_panels 的返回值。
        uni: fetch_universe 的返回值，需含 code / name / last_price。
        tol: 相对误差容忍度。前复权价格与实时价本就有差异（分红送转、
            停牌、实时波动），20% 足够宽松，误报的代价远小于漏报。

    Returns:
        异常个股明细（空 DataFrame 表示全部通过）。
    """
    if "last_price" not in uni.columns:
        return pd.DataFrame()
    ref = uni.set_index("code")["last_price"]
    name = uni.set_index("code")["name"]
    close = panels["close"]

    rows = []
    for code in close.columns:
        if code not in ref.index:
            continue
        ref_px = ref.loc[code]
        got = close[code].dropna()
        if pd.isna(ref_px) or ref_px <= 0 or got.empty:
            continue
        got_px = float(got.iloc[-1])
        rel = abs(got_px - float(ref_px)) / float(ref_px)
        if rel > tol:
            rows.append({
                "code": code,
                "name": name.loc[code] if code in name.index else "",
                "东财最新价": float(ref_px),
                "K线末收": round(got_px, 2),
                "相对偏差": round(rel, 3),
            })

    bad = pd.DataFrame(rows)
    if verbose:
        n = len(close.columns)
        if bad.empty:
            print(f"  跨源校验通过：{n} 只标的的 K 线末收与东财最新价一致")
        else:
            print(f"  !! 跨源校验发现 {len(bad)}/{n} 只标的价格对不上，疑似取错标的：")
            print(bad.to_string(index=False))
            print("     这些标的已从面板剔除。若剔除数量过多，检查 tx_symbol 的映射规则。")
    return bad


def drop_codes(panels: Dict[str, pd.DataFrame], codes: List[str]) -> Dict[str, pd.DataFrame]:
    """从面板中剔除指定标的（跨源校验失败时用）。"""
    if not codes:
        return panels
    return {k: v.drop(columns=[c for c in codes if c in v.columns]) for k, v in panels.items()}


if __name__ == "__main__":
    uni = fetch_universe(pages=1)
    print(f"股票池 {len(uni)} 只")
    print(uni.head(10).to_string(index=False))
    if len(uni):
        k = fetch_kline(uni.loc[0, "code"], period="week", bars=20)
        print(k.tail(5).to_string() if k is not None else "K线拉取失败")
