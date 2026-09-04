/* 由 server.js 机械拆分而来，行为未改动。 */

async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    for (;;) {
      const idx = i++;
      if (idx >= list.length) return;
      try { out[idx] = await fn(list[idx], idx); }
      catch (e) { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* clist 字段解析（行情列表通用） */

module.exports = { mapLimit };
