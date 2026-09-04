/* 每日炒作题材（学习 go-stock 的 ConceptEventList，同花顺源）。
   按日分组返回当日题材事件：题材标题 / 热度 / 关联概念板块 / 龙头股。
   字段口径来自同花顺 concept event/list 接口，已 curl 实测。 */
const { getJSON } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { createCache } = require('../lib/cache.js');

const H = {};
const URL = 'https://news.10jqka.com.cn/app/concept_v2_api/open/api/concept/event/jtcsm/v1/event/list';
const HEAD = { Referer: 'https://news.10jqka.com.cn/', 'User-Agent': 'Mozilla/5.0' };
/* 10 分钟缓存：题材日内更新有限 */
const cache = createCache({ name: 'concept', ttl: 600000, max: 4 });

async function list() {
  const j = await getJSON(URL, HEAD, 2);
  if (!j || j.status_code !== 0) throw new Error('题材事件获取失败');
  return (j.data || []).map((day) => ({
    date: day.date,
    events: (day.eventList || []).map((e) => ({
      id: e.eventId,
      title: e.title,
      heat: Number(e.heat) || 0,
      direction: e.investmentDirection || '',
      themes: (e.themes || []).map((t) => ({ code: t.indexCode, name: t.showName })),
      stocks: (e.topStocks || []).map((s) => ({
        code: s.stockCode,
        name: s.stockName,
        pct: Number(s.risePercent) || 0,
        limit: Number(s.limitUpState) || 0
      }))
    }))
  }));
}

H['/concept'] = async (res) => {
  const { data } = await cache.wrap('events', list);
  ok(res, data);
};

module.exports = H;
