/* AI 解读层（学习 go-stock 的 AI 大模型分析思路，但零新增依赖）。
   职责：把前端传来的「已聚合数据 + 用户问题」交给兼容 OpenAI 协议的大模型，
   以 SSE 流式返回解读。密钥来自 config.loadLLM()（环境变量 / data/llm.json），
   不硬编码、不打包进仓库。
   前端各处（预测PP / 对比 / 个股详情）只需把已有数据拼成 ctx 文本传进来即可。 */
const { loadLLM } = require('../config.js');
const { fail } = require('../lib/respond.js');

const H = {};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const SYS_PROMPT =
  '你是「观潮」A股量化分析助手的证券研究员。请基于用户提供的行情/回测/风险数据，' +
  '用简体中文、结构化分点给出客观解读，包含：1) 数据要点；2) 可能的原因；3) 需注意的风险点。' +
  '语气专业、克制、不夸大。所有结论必须明确标注「仅供参考，不构成投资建议」。' +
  '若数据不足或矛盾，直接说明，不要编造数字。';

function buildMessages(body) {
  const ctx = body.ctx;
  const ctxStr = typeof ctx === 'string' ? ctx : JSON.stringify(ctx || {}, null, 2);
  const ask = body.ask || '请对以上数据进行解读、总结与风险提示。';
  const user = `【待分析数据】\n${ctxStr}\n\n【用户问题】\n${ask}`;
  const messages = [{ role: 'system', content: SYS_PROMPT }];
  if (Array.isArray(body.history)) {
    for (const h of body.history) {
      if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
        messages.push({ role: h.role, content: String(h.content) });
      }
    }
  }
  messages.push({ role: 'user', content: user });
  return messages;
}

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

H['/ai'] = async (res, q, req) => {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return fail(res, '请求体解析失败：' + e.message, 400);
  }
  const cfg = loadLLM();
  if (!cfg || !cfg.apiKey) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    sse(res, {
      type: 'error',
      message:
        'AI 解读未配置：请在 data/llm.json（或环境变量 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）中配置大模型 Key 后重试。'
    });
    return res.end();
  }

  const messages = buildMessages(body);
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  let upstream;
  try {
    upstream = await fetch(cfg.baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: true,
        temperature: 0.3
      }),
      signal: ac.signal
    });
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    sse(res, { type: 'error', message: '调用大模型失败：' + e.message });
    return res.end();
  }

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    sse(res, { type: 'error', message: '大模型返回错误(' + upstream.status + ')：' + txt.slice(0, 200) });
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) sse(res, { type: 'delta', content: delta });
        } catch (_) { /* 忽略非 JSON 行 */ }
      }
    }
    sse(res, { type: 'done' });
  } catch (e) {
    if (e.name !== 'AbortError') sse(res, { type: 'error', message: '流式读取中断：' + e.message });
  } finally {
    res.end();
  }
};

module.exports = H;
