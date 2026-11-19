/**
 * pocket-whale 的纯逻辑部分：不依赖 Cordis、不依赖 http，方便单测。
 */

/** 已决请求的记忆时长：防止抬腕双击造成双批。 */
export const DECIDED_TTL_MS = 5 * 60 * 1000
/** 单条请求的最大挂起时间，超时按 unavailable 处理（fail closed）。 */
export const PENDING_TTL_MS = 30 * 60 * 1000

/**
 * 审批请求的决策槽：把"工具在等一个回答"和"客户端提交一个回答"接起来。
 * 所有时间参数可注入，测试里用假时钟。
 */
export class DecisionBook {
  #pending = new Map()
  #decided = new Map()
  #now
  #pendingTtl
  #decidedTtl
  #onSettle

  constructor({ now = () => Date.now(), pendingTtl = PENDING_TTL_MS, decidedTtl = DECIDED_TTL_MS, onSettle } = {}) {
    this.#now = now
    this.#pendingTtl = pendingTtl
    this.#decidedTtl = decidedTtl
    this.#onSettle = onSettle
  }

  get pendingCount() {
    return this.#pending.size
  }

  get decidedCount() {
    return this.#decided.size
  }

  /** 已经开始等一个回答。同一 id 重复 open 保留先到的那个（重连/重放安全）。 */
  open(id) {
    if (this.#pending.has(id) || this.#decided.has(id)) return
    const entry = { resolve: undefined, due: this.#now() + this.#pendingTtl }
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    this.#pending.set(id, entry)
  }

  /** 工具侧等待结果；未知 id 一律 fail closed。 */
  wait(id) {
    const entry = this.#pending.get(id)
    if (!entry) return Promise.resolve('unavailable')
    return entry.promise
  }

  /** 客户端提交决定。返回 { status: 'settled' | 'replayed' | 'unknown', outcome? }。 */
  decide(id, outcome) {
    const seen = this.#decided.get(id)
    if (seen !== undefined) {
      if (seen.due > this.#now()) return { status: 'replayed', outcome: seen.outcome }
      this.#decided.delete(id)
    }

    const entry = this.#pending.get(id)
    if (!entry) return { status: 'unknown' }

    this.#pending.delete(id)
    this.#decided.set(id, { outcome, due: this.#now() + this.#decidedTtl })
    entry.resolve(outcome)
    this.#onSettle?.(id, outcome)
    return { status: 'settled', outcome }
  }

  /**
   * 清理过期项：挂起的过期请求按 unavailable 收盘（fail closed），
   * 已决记录到期后丢掉（幂等窗口结束）。返回本次过期的挂起 id。
   */
  sweep() {
    const now = this.#now()
    const expired = []
    for (const [id, entry] of this.#pending) {
      if (entry.due <= now) {
        this.#pending.delete(id)
        entry.resolve('unavailable')
        this.#onSettle?.(id, 'unavailable')
        expired.push(id)
      }
    }
    for (const [id, seen] of this.#decided) {
      if (seen.due <= now) this.#decided.delete(id)
    }
    return expired
  }

  /** 进程退出/插件卸载：所有挂起请求按 cancelled 收盘。 */
  cancelAll() {
    const ids = [...this.#pending.keys()]
    for (const id of ids) {
      this.#pending.get(id).resolve('cancelled')
      this.#onSettle?.(id, 'cancelled')
    }
    this.#pending.clear()
    return ids
  }
}

/** 子智能体会话会带 parentSession / origin:subagent / delegationDepth>0。 */
export function isMainSession(record) {
  const header = record?.header ?? {}
  return !(header.parentSession || header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0)
}

/** 裁到手表能显示的量；完整内容由 iPhone 端按需再取。 */
export function toPocketSession(record) {
  const header = record?.header ?? {}
  return {
    id: header.id ?? header.sessionId ?? null,
    title: header.title ?? null,
    cwd: header.cwd ?? null,
    live: Boolean(record?.live),
    // running 才是“当前有 turn 在跑”；live 只表示 Agent 还驻留在内存里。
    running: false,
    persisted: Boolean(record?.persisted),
    parentSession: header.parentSession ?? null,
    origin: header.origin ?? null,
    delegationDepth: Number(header.delegationDepth ?? 0),
    isSubagent: !isMainSession(record),
    updatedAt: header.updatedAt ?? header.time ?? null,
  }
}

/** 审批请求 → 手表能渲染的一行。注意：请求本身不带工具参数。 */
export function toPocketApproval(req, id) {
  return {
    id,
    tool: req?.toolName ?? null,
    reason: req?.reason ?? null,
    displayReason: req?.displayReason ?? null,
    callId: req?.callId ?? null,
  }
}

/**
 * 构造 `approval/request` waterfall 的 answerer。
 *
 * 语义（对应 DSH 的 approval seam）：
 *   - 没有 request id 的请求交给 next()，不拦截别人的请求
 *   - 有 id：先 open 槽位、广播给客户端，再等结果
 *   - 信号已 abort 且结果不是 allowed-once → 归一成 cancelled
 *   - 拿不到回答（超时/未知）时 DecisionBook 会给 unavailable，天然 fail closed
 *
 * @param {object} deps
 * @param {import('./pocket-core.js').DecisionBook} deps.book
 * @param {(event: object) => void} deps.broadcast
 * @param {(whatever: unknown) => unknown} [deps.next] 兜底委派
 */
export function makeApprovalAnswerer({ book, broadcast, onInvoke, shouldHandle, tickMs = 20_000 }) {
  return async function answer(req, next) {
    onInvoke?.(req)
    const nextOrNone = () => (typeof next === 'function' ? next() : 'unavailable')
    const id = String(req?.id ?? req?.requestId ?? '')
    if (!id) return nextOrNone()
    if (shouldHandle && !shouldHandle(req)) return nextOrNone()

    book.open(id)
    broadcast({ type: 'approval/requested', request: toPocketApproval(req, id) })

    let outcome
    for (;;) {
      outcome = await Promise.race([book.wait(id), tick(tickMs)])
      if (outcome !== 'tick') break
      if (req?.signal?.aborted) {
        book.decide(id, 'cancelled')
        continue
      }
      // 手机切后台/掉线：把这次审批还给桌面 UI，别卡在一个看不见的卡片上
      if (shouldHandle && !shouldHandle(req)) {
        outcome = 'delegate'
        break
      }
    }

    if (outcome === 'delegate') {
      book.decide(id, 'cancelled')
      return nextOrNone()
    }
    if (req?.signal?.aborted && outcome !== 'allowed-once') return 'cancelled'
    return outcome
  }
}

/** 一轮等待的节拍；unref 掉，别为了等审批把进程钉住。 */
function tick(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('tick'), ms)
    timer?.unref?.()
  })
}

/** 只取 type === 'text' 的片段：推理过程不进聊天记录。 */
function partText(part) {
  if (typeof part === 'string') return part
  if (part?.type === 'text' && typeof part.text === 'string') return part.text
  return ''
}

/** 把 content 数组拼成一段可显示文本。 */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(partText).filter(Boolean).join('\n').trim()
}

/** 兜底：从各种可能的形状里抽文本（不含 reasoning）。 */
export function extractText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return contentText(value)
  if (typeof value === 'object') {
    if (typeof value.text === 'string' && value.type !== 'reasoning') return value.text
    if (Array.isArray(value.content)) return contentText(value.content)
    if (value.message) return extractText(value.message)
  }
  return ''
}

/**
 * 把一条 session 事件压成聊天能显示的一行。
 * 真实形状（从 session JSONL 里核过）：
 *   user/message      { content: [{type:'text',text}] }
 *   assistant/message { message: { content: [{type:'reasoning'|'text', text}] } }
 *   tool/call         { callId, name, arguments }
 *   tool/result       { message: { content: [...] } }
 * 认不出来的类型返回 null —— 宁可少显示，也不要显示乱码。
 */
export function summarizeSessionEvent(event) {
  const type = String(event?.type ?? '')
  const data = event?.data ?? {}
  const seq = event?.seq ?? null
  const time = event?.time ?? null

  if (type === 'user/message') {
    // 只有真正的人写的才算聊天内容；runtime-context / skill-catalog /
    // plugin:hindsight / time-context 是系统注入，不该出现在对话里。
    const sourceKind = data.source?.kind
    if (sourceKind && sourceKind !== 'user') return null
    const text = contentText(data.content)
    return text ? { kind: 'user', text, seq, time } : null
  }
  if (type === 'assistant/message') {
    const text = contentText(data.message?.content)
    return text ? { kind: 'assistant', text, seq, time } : null
  }
  if (type === 'tool/call') {
    const rawArgs = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? '')
    return {
      kind: 'tool',
      text: '',
      name: data.name ?? data.toolName ?? data.tool ?? null,
      callId: data.callId ?? null,
      args: rawArgs ? rawArgs.slice(0, 200) : null,
      seq,
      time,
    }
  }
  if (type === 'tool/result') {
    const text = contentText(data.message?.content) || extractText(data)
    return { kind: 'tool-result', text: text.slice(0, 800), seq, time }
  }
  return null
}

// ---------------------------------------------------------------------------
// 用户提问（ask_user_question）
// ---------------------------------------------------------------------------

/**
 * 把 user-questions/request 压成手机能渲染的卡片。
 * 请求形状：{ questions:[{id, header?, question, options:[{label, description?, recommended?}], multiSelect?}],
 *            wait?: { callId, timed? }, agent?, signal }
 */
export function toPocketQuestion(req, id) {
  const questions = Array.isArray(req?.questions) ? req.questions : []
  return {
    id,
    sessionId: req?.agent?.session?.id ?? req?.agent?.session?.header?.id ?? null,
    timed: req?.wait?.timed === true,
    questions: questions.map((question) => ({
      id: String(question?.id ?? ''),
      header: typeof question?.header === 'string' ? question.header : null,
      question: String(question?.question ?? ''),
      multiSelect: question?.multiSelect === true,
      options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({
        label: String(option?.label ?? ''),
        description: typeof option?.description === 'string' ? option.description : null,
        recommended: option?.recommended === true,
      })).filter((option) => option.label),
    })),
  }
}

/**
 * 校验手机提交的答案：必须每个问题恰好一条，selected 只能选请求里出现过的标签，
 * custom 是补充文本。返回可以直接回给 waterfall 的 { answers }。
 */
export function normalizeQuestionAnswers(request, raw) {
  const answers = Array.isArray(raw?.answers) ? raw.answers : null
  if (!answers) throw new Error('missing-answers')
  if (answers.length !== request.questions.length) throw new Error('answers-count-mismatch')

  const byId = new Map(request.questions.map((question) => [question.id, question]))
  const seen = new Set()
  const normalized = []
  for (const answer of answers) {
    const id = String(answer?.id ?? '')
    const question = byId.get(id)
    if (!question) throw new Error(`unknown-question: ${id}`)
    if (seen.has(id)) throw new Error(`duplicate-answer: ${id}`)
    seen.add(id)

    const allowed = new Set(question.options.map((option) => option.label))
    const selected = Array.isArray(answer?.selected) ? answer.selected.map((item) => String(item)) : []
    for (const label of selected) {
      if (!allowed.has(label)) throw new Error(`option-not-offered: ${label}`)
    }
    if (question.multiSelect !== true && selected.length > 1) throw new Error(`single-choice-only: ${id}`)

    let custom
    if (answer?.custom !== undefined) {
      if (typeof answer.custom !== 'string') throw new Error('custom-not-text')
      const trimmed = answer.custom.trim()
      if (trimmed.length > 4000) throw new Error('custom-too-long')
      if (trimmed) custom = trimmed
    }
    if (selected.length === 0 && custom === undefined) {
      // 允许"跳过"：显式空答案表示跳过这道题
    }
    normalized.push(custom === undefined ? { id, selected } : { id, selected, custom })
  }
  return { answers: normalized }
}

/**
 * 把提问转发到手机。
 *
 * 只在「手机正开着 App」时接管（presence + 活跃订阅），否则直接 next()，
 * 让电脑界面照常弹卡片——不能因为配过对就把桌面 UI 的问题抢走。
 * 接管之后每隔 tickMs 重查一次 presence：手机退后台/掉线就交还给下一个 answerer。
 *
 * @param {object} deps
 * @param {import('./pocket-core.js').DecisionBook} deps.book
 * @param {(event: object) => void} deps.broadcast
 * @param {(req: object) => boolean} [deps.shouldHandle]
 * @param {number} [deps.tickMs]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [deps.timers]
 */
export function makeQuestionAnswerer({ book, broadcast, shouldHandle, tickMs = 20_000, timers } = {}) {
  const clock = timers ?? { setTimeout, clearTimeout }

  let counter = 0

  return async function answerQuestions(req, next) {
    const nextOrNone = () => (typeof next === 'function' ? next() : 'unavailable')
    // 阻塞式提问没有 wait.callId（只有限时提问才有），所以自己生成一个 id：
    // 手机端只需要一个能对应"这次提问"的键，答案不依赖它。
    const callId = String(req?.wait?.callId ?? '')
    const id = callId || `q-${Date.now().toString(36)}-${(counter += 1).toString(36)}`
    if (shouldHandle && !shouldHandle(req)) return nextOrNone()

    const request = toPocketQuestion(req, id)
    if (request.questions.length === 0 || request.questions.some((question) => !question.id || !question.question)) {
      return nextOrNone()
    }

    book.open(id)
    broadcast({ type: 'question/requested', request })

    if (req?.signal?.aborted) {
      book.decide(id, 'cancelled')
    }

    const waitNextTick = () => new Promise((resolve) => {
      const timer = clock.setTimeout(() => resolve('tick'), tickMs)
      timer?.unref?.()
    })

    let outcome
    for (;;) {
      outcome = await Promise.race([book.wait(id), waitNextTick()])
      if (outcome !== 'tick') break
      if (req?.signal?.aborted) {
        book.decide(id, 'cancelled')
        continue
      }
      // 手机不再前台：交还给桌面 UI，别让问题卡在一个看不见的地方
      if (shouldHandle && !shouldHandle(req)) {
        outcome = 'delegate'
        break
      }
    }

    if (outcome === 'delegate' || outcome === 'unavailable') {
      broadcast({ type: 'question/settled', id, outcome: 'delegated' })
      return nextOrNone()
    }
    if (outcome === 'cancelled') {
      broadcast({ type: 'question/settled', id, outcome: 'cancelled' })
      return 'cancelled'
    }
    broadcast({ type: 'question/settled', id, outcome: 'answered' })
    return outcome
  }
}
