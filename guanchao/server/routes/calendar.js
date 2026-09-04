/* 财经日历（学习 go-stock 的 GetClsCalendar，财联社源）。
   按日分组返回未来一段时间的财经事件 / 经济数据发布，
   字段口径来自财联社 calendar/web/list 接口，已 curl 实测。 */
const { getJSON } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { createCache } = require('../lib/cache.js');

const H = {};
const CLS_URL =
  'https://www.cls.cn/api/calendar/web/list?app=CailianpressWeb&flag=0&os=web&sv=8.4.6&type=0&sign=4b839750dc2f6b803d1c8ca00d2b40be';
const HEAD = { Referer: 'https://www.cls.cn/', 'User-Agent': 'Mozilla/5.0' };
/* 30 分钟缓存：日历日内变化极小 */
const cache = createCache({ name: 'calendar', ttl: 1800000, max: 4 });

function toItem(it) {
  const ev = it.event || {};
  const eco = it.economic || null;
  return {
    time: (it.calendar_time || '').slice(11, 16) || '',
    title: it.title || ev.title || '',
    country: ev.country || '',
    star: Number(ev.star) || 0,
    type: Number(it.type) || 0,
    red: it.mark_red === 1,
    eco: eco
      ? {
          name: eco.name || ev.title || '',
          previous: eco.previous,
          forecast: eco.forecast,
          actual: eco.actual,
          unit: eco.unit || ''
        }
      : null
  };
}

function toDay(d) {
  return {
    day: d.calendar_day,
    week: d.week || '',
    items: (d.items || []).map(toItem)
  };
}

async function list() {
  const j = await getJSON(CLS_URL, HEAD, 2);
  const days = Array.isArray(j && j.data) ? j.data : [];
  return days.filter((d) => d && d.calendar_day).map(toDay);
}

H['/calendar'] = async (res) => {
  const { data } = await cache.wrap('cls', list);
  ok(res, data);
};

module.exports = H;
