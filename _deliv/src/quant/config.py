"""全局配置：数据、频率、标注壁垒、成本与回测参数。

所有参数集中在此处，方便做敏感性测试与 walk-forward 复现。
改参数只改这里，不要在业务逻辑里硬编码。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "data_cache"
OUTPUT_DIR = BASE_DIR / "output"

# 单根 K 线对应的年份系数，用于年化
BARS_PER_YEAR = {"week": 50.0, "month": 12.0, "day": 244.0}


@dataclass
class Config:
    # ---------------- 数据层 ----------------
    period: str = "week"          # week | month
    # 腾讯周线实测上限约 800 根（≈2011 年至今）；传更大值会被静默截断成 641 根
    bars: int = 800
    universe_size: int = 150      # 取成交额前 N 只作为股票池
    universe_pages: int = 3       # 东财翻页数（每页硬上限 100）
    min_history: int = 60         # 历史少于该根数的股票剔除
    workers: int = 6              # 并发拉取线程数
    refresh: bool = False         # True = 忽略本地缓存重新拉取
    start: str | None = None      # 样本起始日期 YYYY-MM-DD，做 A/B 对比时用来对齐区间
    cross_check: bool = True      # 用东财最新价校验 K 线末收，剔除取错标的的列
    cross_check_tol: float = 0.20 # 价格校验的相对误差容忍度

    # ---------------- 标注层（三重障碍）----------------
    max_hold: int = 8             # 时间壁垒：最多持有多少根 K 线
    upper_mult: float = 1.0       # 上轨 = upper_mult * sigma * sqrt(max_hold)
    lower_mult: float = 0.8       # 下轨 = lower_mult * sigma * sqrt(max_hold)
    atr_window: int = 12          # 单期波动率估计窗口
    min_sigma: float = 0.01       # 单期波动率下限，防止低波动股壁垒过窄
    ambiguity: str = "skip"       # skip（同根 K 线双破则丢弃）| pessimistic（取 -1）

    # ---------------- 股票池（按历史时点筛选）----------------
    use_pit_universe: bool = True # 关闭则退回"用当前热门股回测历史"（有幸存者偏差）
    # 前复权价会被分红送转系统性压低，用它做绝对阈值会误杀大量正常股票
    # （实测 2013 年池内中位数股价仅 3.83 元，73 只里 22 只低于 2 元）。
    # 仙股与退市边缘股由下面的流动性条件拦截，所以这里默认关闭。
    pit_min_price: float = 0.0
    pit_liq_window: int = 12      # 流动性中位数回看窗口
    pit_max_names: int | None = None  # 每期最多保留多少只，None = 不限
    pit_min_names: int = 30       # 池内少于该只数的期次不参与统计（样本量不够）

    # ---------------- 特征层 ----------------
    industry_neutral: bool = True # 因子做行业中性化
    winsor: float = 5.0           # 截面 MAD 截尾倍数

    # ---------------- 新信息源（基本面 / 大宗交易）----------------
    # 第一版只验证、不盲目合成：基本面因子在「大市值成交额前 N」池里
    # walk-forward 无效，仅作 IC 报告；大宗因子 block_freq_inv 经过
    # walk-forward 验证稳定正向，才并入综合得分；risk_flag 作风控过滤器。
    fin_stale: int = 12           # 财报最多沿用多少期，超出置 NaN（防老化泄漏）
    block_window: int = 8         # 大宗因子 / 风控回看窗口（周）
    block_max_discount: float = 15.0   # 风控：近窗出现超此折价率(百分点)触发剔除
    block_max_pressure: float = 0.30   # 风控：大宗占二级成交超此比例触发剔除
    use_fundamental: bool = False # 基本面因子是否并入综合得分（默认仅报告 IC）
    use_block_factor: bool = True # 大宗因子是否并入综合得分

    # ---------------- 回测层 ----------------
    top_n: int = 20               # 每期选多少只
    rebalance_every: int = 4      # 每 N 根 K 线调仓一次
    commission_bps: float = 2.5   # 单边佣金（万 2.5）
    stamp_bps: float = 10.0       # 卖出印花税（千一）
    slippage_bps: float = 10.0    # 单边滑点
    benchmark: str = "000300"     # 基准指数代码，沪深300（上证指数系列 000xxx）
    bench_mode: str = "median"    # 超额收益基准：median（典型个股）/ mean（等权）

    # ---------------- 验证层 ----------------
    train_bars: int = 156         # walk-forward 训练窗（周线约 3 年）
    test_bars: int = 26           # walk-forward 测试窗（周线约半年）
    embargo_bars: int = 8         # 与 max_hold 对齐，阻断标签跨越训练集边界

    # ---------------- 有效性红线 ----------------
    ic_threshold: float = 0.03
    ir_threshold: float = 0.5

    def ensure_dirs(self) -> "Config":
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        return self

    @property
    def ppy(self) -> float:
        """每年有多少根 K 线，用于年化。"""
        return BARS_PER_YEAR.get(self.period, 50.0)
