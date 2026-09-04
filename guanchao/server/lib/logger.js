/* 结构化日志：单行 JSON，便于检索与接入采集端。
   原先散落各处的 console.log 没有请求上下文，排障时无法把
   「某次慢请求」和「上游哪个域失败」关联起来。 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const log = {
  debug: (msg, f) => emit('debug', msg, f),
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f)
};

/* 简易请求 ID：够用即可，便于把同一次请求的多条日志串起来 */
let seq = 0;
function nextId() {
  seq = (seq + 1) % 0xffffff;
  return Date.now().toString(36) + '-' + seq.toString(36);
}

module.exports = { log, nextId, LEVELS };
