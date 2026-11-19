import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DecisionBook,
  makeApprovalAnswerer,
  makeQuestionAnswerer,
  normalizeQuestionAnswers,
  toPocketQuestion,
  summarizeSessionEvent,
  toPocketApproval,
  toPocketSession,
  isMainSession,
  DECIDED_TTL_MS,
  PENDING_TTL_MS,
} from '../lib/pocket-core.js'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('批准一次：工具侧拿到 allowed-once，客户端看到 settled', async () => {
  const c = clock()
  const book = new DecisionBook({ now: c.now })
  book.open('r1')
  const waiting = book.wait('r1')
  assert.deepEqual(book.decide('r1', 'allowed-once'), { status: 'settled', outcome: 'allowed-once' })
  assert.equal(await waiting, 'allowed-once')
  assert.equal(book.pendingCount, 0)
})

test('重复提交是幂等的：第二次返回 replayed，且结果相同', async () => {
  const c = clock()
  const book = new DecisionBook({ now: c.now })
  book.open('r1')
  const waiting = book.wait('r1')
  book.decide('r1', 'rejected')
  assert.deepEqual(book.decide('r1', 'allowed-once'), { status: 'replayed', outcome: 'rejected' })
  assert.equal(await waiting, 'rejected', '第一次的结论不能被后来的提交改写')
})

test('幂等窗口过期后，同一 id 视为未知而不是二次决策', async () => {
  const c = clock()
  const book = new DecisionBook({ now: c.now })
  book.open('r1')
  book.decide('r1', 'allowed-once')
  c.advance(DECIDED_TTL_MS + 1)
  assert.deepEqual(book.decide('r1', 'rejected'), { status: 'unknown' })
})

test('对未知 id 提交返回 unknown，等待返回 unavailable（fail closed）', async () => {
  const book = new DecisionBook()
  assert.deepEqual(book.decide('nope', 'allowed-once'), { status: 'unknown' })
  assert.equal(await book.wait('nope'), 'unavailable')
})

test('挂起超时按 unavailable 收盘，绝不默认放行', async () => {
  const c = clock()
  const book = new DecisionBook({ now: c.now })
  book.open('r1')
  const waiting = book.wait('r1')
  c.advance(PENDING_TTL_MS + 1)
  assert.deepEqual(book.sweep(), ['r1'])
  assert.equal(await waiting, 'unavailable')
  assert.equal(book.pendingCount, 0)
})

test('卸载时把所有挂起请求收盘为 cancelled', async () => {
  const book = new DecisionBook()
  book.open('a')
  book.open('b')
  const pa = book.wait('a')
  const pb = book.wait('b')
  assert.deepEqual(book.cancelAll().sort(), ['a', 'b'])
  assert.equal(await pa, 'cancelled')
  assert.equal(await pb, 'cancelled')
})

test('同一 id 重复 open 不会覆盖已挂起的那个', async () => {
  const book = new DecisionBook()
  book.open('r1')
  const first = book.wait('r1')
  book.open('r1')
  book.decide('r1', 'allowed-once')
  assert.equal(await first, 'allowed-once')
  assert.equal(book.pendingCount, 0)
})

test('onSettle 在每次收盘时回调一次', () => {
  const c = clock()
  const seen = []
  const book = new DecisionBook({ now: c.now, onSettle: (id, outcome) => seen.push([id, outcome]) })
  book.open('a')
  book.decide('a', 'allowed-once')
  book.open('b')
  book.cancelAll()
  assert.deepEqual(seen, [['a', 'allowed-once'], ['b', 'cancelled']])
})

test('会话裁剪只带手表需要的字段', () => {
  assert.deepEqual(
    toPocketSession({ header: { id: 's1', title: 'T', cwd: '/w', updatedAt: 9 }, live: true, persisted: false }),
    {
      id: 's1', title: 'T', cwd: '/w', live: true, running: false, persisted: false,
      parentSession: null, origin: null, delegationDepth: 0, isSubagent: false, updatedAt: 9,
    },
  )
  assert.equal(toPocketSession(undefined).id, null)
})

test('主会话过滤：子智能体不进接力列表', () => {
  assert.equal(isMainSession({ header: { id: 'main', delegationDepth: 0 } }), true)
  assert.equal(isMainSession({ header: { id: 'child', parentSession: 'main', origin: 'subagent', delegationDepth: 1 } }), false)
  assert.equal(toPocketSession({ header: { id: 'child', parentSession: 'main', origin: 'subagent', delegationDepth: 1 } }).isSubagent, true)
})

test('审批裁剪不泄露工具参数（请求本身也没有）', () => {
  assert.deepEqual(
    toPocketApproval({ toolName: 'bash', reason: 'needs network', displayReason: '需要网络', callId: 'c1' }, 'r1'),
    { id: 'r1', tool: 'bash', reason: 'needs network', displayReason: '需要网络', callId: 'c1' },
  )
  assert.deepEqual(toPocketApproval(null, 'r2'), { id: 'r2', tool: null, reason: null, displayReason: null, callId: null })
})

test('answerer：没有 id 的请求交给 next()，不拦截别人', async () => {
  const events = []
  const book = new DecisionBook()
  const answer = makeApprovalAnswerer({ book, broadcast: (e) => events.push(e) })
  let nexted = false
  const out = await answer({ toolName: 'bash' }, async () => {
    nexted = true
    return 'allowed-once'
  })
  assert.equal(nexted, true)
  assert.equal(out, 'allowed-once')
  assert.deepEqual(events, [], '没有 id 就不该广播给客户端')
})

test('answerer：有 id 时广播请求，并在客户端决定后返回结论', async () => {
  const events = []
  const book = new DecisionBook()
  const answer = makeApprovalAnswerer({ book, broadcast: (e) => events.push(e) })
  const pending = answer({ id: 'r1', toolName: 'bash', reason: 'needs network' }, () => 'unavailable')

  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(events[0], {
    type: 'approval/requested',
    request: { id: 'r1', tool: 'bash', reason: 'needs network', displayReason: null, callId: null },
  })
  assert.equal(book.pendingCount, 1)

  book.decide('r1', 'allowed-once')
  assert.equal(await pending, 'allowed-once')
})

test('answerer：信号已取消且没被批准时归一为 cancelled', async () => {
  const book = new DecisionBook()
  const answer = makeApprovalAnswerer({ book, broadcast: () => {} })
  const controller = new AbortController()
  const pending = answer({ id: 'r2', toolName: 'bash', signal: controller.signal }, () => 'unavailable')
  controller.abort()
  book.decide('r2', 'rejected')
  assert.equal(await pending, 'cancelled')
})

test('answerer：客户端一直不答，sweep 后按 unavailable 收盘（fail closed）', async () => {
  const c = clock()
  const book = new DecisionBook({ now: c.now })
  const answer = makeApprovalAnswerer({ book, broadcast: () => {} })
  const pending = answer({ id: 'r3', toolName: 'bash' }, () => 'unavailable')
  c.advance(PENDING_TTL_MS + 1)
  book.sweep()
  assert.equal(await pending, 'unavailable')
})

// 以下用例的形状都来自真实 session JSONL（session-v4，2026-11-16）

test('summarize：真实 user/message 只取 text 片段', () => {
  const item = summarizeSessionEvent({
    type: 'user/message',
    seq: 8,
    data: { content: [{ type: 'text', text: '现在qwen4 27b模型发布没有？' }], source: { kind: 'user' } },
  })
  assert.equal(item.kind, 'user')
  assert.equal(item.text, '现在qwen4 27b模型发布没有？')
})

test('summarize：系统注入不当作聊天内容', () => {
  for (const kind of ['runtime-context', 'skill-catalog', 'plugin:hindsight', 'time-context']) {
    const item = summarizeSessionEvent({
      type: 'user/message',
      seq: 9,
      data: { content: [{ type: 'text', text: '<system-reminder>…' }], source: { kind } },
    })
    assert.equal(item, null, `${kind} 不该出现在对话里`)
  }
})

test('summarize：assistant 丢掉 reasoning，只留 text', () => {
  const item = summarizeSessionEvent({
    type: 'assistant/message',
    seq: 50,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '这是一段思考过程' },
          { type: 'text', text: '没有，截至现在 Qwen4-27B 还未发布。' },
        ],
      },
    },
  })
  assert.equal(item.kind, 'assistant')
  assert.equal(item.text, '没有，截至现在 Qwen4-27B 还未发布。')
  assert.ok(!item.text.includes('思考过程'))
})

test('summarize：只有 reasoning 的 assistant 消息不显示', () => {
  const item = summarizeSessionEvent({
    type: 'assistant/message',
    seq: 20,
    data: { message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'tool-call' }] } },
  })
  assert.equal(item, null)
})

test('summarize：工具调用带出名字与参数预览', () => {
  const item = summarizeSessionEvent({
    type: 'tool/call',
    seq: 21,
    data: { callId: 'call_1', name: 'web_search', arguments: '{"queries":["Qwen4"]}' },
  })
  assert.equal(item.kind, 'tool')
  assert.equal(item.name, 'web_search')
  assert.equal(item.callId, 'call_1')
  assert.match(item.args, /queries/)
})

test('summarize：工具结果截断到 800 字以内', () => {
  const item = summarizeSessionEvent({
    type: 'tool/result',
    seq: 22,
    data: { message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } },
  })
  assert.equal(item.kind, 'tool-result')
  assert.equal(item.text.length, 800)
})

test('summarize：不认识的事件类型返回 null', () => {
  assert.equal(summarizeSessionEvent({ type: 'session/title', data: { title: 'x' } }), null)
  assert.equal(summarizeSessionEvent({ type: 'step/start', data: {} }), null)
})

// ---------------------------------------------------------------------------
// 提问（ask_user_question）
// ---------------------------------------------------------------------------

function questionRequest(overrides = {}) {
  return {
    questions: [
      {
        id: 'q1',
        header: '缺数据',
        question: '结论要写实的数字，你希望怎么办？',
        options: [
          { label: '我把数据发给你', description: '等一下再补' },
          { label: '按现有内容写', recommended: true },
        ],
      },
      {
        id: 'q2',
        question: '要包含哪些部分？',
        multiSelect: true,
        options: [{ label: '数据' }, { label: '结论' }, { label: '风险' }],
      },
    ],
    wait: { callId: 'call-9' },
    agent: { session: { id: 'session-x' } },
    ...overrides,
  }
}

test('提问裁剪：只带手机能渲染的字段，并保留会话 id', () => {
  const card = toPocketQuestion(questionRequest(), 'call-9')
  assert.equal(card.id, 'call-9')
  assert.equal(card.sessionId, 'session-x')
  assert.equal(card.timed, false)
  assert.equal(card.questions.length, 2)
  assert.deepEqual(card.questions[0].options.map((option) => option.label), ['我把数据发给你', '按现有内容写'])
  assert.equal(card.questions[0].options[1].recommended, true)
  assert.equal(card.questions[1].multiSelect, true)
})

test('提交答案：每问一条、选项必须在请求里、多选只对 multiSelect 开放', () => {
  const request = toPocketQuestion(questionRequest(), 'call-9')
  const ok = normalizeQuestionAnswers(request, {
    answers: [
      { id: 'q1', selected: ['按现有内容写'] },
      { id: 'q2', selected: ['数据', '结论'], custom: '  补一句风险  ' },
    ],
  })
  assert.deepEqual(ok, {
    answers: [
      { id: 'q1', selected: ['按现有内容写'] },
      { id: 'q2', selected: ['数据', '结论'], custom: '补一句风险' },
    ],
  })

  assert.throws(() => normalizeQuestionAnswers(request, { answers: [{ id: 'q1', selected: [] }] }), /count-mismatch/)
  assert.throws(() => normalizeQuestionAnswers(request, {
    answers: [{ id: 'q1', selected: ['不存在的选项'] }, { id: 'q2', selected: [] }],
  }), /option-not-offered/)
  assert.throws(() => normalizeQuestionAnswers(request, {
    answers: [{ id: 'q1', selected: ['我把数据发给你', '按现有内容写'] }, { id: 'q2', selected: [] }],
  }), /single-choice-only/)
  assert.throws(() => normalizeQuestionAnswers(request, {
    answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [], custom: 'x'.repeat(4001) }],
  }), /custom-too-long/)
  assert.throws(() => normalizeQuestionAnswers(request, {
    answers: [{ id: 'q1', selected: [] }, { id: 'q1', selected: [] }],
  }), /duplicate-answer/)
})

test('提问转发：广播 request，手机回答后把答案交回 waterfall', async () => {
  const book = new DecisionBook({ now: () => 1000 })
  const events = []
  const answerer = makeQuestionAnswerer({
    book,
    broadcast: (event) => events.push(event),
    shouldHandle: () => true,
    tickMs: 5,
  })
  const pending = answerer(questionRequest(), () => 'delegated')
  await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(events[0].type, 'question/requested')
  assert.equal(events[0].request.id, 'call-9')

  const batch = { answers: [{ id: 'q1', selected: ['按现有内容写'] }, { id: 'q2', selected: [] }] }
  book.decide('call-9', batch)
  assert.deepEqual(await pending, batch)
  assert.equal(events.at(-1).type, 'question/settled')
  assert.equal(events.at(-1).outcome, 'answered')
})

test('提问转发：手机退到后台就把问题还回桌面 UI', async () => {
  const book = new DecisionBook({ now: () => 1000 })
  const events = []
  let foreground = true
  let nextCalls = 0
  const answerer = makeQuestionAnswerer({
    book,
    broadcast: (event) => events.push(event),
    shouldHandle: () => foreground,
    tickMs: 5,
  })
  const pending = answerer(questionRequest(), () => {
    nextCalls += 1
    return 'desktop-answered'
  })
  await new Promise((resolve) => setTimeout(resolve, 1))
  foreground = false
  assert.equal(await pending, 'desktop-answered')
  assert.equal(nextCalls, 1)
  assert.equal(events.at(-1).outcome, 'delegated')
})

test('提问转发：手机没在前台时不拦截（包括没有 wait 的阻塞式提问）', async () => {
  const book = new DecisionBook({ now: () => 1000 })
  const events = []
  const answerer = makeQuestionAnswerer({ book, broadcast: (event) => events.push(event), shouldHandle: () => false })
  let nextCalls = 0
  const next = () => { nextCalls += 1; return 'desktop' }

  assert.equal(await answerer(questionRequest(), next), 'desktop')
  assert.equal(await answerer(questionRequest({ wait: undefined }), next), 'desktop')
  assert.equal(nextCalls, 2)
  assert.equal(events.length, 0)
})

test('阻塞式提问没有 wait.callId：自己生成 id，仍然能转发并回答', async () => {
  const book = new DecisionBook({ now: () => 1000 })
  const events = []
  const answerer = makeQuestionAnswerer({
    book,
    broadcast: (event) => events.push(event),
    shouldHandle: () => true,
    tickMs: 50,
  })
  const pending = answerer(questionRequest({ wait: undefined }), () => 'desktop')
  await new Promise((resolve) => setTimeout(resolve, 1))
  const id = events[0].request.id
  assert.match(id, /^q-/)
  assert.equal(events[0].request.sessionId, 'session-x')

  const batch = { answers: [{ id: 'q1', selected: ['按现有内容写'] }, { id: 'q2', selected: [] }] }
  book.decide(id, batch)
  assert.deepEqual(await pending, batch)
})

test('审批：手机不在前台时交给下一个 answerer', async () => {
  const book = new DecisionBook({ now: () => 1000 })
  const answerer = makeApprovalAnswerer({ book, broadcast: () => {}, shouldHandle: () => false })
  let nextCalls = 0
  const outcome = await answerer({ id: 'a1', toolName: 'bash' }, () => {
    nextCalls += 1
    return 'desktop'
  })
  assert.equal(outcome, 'desktop')
  assert.equal(nextCalls, 1)
  assert.equal(book.pendingCount, 0)
})

test('审批：等待中途手机退后台，转交桌面且卡片收起', async () => {
  const book = new DecisionBook({ now: () => 1000 })
  const events = []
  let foreground = true
  const answerer = makeApprovalAnswerer({
    book,
    broadcast: (event) => events.push(event),
    shouldHandle: () => foreground,
    tickMs: 5,
  })
  const pending = answerer({ id: 'a2', toolName: 'bash' }, () => 'desktop')
  await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(events[0].type, 'approval/requested')
  foreground = false
  assert.equal(await pending, 'desktop')
  assert.equal(book.pendingCount, 0)
})
