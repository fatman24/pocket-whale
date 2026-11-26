/**
 * 提问转发：presence 门控 + /pocket/question 回答 → waterfall 拿到答案。
 * 真插件 apply() + 假 ctx + 真 HTTP。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function mountPlugin({ questionTickMs } = {}) {
  process.env.DSH_HOME = tmpdir('pocket-qhome-')
  process.env.DSH_POCKET_LAN = '0'
  process.env.DSH_POCKET_DISCOVERY = '0'
  if (questionTickMs) process.env.DSH_POCKET_QUESTION_TICK_MS = String(questionTickMs)

  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      port: 0,
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      getOrigin() {
        return null
      },
    },
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async listSessions() {
            return []
          },
          async readSession() {
            throw new Error('session-not-found')
          },
        }
      }
      return undefined
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    async waterfall() {
      return 'unavailable'
    },
  }

  const { apply } = await import('../index.js')
  const dispose = apply(ctx)
  delete process.env.DSH_POCKET_QUESTION_TICK_MS

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://test.local')
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404)
      res.end('no route')
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    base,
    listener: (event) => listeners.get(event),
    async close() {
      await new Promise((resolve) => server.close(resolve))
      dispose?.()
    },
  }
}

function questionRequest(callId = 'call-1') {
  return {
    questions: [
      {
        id: 'q1',
        header: '缺数据',
        question: '结论要写实的数字，你希望怎么办？',
        options: [{ label: '我把数据发给你' }, { label: '按现有内容写', recommended: true }],
      },
    ],
    wait: { callId },
    agent: { session: { id: 'session-x' } },
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

test('手机在前台：问题转到手机，回答回到 waterfall', async () => {
  const mounted = await mountPlugin()
  const controller = new AbortController()
  try {
    // 一条 SSE 订阅 = 手机在线
    const events = await fetch(`${mounted.base}/pocket/events`, { signal: controller.signal })
    assert.equal(events.status, 200)
    const presence = await postJson(`${mounted.base}/pocket/presence`, { foreground: true })
    assert.equal(presence.body.foreground, true)

    const handle = mounted.listener('user-questions/request')
    assert.equal(typeof handle, 'function')

    const pending = handle(questionRequest(), () => 'desktop-answerer')
    // 等广播进待答表
    await new Promise((resolve) => setTimeout(resolve, 30))

    const accepted = await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-1',
      answers: [{ id: 'q1', selected: ['按现有内容写'] }],
    })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['按现有内容写'] }] })

    // 相同答案重试（客户端丢了回执）：幂等窗口内回 replayed，宿主只收到一次
    const replay = await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-1',
      answers: [{ id: 'q1', selected: ['按现有内容写'] }],
    })
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.replayed, true)

    // 不同答案重试：必须明确拒绝，不能静默成功
    const different = await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-1',
      answers: [{ id: 'q1', selected: ['我把数据发给你'] }],
    })
    assert.equal(different.status, 409)
    assert.equal(different.body.error, 'answer-already-settled')

    const status = await fetch(`${mounted.base}/pocket/status`).then((res) => res.json())
    assert.equal(status.features.questions, true)
    assert.equal(status.questions.answered, 1)
    assert.equal(status.questions.pending, 0)
  } finally {
    controller.abort()
    await mounted.close()
  }
})

test('手机在前台：非法答案被拒绝，问题保持待答', async () => {
  const mounted = await mountPlugin()
  const controller = new AbortController()
  try {
    await fetch(`${mounted.base}/pocket/events`, { signal: controller.signal })
    await postJson(`${mounted.base}/pocket/presence`, { foreground: true })

    const handle = mounted.listener('user-questions/request')
    const pending = handle(questionRequest('call-2'), () => 'desktop')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const bad = await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-2',
      answers: [{ id: 'q1', selected: ['没这个选项'] }],
    })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /option-not-offered/)

    const missing = await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-2',
      answers: [],
    })
    assert.equal(missing.status, 400)

    const unknown = await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-nope',
      answers: [{ id: 'q1', selected: [] }],
    })
    assert.equal(unknown.status, 409)

    // 合法答案收尾，别让测试进程挂着
    await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-2',
      answers: [{ id: 'q1', selected: [] }],
    })
    assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: [] }] })
  } finally {
    controller.abort()
    await mounted.close()
  }
})

test('手机切后台：问题不拦截，直接交给桌面 UI', async () => {
  const mounted = await mountPlugin()
  const controller = new AbortController()
  try {
    await fetch(`${mounted.base}/pocket/events`, { signal: controller.signal })
    await postJson(`${mounted.base}/pocket/presence`, { foreground: false })

    const handle = mounted.listener('user-questions/request')
    let nextCalls = 0
    const outcome = await handle(questionRequest('call-3'), () => {
      nextCalls += 1
      return 'desktop-answerer'
    })
    assert.equal(outcome, 'desktop-answerer')
    assert.equal(nextCalls, 1)

    const status = await fetch(`${mounted.base}/pocket/status`).then((res) => res.json())
    assert.equal(status.questions.pending, 0)
    assert.equal(status.questions.phoneForeground, false)
  } finally {
    controller.abort()
    await mounted.close()
  }
})

test('没有手机订阅时即使标了前台也不接管', async () => {
  const mounted = await mountPlugin()
  try {
    await postJson(`${mounted.base}/pocket/presence`, { foreground: true })
    const handle = mounted.listener('user-questions/request')
    let nextCalls = 0
    const outcome = await handle(questionRequest('call-4'), () => {
      nextCalls += 1
      return 'desktop-answerer'
    })
    assert.equal(outcome, 'desktop-answerer')
    assert.equal(nextCalls, 1)
  } finally {
    await mounted.close()
  }
})

async function readSseUntil(response, predicate, timeoutMs = 2000) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = JSON.parse(line.slice(6))
        if (predicate(payload)) return payload
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return null
}

test('断线重连：SSE 订阅后补发还没答的问题', async () => {
  const mounted = await mountPlugin()
  const first = new AbortController()
  try {
    const events = await fetch(`${mounted.base}/pocket/events`, { signal: first.signal })
    await postJson(`${mounted.base}/pocket/presence`, { foreground: true })

    const handle = mounted.listener('user-questions/request')
    const pending = handle(questionRequest('call-5'), () => 'desktop')
    await new Promise((resolve) => setTimeout(resolve, 30))

    // 模拟切前台/重连：断开旧订阅，再连一次
    first.abort()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = new AbortController()
    const reconnect = await fetch(`${mounted.base}/pocket/events`, { signal: second.signal })
    const replay = await readSseUntil(reconnect, (payload) => payload.type === 'question/requested')
    assert.ok(replay, '重连后没有收到补发的提问')
    assert.equal(replay.request.id, 'call-5')
    assert.equal(replay.request.questions[0].id, 'q1')

    second.abort()
    await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-5',
      answers: [{ id: 'q1', selected: [] }],
    })
    await pending
  } finally {
    await mounted.close()
  }
})

test('A 模式（宿主在手机里）：没有前台心跳也接管提问，切后台不转交', async () => {
  process.env.DSH_POCKET_LOCAL_HOST = '1'
  const mounted = await mountPlugin()
  try {
    // 没有 SSE 订阅、没有 presence：A 模式下仍然要拦住，等 App 回来
    const handle = mounted.listener('user-questions/request')
    const pending = handle(questionRequest('call-6'), () => 'desktop')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const status = await fetch(`${mounted.base}/pocket/status`).then((res) => res.json())
    assert.equal(status.questions.pending, 1)
    assert.equal(status.questions.phoneForeground, false)

    await postJson(`${mounted.base}/pocket/presence`, { foreground: false })
    // 切后台也不该把问题交出去（A 模式没有别的回答者）
    const outcome = await Promise.race([
      pending.then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 200)),
    ])
    assert.equal(outcome, 'still-waiting')
    assert.equal(status.questions.delegated, 0)
  } finally {
    await mounted.close()
    delete process.env.DSH_POCKET_LOCAL_HOST
  }
})

test('问题已转交桌面：手机再答给出明确结果，不会把答案塞回去', async () => {
  // 心跳重查间隔缩短到 30ms，先在手机前台接管，再切后台触发 delegate。
  const mounted = await mountPlugin({ questionTickMs: 30 })
  const controller = new AbortController()
  try {
    await fetch(`${mounted.base}/pocket/events`, { signal: controller.signal })
    await postJson(`${mounted.base}/pocket/presence`, { foreground: true })

    const handle = mounted.listener('user-questions/request')
    const outcomePromise = handle(questionRequest('call-delegated'), () => 'desktop-answerer')
    await new Promise((resolve) => setTimeout(resolve, 40))
    await postJson(`${mounted.base}/pocket/presence`, { foreground: false })
    assert.equal(await outcomePromise, 'desktop-answerer')

    const res = await postJson(`${mounted.base}/pocket/question`, {
      id: 'call-delegated',
      answers: [{ id: 'q1', selected: ['按现有内容写'] }],
    })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal(res.body.error, 'question-delegated')
  } finally {
    controller.abort()
    await mounted.close()
  }
})
