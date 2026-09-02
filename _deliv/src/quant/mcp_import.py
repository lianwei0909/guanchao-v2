"""把 MCP 大输出落盘文件解析成本地缓存。

为什么需要这个模块
------------------
腾讯自选股 MCP（westock-mcp）的返回量很大：10 只股票 × 40 期财务数据
就有 37 万字符。超过阈值后 MCP 会把结果写到
``.../projects/<...>/tool-results/mcp-westock-mcp-<tool>-<ts>-<rand>.txt``
而不是塞进上下文。Python 脚本又无法直接调用 MCP，所以分工是：

    agent 侧：批量调 MCP（输出自动落盘）
    本模块  ：扫描落盘文件 -> 解析 -> 合并进缓存

缓存按 **标的主键** 合并，重复拉取同一只股票不会产生重复记录，
因此拉取批次可以任意重叠、重跑、断点续拉。

用法（agent 侧每拉完一批调一次）：
    python mcp_import.py            # 增量导入所有未处理过的落盘文件
    python mcp_import.py --status   # 只看当前缓存覆盖情况
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "data_cache"
MCP_RAW = CACHE / "mcp_raw"
CACHE.mkdir(exist_ok=True)
MCP_RAW.mkdir(exist_ok=True)

# 落盘目录由宿主决定，往上找 projects / tool-results
HOST_RESULTS = (
    Path.home()
    / ".workbuddy"
    / "projects"
    / "c-Users-Administrator-WorkBuddy-2026-08-31-13-57-13"
    / "a2893faf-5929-479e-adce-fa2dd6509d6f"
    / "tool-results"
)

FIN_FILE = CACHE / "mcp_finance.json"
BLOCK_FILE = CACHE / "mcp_block.json"
SEEN_FILE = CACHE / "mcp_imported.txt"


# ---------------------------------------------------------------- 工具

def _load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _extract_json(text: str):
    """落盘文件里可能夹带说明性前缀，从第一个 '{' 起解析。"""
    i = text.find("{")
    if i < 0:
        return None
    try:
        return json.loads(text[i:])
    except json.JSONDecodeError:
        return None


def _is_target(node: dict) -> bool:
    """判定 node 是否为目标层 {symbol: 记录}。

    兼容两类形态（按结构而非 key 名识别）：
      - 扁平：某 value 是"元素为 dict 的 list"（大宗、扁平财务）。
      - 分表：某 value 本身是 dict，且其内部含 list
        （如财务分表 {sh600460:{balance:[...], income:[...]}}）。
    """
    if not isinstance(node, dict):
        return False
    for v in node.values():
        if isinstance(v, list):
            return True
        if isinstance(v, dict) and any(isinstance(x, list) for x in v.values()):
            return True
    return False


def _unwrap(payload: dict):
    """剥掉接口信封，拿到 {symbol: 记录} 这一层。

    不同接口的信封层数不一样，硬编码层数迟早出错，所以按结构往下钻：
      - data_fund_block: {"ok":true, "data":{"sh600519":[...]}}
      - data_finance   : {"ok":true, "data":{"code":0, "msg":"...",
                                             "data":{"sh600519":[...]}}}
                       也可能再深一层变成 {sh600519:{balance:[...],income:[...]}}
    判别依据是"某个 value 是 list / 或值是含 list 的 dict"，不看 key 名。
    """
    node = payload.get("data") if "data" in payload else payload
    for _ in range(5):
        if _is_target(node):
            return node
        if not isinstance(node, dict):
            return None
        node = node.get("data")
    return None


def _seen() -> set[str]:
    if SEEN_FILE.exists():
        return set(
            ln.strip() for ln in _load_text(SEEN_FILE).splitlines() if ln.strip()
        )
    return set()


def _mark_seen(names):
    with SEEN_FILE.open("a", encoding="utf-8") as fh:
        for n in names:
            fh.write(n + "\n")


def _read_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(_load_text(path))
        except json.JSONDecodeError:
            return default
    return default


def _write_json(path: Path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------- 财务

# income 表 core 窄表里真正会用到的字段。
# 只留这些，避免把 37 万字符全塞进缓存。
FIN_FIELDS = [
    "EndDate", "InfoPublDate", "date",
    "BasicEPS", "EPSTTM",
    "NPParentCompanyOwners", "NPParentCompanyOwnersTTM",
    "NPParentCompanyYOY", "NPParentCompanyYOY_Q",
    "NPParentCompanyCutYOY",
    "TORGrowRate", "TORGrowRate_Q",
    "OperatingRevenue", "OperatingRevenueTTM", "TotalOperatingRevenue",
    "OperatingRevenueGrowRate", "OperatingRevenueGrowRate_Q",
    "ROE", "ROEWeighted", "ROECut", "ROETTM", "ROE_Q",
    "ROA", "ROATTM", "ROIC",
    "GrossIncomeRatio", "NetProfitRatio",
    "OperatingCost", "OperatingProfit", "TotalProfit",
    "RAndD", "EBIT", "DividendTTM",
    "ORComGrowRate3Y", "NPPCCGrowRate3Y",
]


def _normalize_fin_reports(rows):
    """把历次批次不一致的财务结构统一成 [{报告期字段: ...}, ...]。

    实测过两种返回形态：
      A) rows 是 list of dict（三大报表已合并到每个报告期），之前批次。
      B) rows 是 {balance:[...], cashflow:[...], income:[...]}（分表），
         本次 9 只补拉。要按 EndDate 把三张表的字段聚合到同一报告期。
    """
    if isinstance(rows, list):
        return [r for r in rows if isinstance(r, dict)]
    if not isinstance(rows, dict):
        return []
    sheets = {k: v for k, v in rows.items() if isinstance(v, list)}
    if not sheets:
        return []
    merged: dict[str, dict] = {}
    for lst in sheets.values():
        for r in lst:
            if not isinstance(r, dict):
                continue
            ed = str(r.get("EndDate") or r.get("date") or "")
            if not ed:
                continue
            merged.setdefault(ed, {})["EndDate"] = ed
            merged[ed].update(r)
    return list(merged.values())


def import_finance(payload: dict) -> tuple[int, int]:
    """合并财务数据。返回 (新增标的数量, 总记录数)。"""
    fin = _read_json(FIN_FILE, {})
    new_syms = 0
    for sym, rows in (payload.get("data") or {}).items():
        if rows is None:
            continue
        # 注意：setdefault 之后 `sym not in fin` 恒为假，
        # 判断"是否新增"必须在 setdefault 之前做。
        if sym not in fin:
            new_syms += 1
        # 空数组也要占位：区分"拉过但没有数据"和"根本没拉过"，
        # 否则覆盖率统计会一直把零记录的标的当成缺失。
        cur = fin.setdefault(sym, {})
        for r in _normalize_fin_reports(rows):
            if not isinstance(r, dict):
                continue
            key = str(r.get("EndDate") or r.get("date") or "")
            if not key:
                continue
            cur[key] = {f: r.get(f) for f in FIN_FIELDS if f in r}
    _write_json(FIN_FILE, fin)
    total = sum(len(v) for v in fin.values())
    return new_syms, total


# ---------------------------------------------------------------- 大宗交易

def import_block(payload: dict) -> tuple[int, int]:
    """合并大宗交易数据。返回 (新增标的数量, 总笔数)。"""
    blk = _read_json(BLOCK_FILE, {})
    new_syms = 0
    for sym, rows in (payload.get("data") or {}).items():
        if not isinstance(rows, list):
            continue
        if sym not in blk:
            new_syms += 1
        cur = blk.setdefault(sym, {})
        for r in rows:
            if not isinstance(r, dict):
                continue
            day = str(r.get("date") or "")
            if not day:
                continue
            trades = []
            for t in (r.get("blockTradingInfos") or []):
                if not isinstance(t, dict):
                    continue
                trades.append(
                    {
                        "price": t.get("TurnoverPrice"),
                        "value": t.get("TurnoverValue"),
                        "discount": t.get("CloseDiscountRate"),
                        "buyer": t.get("BuySalesDepartment"),
                        "seller": t.get("SellSalesDepartment"),
                        "type": t.get("TradingType"),
                    }
                )
            cur[day] = {
                "close": r.get("closePrice"),
                "trades": trades,
            }
    _write_json(BLOCK_FILE, blk)
    total = sum(len(v) for v in blk.values())
    return new_syms, total


# ---------------------------------------------------------------- 主流程

def run(rescan: bool = False) -> None:
    if not HOST_RESULTS.exists():
        print(f"落盘目录不存在: {HOST_RESULTS}")
        return
    seen = set() if rescan else _seen()
    files = sorted(HOST_RESULTS.glob("mcp-westock-mcp-*.txt"))
    todo = [f for f in files if f.name not in seen]
    if not todo:
        print("没有新的落盘文件。")
        _status()
        return

    done, n_fin, n_blk = [], 0, 0
    for f in todo:
        payload = _extract_json(_load_text(f))
        if not isinstance(payload, dict):
            done.append(f.name)
            continue
        body = _unwrap(payload)
        if not isinstance(body, dict):
            done.append(f.name)
            continue
        name = f.name
        if "data_finance" in name:
            try:
                s, t = import_finance({"data": body})
                n_fin += s
                print(f"  财务 {name[:60]}: +{s} 只，累计 {t} 条记录")
            except Exception as e:  # noqa: BLE001
                print(f"  财务 {name[:60]} 解析失败: {e}")
        elif "data_fund_block" in name:
            try:
                s, t = import_block({"data": body})
                n_blk += s
                print(f"  大宗 {name[:60]}: +{s} 只，累计 {t} 个交易日")
            except Exception as e:  # noqa: BLE001
                print(f"  大宗 {name[:60]} 解析失败: {e}")
        done.append(f.name)

    _mark_seen(done)
    print(f"\n导入完成：财务 +{n_fin} 只，大宗 +{n_blk} 只")
    _status()


def _status() -> None:
    fin = _read_json(FIN_FILE, {})
    blk = _read_json(BLOCK_FILE, {})
    meta = _read_json(CACHE / "universe_syms.json", {})
    syms = meta.get("syms") or []
    print(f"\n缓存覆盖（目标 {len(syms)} 只）:")
    if syms:
        print(f"  财务: {sum(1 for s in syms if s in fin):3d} / {len(syms)}"
              f"   记录数 {sum(len(v) for v in fin.values())}")
        print(f"  大宗: {sum(1 for s in syms if s in blk):3d} / {len(syms)}"
              f"   交易日 {sum(len(v) for v in blk.values())}")
        miss_f = [s for s in syms if s not in fin]
        miss_b = [s for s in syms if s not in blk]
        if miss_f:
            print(f"  缺财务: {','.join(miss_f[:20])}"
                  + (" ..." if len(miss_f) > 20 else ""))
        if miss_b:
            print(f"  缺大宗: {','.join(miss_b[:20])}"
                  + (" ..." if len(miss_b) > 20 else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true", help="只看缓存覆盖情况")
    ap.add_argument("--rescan", action="store_true", help="忽略已处理记录，全量重扫")
    a = ap.parse_args()
    if a.status:
        _status()
    else:
        run(rescan=a.rescan)
