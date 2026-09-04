/* 由 server.js 机械拆分而来，行为未改动。 */
function jres(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function ok(res, data) { jres(res, 200, { ok: true, data }); }
function fail(res, msg, code = 502) { jres(res, code, { ok: false, msg }); }

/* 读取 JSON 请求体（带大小上限，防止被大 body 打爆）
   超限时要先回一个完整响应再断流 —— 直接 destroy() 会让客户端只看到
   ECONNRESET 网络错误，拿不到可读的 413 提示 */
function readBody(req, res, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        if (!res.headersSent) fail(res, '请求体过大（上限 ' + Math.round(limit / 1024) + 'KB）', 413);
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = { fail, jres, ok, readBody };
