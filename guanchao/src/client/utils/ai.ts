/* 消费 /api/ai 的 SSE 流式响应（与 routes/ai.js 的协议对齐）。
   每收到一个 data 事件就回调对应处理器。 */

export interface SSEHandlers {
  onDelta: (text: string) => void
  onDone: () => void
  onError: (msg: string) => void
  signal?: AbortSignal
}

export async function readSSE(res: Response, h: SSEHandlers): Promise<void> {
  if (!res.body) {
    h.onError('空响应')
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const payload = s.slice(5).trim()
        if (!payload) continue
        try {
          const j = JSON.parse(payload)
          if (j.type === 'delta') h.onDelta(j.content)
          else if (j.type === 'done') h.onDone()
          else if (j.type === 'error') h.onError(j.message)
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    }
    h.onDone()
  } catch (e) {
    const err = e instanceof Error ? e : null
    if (err?.name === 'AbortError') return
    h.onError(err?.message || '读取中断')
  }
}
