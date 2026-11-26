/**
 * dsh-pocket-whale — Host half.
 *
 * 给手机 / 手表客户端的一个"窄"HTTP+SSE 面：只暴露抬腕场景需要的字段，
 * 不复制 dsh web 的 UI 协议。所有路由都是 exact Fetch 路由；按
 * api-remote-access 的契约，exact 路由不进 Gateway，对非 owner peer 一律 403，
 * 所以这一层天然只对 owner 开放。
 *
 * 状态（P0）：
 *   ✅ GET  /pocket/status    宿主基本信息
 *   ✅ GET  /pocket/sessions  最近会话摘要
 *   ✅ GET  /pocket/events    SSE：hello、approval/requested、approval/settled
 *   ✅ POST /pocket/answer    批准 / 拒绝（幂等，逻辑在 lib/pocket-core.js）
 *   ⬜ POST /pocket/say       需要 ctx.sessionController 的具体方法名，待确认
 *   ⬜ POST /pocket/stop      同上
 */

import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HandoffStore,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  collectCandidates,
  createBundle,
  loadPayloads,
  newId,
  parseHandoff,
} from './lib/handoff.js'
import { PairingGateway } from './lib/lan-gateway.js'
import {
  DECIDED_TTL_MS,
  DecisionBook,
  makeApprovalAnswerer,
  makeQuestionAnswerer,
  normalizeQuestionAnswers,
  sameQuestionAnswers,
  summarizeSessionEvent,
  isMainSession,
  toPocketApproval,
  toPocketSession,
} from './lib/pocket-core.js'

// Cordis 不允许访问未声明的服务，但用 ctx.get() 可以"不 inject 也读"。
// 这样 sessionQuery 缺失时插件照样激活，只是会话接口返回 503。
export const inject = ['webServer']

// 手机本机模式下，每个会话一个短编号文件夹：workspace/001、workspace/002…
// 文件夹备注（会话标题）写在可见的「会话备注.txt」里；隐藏 JSON 给 App 读。
const SESSION_NOTE_FILE = '会话备注.txt'
const SESSION_META_FILE = '.pocket-session.json'
const SESSION_DIR_RE = /^\d{3,4}$/

function cleanSessionTitle(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 80) : '新会话'
}

function sessionNoteText(title, number) {
  return `会话：${cleanSessionTitle(title)}\n编号：${number}\n\n这个文件夹是「口袋鲸」按会话自动建的；编号固定，备注会随会话标题更新。\n`
}

function writeSessionWorkspaceNote(dir, { title, number, sessionId }) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const note = sessionNoteText(title, number)
  const notePath = path.join(dir, SESSION_NOTE_FILE)
  try {
    const previous = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : ''
    if (previous !== note) fs.writeFileSync(notePath, note)
  } catch {}
  const meta = {
    sessionId: sessionId ?? null,
    number,
    title: cleanSessionTitle(title),
    updatedAt: new Date().toISOString(),
  }
  try { fs.writeFileSync(path.join(dir, SESSION_META_FILE), JSON.stringify(meta, null, 2) + '\n') } catch {}
}

function allocateSessionWorkspace(base) {
  let max = 0
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const match = SESSION_DIR_RE.exec(entry.name)
      if (match) max = Math.max(max, Number(match[1]))
    }
  } catch {}
  const number = String(max + 1).padStart(3, '0')
  const dir = path.join(base, number)
  fs.mkdirSync(dir, { recursive: true })
  return { number, dir }
}

const JSON_NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_NO_STORE)
  res.end(JSON.stringify(body))
}

function readRawBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}


/** 标题折叠结果可能直接是字符串，也可能是带 text/title 的对象。 */
function normalizeTitle(snap) {
  if (!snap) return null
  if (typeof snap === 'string') return snap
  if (typeof snap.title === 'string') return snap.title
  if (typeof snap.text === 'string') return snap.text
  if (typeof snap.value === 'string') return snap.value
  return null
}

export function apply(ctx) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const subscribers = new Set()

  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of subscribers) {
      try {
        res.write(frame)
      } catch {
        subscribers.delete(res)
      }
    }
  }

  const book = new DecisionBook({
    // 结算也走 approvalBroadcast：否则待批表里会留下已经答过的请求，
    // 手机重连时又补发一张幽灵卡片。
    onSettle: (id, outcome) => approvalBroadcast({ type: 'approval/settled', id, outcome }),
  })

  /** 审批事件同时记进待批表：SSE 重连时要补发，否则手机回前台就看不到那张卡。 */
  function approvalBroadcast(event) {
    if (event.type === 'approval/requested') pendingApprovals.set(event.request.id, event.request)
    else if (event.type === 'approval/settled') pendingApprovals.delete(event.id)
    broadcast(event)
  }

  // 手机是否正开着 App。只有前台才接管 ask_user_question：
  // 否则用户在电脑前，问题会被一条看不见的手机卡片抢走。
  // A 模式（宿主就在手机里）没有第二块屏幕可接手：手机切后台时问题/审批
  // 应该留在原地等用户回来，而不是"交还给"一个没人看的桌面 UI。
  const LOCALLY_HOSTED = process.env.DSH_POCKET_LOCAL_HOST === '1'
  const PRESENCE_TTL_MS = 120_000
  let presence = { foreground: false, at: 0 }
  function phoneIsForeground() {
    return presence.foreground && Date.now() - presence.at < PRESENCE_TTL_MS
  }

  const questionBook = new DecisionBook()
  const pendingQuestions = new Map()
  const pendingApprovals = new Map()
  /** 已结算但没进 DecisionBook 的结果（转交桌面/取消），HTTP 侧要给明确答复。 */
  const settledQuestions = new Map()
  const questionStats = { asked: 0, answered: 0, delegated: 0 }

  /** 提问相关事件同时进「待答表」，HTTP 侧要用它校验答案。 */
  function questionBroadcast(event) {
    if (event.type === 'question/requested') {
      pendingQuestions.set(event.request.id, event.request)
      questionStats.asked += 1
    } else if (event.type === 'question/settled') {
      pendingQuestions.delete(event.id)
      if (event.outcome) {
        const now = Date.now()
        for (const [id, seen] of settledQuestions) {
          if (now - seen.at > DECIDED_TTL_MS) settledQuestions.delete(id)
        }
        settledQuestions.set(event.id, { outcome: event.outcome, at: now })
      }
      if (event.outcome === 'answered') questionStats.answered += 1
      if (event.outcome === 'delegated') questionStats.delegated += 1
    }
    broadcast(event)
  }

  // 问题转交前的 presence recheck 间隔；联调/测试可注入，避免真等 20 秒。
  const QUESTION_TICK_MS = Number(process.env.DSH_POCKET_QUESTION_TICK_MS) > 0
    ? Number(process.env.DSH_POCKET_QUESTION_TICK_MS)
    : 20_000
  const answerQuestions = makeQuestionAnswerer({
    book: questionBook,
    broadcast: questionBroadcast,
    tickMs: QUESTION_TICK_MS,
    // A 模式没有别的 answerer 可转交：手机切后台就继续等，SSE 重连时会补发
    shouldHandle: () => LOCALLY_HOSTED || (subscribers.size > 0 && phoneIsForeground()),
  })
  // 必须 prepend：界面插件的 answerer 会一直等浏览器里的回答，不会调用 next()，
  // 排在它后面就永远收不到提问（Approval 同理，见下）。
  const disposeQuestions = ctx.on('user-questions/request', answerQuestions, { prepend: true })

  // UNVERIFIED: waterfall 的 this 是 Scoped<Agent>，这里挂在根 context 上，
  // 需要一次真实审批确认能收到 agent 作用域的事件。
  // 联调用：记录监听器被调用了几次，便于一次请求就能判断"有没有进到我们这里"。
  const stats = { approvalsSeen: 0 }
  // 把会话事件实时转发给客户端：这是"看着 agent 干活"的关键。
  // session/event 是同步 emit，签名 (session, event)，this 绑定到 Scoped<Session>。
  let lastSessionsHint = 0
  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    // 任何会话事件都可能改变列表（新会话、标题、运行状态），限流地提醒客户端刷新
    const now = Date.now()
    if (now - lastSessionsHint > 2000) {
      lastSessionsHint = now
      broadcast({ type: 'sessions/changed' })
    }
    const item = summarizeSessionEvent(event)
    if (!item) return
    const sessionId = session?.id ?? event?.sessionId ?? null
    broadcast({ type: 'session/event', sessionId, item })
  })

  // 调试路由用：临时绕过"手机在线且前台"的门控
  let approvalDebugForce = 0
  const approvalGate = () => approvalDebugForce > 0 || LOCALLY_HOSTED || (subscribers.size > 0 && phoneIsForeground())

  const answer = makeApprovalAnswerer({
    book,
    broadcast: approvalBroadcast,
    shouldHandle: approvalGate,
    onInvoke: () => {
      stats.approvalsSeen += 1
    },
  })
  // prepend 的理由和提问一样：界面插件的 answerer 不调用 next()，排在后面收不到事件。
  // 门控保证手机不在手里时审批仍然走桌面 UI。
  const disposeApproval = ctx.on('approval/request', answer, { prepend: true })

  /** 重复注册（热重装时旧实例还在）不炸掉整个插件，只记一条警告。 */
  function safeRegister(route) {
    try {
      return ctx.webServer.register(route)
    } catch (error) {
      ctx.logger?.warn?.(`pocket-whale: route ${route.path} already registered: ${error?.message ?? error}`)
      return () => {}
    }
  }

  // 接力包的落盘目录：和配对设备表放在同一个 DSH_HOME 下
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const handoffStore = new HandoffStore({ dir: path.join(dshHome, 'handoff') })
  handoffStore.sweep()

  // MARK: 反向接力（手机 → 电脑）的接收状态机
  //
  // 处理顺序：already-started → 恢复未完成的启动 → 落盘 + 建会话 + 启动。
  // 回执（received.json）在「建会话之后、prompt 之前」原子写入，这样：
  //   - 并发/串行重传都能看到同一个 sessionId；
  //   - 崩溃在 prompt 之前 → 重传只恢复启动，不重复建会话；
  //   - prompt 用固定 requestId（DSH 侧幂等）→ 即使上次其实已经入队，也不会重复执行计划。
  const receiveInFlight = new Map()

  function receiveInboxRoot() {
    return process.env.DSH_POCKET_INBOX ?? path.join(os.homedir(), 'Documents', 'DSH 接力')
  }

  function writeJsonAtomic(filePath, value) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, filePath)
  }

  function readReceiveMeta(metaPath) {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch {
      return null
    }
  }

  /** 把包里的文件按相对路径落盘；含子目录时逐级建目录（issue #2）。 */
  function writeHandoffFiles(dir, id, parsed) {
    const root = path.resolve(dir)
    for (const file of parsed.files) {
      const target = path.resolve(root, ...file.name.split('/'))
      const inside = path.relative(root, target)
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
        throw new Error(`file-not-allowed: ${file.name}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.writeFileSync(target, file.data, { mode: 0o600 })
    }
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(parsed.manifest, null, 2), { mode: 0o600 })
    // 交接说明用 handoff-<id>.md：说明正文里让 agent 读的就是这个名字。
    // 另存一份 handoff.md，方便用户直接打开。
    fs.writeFileSync(path.join(root, 'handoff.md'), parsed.brief, { mode: 0o600 })
    fs.writeFileSync(path.join(root, `handoff-${id}.md`), parsed.brief, { mode: 0o600 })
  }

  /** 崩溃恢复：create 成功但 received.json 还没写时，按目录找回已经建好的会话。 */
  async function findSessionForDir(dir) {
    const query = ctx.get('sessionQuery')
    if (!query?.listSessions) return null
    try {
      const records = (await query.listSessions()) ?? []
      const found = records.find((record) => {
        const header = record?.header ?? {}
        return header.cwd === dir && (header.id ?? header.sessionId)
      })
      return found ? (found.header.id ?? found.header.sessionId) : null
    } catch {
      return null
    }
  }

  function handoffKickoff(id, parsed) {
    const title = parsed.manifest.session?.title ?? '手机接力'
    return [
      `我在手机上把计划定好了，通过「接力」发到这台电脑：${title}。`,
      `交接说明是当前目录的 handoff-${id}.md，计划在「手机端定好的计划」一节。`,
      '先读交接说明和计划，然后按计划开始做；需要我确认的直接用 ask_user_question 问我。',
    ].join('\n')
  }

  /** 启动（或恢复启动）计划。失败也返回 200 + task.status，让手机能区分「文件到了」和「计划跑了」。 */
  async function startHandoffTask(meta, parsed, metaPath) {
    const controller = ctx.get('sessionController')
    const id = meta.id
    const requestId = meta.task?.requestId ?? `pocket-handoff-${id}`
    const attempts = Number(meta.task?.attempts ?? 0) + 1
    try {
      await controller.prompt({
        requestId,
        sessionId: meta.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: handoffKickoff(id, parsed) }],
      }, AbortSignal.timeout(60_000))
      meta.task = { status: 'started', requestId, attempts, startedAt: Date.now() }
    } catch (error) {
      const name = String(error?.name ?? '')
      const uncertain = name === 'TimeoutError' || name === 'AbortError'
      meta.task = {
        status: uncertain ? 'unknown' : 'failed',
        requestId,
        attempts,
        error: String(error?.message ?? error),
      }
      ctx.logger?.warn?.(`pocket-whale: handoff prompt ${meta.task.status}: ${meta.task.error}`)
    }
    writeJsonAtomic(metaPath, meta)
    return { ok: true, ...meta }
  }

  async function receiveBundle(parsed) {
    const controller = ctx.get('sessionController')
    const id = parsed.manifest.id
    const dir = path.join(receiveInboxRoot(), id)
    const metaPath = path.join(dir, 'received.json')

    const existing = readReceiveMeta(metaPath)
    // 已成功处理过：只回执，不再建会话/不再提交计划。
    if (existing?.sessionId && existing?.task?.status === 'started') {
      return { status: 200, body: { ok: true, replayed: true, ...existing } }
    }
    // 兼容旧版回执（没有 task 字段）：旧版把 prompt 错误吞掉了，无法判断计划是否
    // 真的启动。这里用同一个 requestId 再试一次——DSH 的 prompt 按 requestId 幂等，
    // 已经入队过就只返回 accepted，不会重复执行；没入队的正好补上（issue #3 恢复）。
    if (existing?.sessionId && !existing.task) {
      existing.task = { status: 'starting', requestId: `pocket-handoff-${id}`, attempts: 0 }
      return { status: 200, body: await startHandoffTask(existing, parsed, metaPath) }
    }
    // 会话已建但任务没启动成功：只恢复启动，不重复落盘、不重复建会话。
    if (existing?.sessionId) {
      return { status: 200, body: await startHandoffTask(existing, parsed, metaPath) }
    }

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeHandoffFiles(dir, id, parsed)

    // create 之后、回执写入之前崩溃：目录里已经有收到文件的痕迹，按 cwd 找回会话。
    let sessionId = await findSessionForDir(dir)
    if (!sessionId) {
      const created = await controller.create({ cwd: dir })
      sessionId = created?.sessionId
    }
    if (!sessionId) throw new Error('create-session-failed')

    const meta = {
      id,
      sessionId,
      cwd: dir,
      files: parsed.files.map((file) => file.name),
      receivedAt: Date.now(),
      task: { status: 'starting', requestId: `pocket-handoff-${id}`, attempts: 0 },
    }
    writeJsonAtomic(metaPath, meta)
    return { status: 200, body: await startHandoffTask(meta, parsed, metaPath) }
  }

  /** 读一个会话的 header / 标题 / 事件；sessionId 省略时用最近一个带 cwd 的会话。 */
  async function readSessionInfo(sessionId) {
    const query = ctx.get('sessionQuery')
    if (!query?.readSession) throw new Error('session-query unavailable')

    let id = String(sessionId ?? '')
    let live = false
    let records = []
    try {
      records = (await query.listSessions?.()) ?? []
    } catch {}
    if (!id) {
      const found = records.filter(isMainSession).find((record) => record?.header?.cwd)
      id = found?.header?.id ?? ''
    }
    if (!id) throw new Error('no-session')

    const snapshot = await query.readSession(id)
    const header = snapshot?.session ?? {}
    live = Boolean(records.find((record) => (record?.header?.id ?? record?.header?.sessionId) === id)?.live)
    let title = null
    try {
      title = normalizeTitle(await query.readTitle?.(id))
    } catch {}
    return { id, header, title, events: snapshot?.events ?? [], live }
  }

  /** 会话记录的 cwd 可能已经不存在（App 重装后沙盒路径会变）；退回宿主自己的 cwd。 */
  function usableCwd(recorded) {
    if (recorded && fs.existsSync(recorded)) return recorded
    try {
      return fs.existsSync(process.cwd()) ? process.cwd() : null
    } catch {
      return null
    }
  }

  function sendHandoffFile(res, buffer, filename) {
    res.writeHead(200, {
      'content-type': 'application/x-pocket-handoff',
      'content-length': buffer.length,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    })
    res.end(buffer)
  }

  const disposers = [
    safeRegister({
      kind: 'exact',
      path: '/pocket/status',
      handler(_req, res) {
        sendJson(res, 200, {
          ok: true,
          service: 'pocket-whale',
          // version = 安装包版本；protocolVersion = 接力/HTTP 字段约定版本。
          version: PLUGIN_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          profile: process.env.DSH_PROFILE ?? null,
          features: {
            sessions: true,
            events: true,
            answer: true,
            say: true,
            stop: true,
            newSession: true,
            handoff: true,
            handoffReceive: true,
            questions: true,
            // 宿主有没有装语音转写插件（sensevoice 那套）；没有就别指望电脑端转写
            voice: Boolean(ctx.get('speechToText')),
            hostTranscribe: Boolean(ctx.get('speechToText')?.transcribe),
          },
          origin: (() => { try { return ctx.webServer?.getOrigin?.() ?? null } catch { return null } })(),
          lanPort: gateway?.port ?? null,
          services: {
            sessionQuery: Boolean(ctx.get('sessionQuery')),
            sessionController: Boolean(ctx.get('sessionController')),
          },
          stats,
          pending: book.pendingCount,
          questions: { pending: pendingQuestions.size, ...questionStats, phoneForeground: phoneIsForeground() },
        })
      },
    }),

    safeRegister({
      kind: 'exact',
      path: '/pocket/sessions',
      async handler(_req, res) {
        try {
          const query = ctx.get('sessionQuery')
          if (!query?.listSessions) {
            return sendJson(res, 503, { ok: false, error: 'session-query service unavailable' })
          }
          const records = (await query.listSessions()).filter(isMainSession)
          const sessions = records.map(toPocketSession)

          // 标题是单独 fold 出来的（session-title），列表里没有，要逐条读。
          // 只给最近 20 条补标题：手表上本来也只显示前几条。
          if (typeof query.readTitle === 'function') {
            const head = sessions.slice(0, 20)
            await Promise.all(head.map(async (row) => {
              if (!row.id) return
              try {
                const snap = await query.readTitle(row.id)
                row.title = normalizeTitle(snap)
              } catch {
                row.title = null
              }
            }))
          }

          // 手机本机模式：把会话标题同步到编号文件夹的「会话备注.txt」。
          if (process.env.DSH_POCKET_LOCAL_HOST === '1') {
            const base = process.cwd()
            for (const row of sessions) {
              if (!row.cwd || !row.id) continue
              const number = path.basename(row.cwd)
              if (!SESSION_DIR_RE.test(number) || path.dirname(row.cwd) !== base) continue
              try {
                writeSessionWorkspaceNote(row.cwd, { title: row.title, number, sessionId: row.id })
              } catch {}
            }
          }

          // 过滤空白会话：iPhone/手表上新建但没说话的会话不该长期占着列表
          // （DSH 桌面端也不显示这类会话）。只对没有标题的前 20 条做额外检查，控制开销。
          const visible = []
          let checked = 0
          for (const row of sessions) {
            if (row.title || checked >= 20) { visible.push(row); continue }
            checked += 1
            try {
              const snapshot = await query.readSession(row.id)
              const hasContent = (snapshot?.events ?? []).some((event) => summarizeSessionEvent(event) !== null)
              if (hasContent) visible.push(row)
            } catch {
              visible.push(row)
            }
          }

          // 用 sessionController.state 的 running 判断“当前 turn 是否在跑”；
          // live 只是 Agent 驻留，不能拿来驱动后台任务/运行中状态。
          const controller = ctx.get('sessionController')
          if (controller?.state) {
            await Promise.all(visible.map(async (row) => {
              if (!row.id) return
              try {
                const state = await controller.state({ sessionId: row.id })
                row.running = Boolean(state?.running ?? state?.active)
              } catch {}
            }))
          }
          sendJson(res, 200, { ok: true, sessions: visible })
        } catch (error) {
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    safeRegister({
      kind: 'exact',
      path: '/pocket/events',
      handler(req, res) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write(`data: ${JSON.stringify({ type: 'hello', pending: book.pendingCount })}\n\n`)
        // 重连后补发还没答的审批/问题：否则手机切前台/断线重连就再也看不到那张卡了
        for (const request of pendingApprovals.values()) {
          res.write(`data: ${JSON.stringify({ type: 'approval/requested', request })}\n\n`)
        }
        for (const request of pendingQuestions.values()) {
          res.write(`data: ${JSON.stringify({ type: 'question/requested', request })}\n\n`)
        }
        subscribers.add(res)

        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            clearInterval(heartbeat)
            subscribers.delete(res)
          }
        }, 25_000)
        heartbeat.unref?.()

        const cleanup = () => {
          clearInterval(heartbeat)
          subscribers.delete(res)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    }),

    safeRegister({
      kind: 'exact',
      path: '/pocket/answer',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }

        const id = String(body?.id ?? '')
        const decision = body?.decision === 'allow' ? 'allowed-once' : 'rejected'
        if (!id) return sendJson(res, 400, { ok: false, error: 'missing-id' })

        // 幂等：重复提交返回同一结果，而不是二次决策。
        const result = book.decide(id, decision)
        if (result.status === 'replayed') {
          return sendJson(res, 200, { ok: true, id, outcome: result.outcome, replayed: true })
        }
        if (result.status === 'unknown') {
          return sendJson(res, 409, { ok: false, error: 'unknown-or-expired-request', id })
        }
        return sendJson(res, 200, { ok: true, id, outcome: result.outcome })
      },
    }),

    // 续一句 / 新开一轮。签名来自 dsh-api-session-controller 的 SessionPromptRequest：
    // { requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text',text}] }
    safeRegister({
      kind: 'exact',
      path: '/pocket/say',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const controller = ctx.get('sessionController')
        if (!controller?.prompt) return sendJson(res, 503, { ok: false, error: 'session-controller unavailable' })

        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const sessionId = String(body?.sessionId ?? '')
        const text = String(body?.text ?? '')
        if (!sessionId) return sendJson(res, 400, { ok: false, error: 'missing-sessionId' })
        if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'empty-text' })

        const signal = AbortSignal.timeout(60_000)
        try {
          const value = await controller.prompt(
            {
              requestId: `pocket-${sessionId}-${Date.now()}`,
              sessionId,
              mode: body?.mode === 'steer' ? 'steer' : 'queue',
              content: [{ type: 'text', text }],
              clientTimeZone: body?.clientTimeZone,
            },
            signal,
          )
          sendJson(res, 200, { ok: true, value })
        } catch (error) {
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // 中断当前一轮。签名：{ sessionId }。
    safeRegister({
      kind: 'exact',
      path: '/pocket/stop',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const controller = ctx.get('sessionController')
        if (!controller?.cancel) return sendJson(res, 503, { ok: false, error: 'session-controller unavailable' })

        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const sessionId = String(body?.sessionId ?? '')
        if (!sessionId) return sendJson(res, 400, { ok: false, error: 'missing-sessionId' })
        try {
          const value = controller.cancel({ sessionId })
          sendJson(res, 200, { ok: true, value })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // 读一段会话正文。默认给最近 80 条可显示事件。
    safeRegister({
      kind: 'exact',
      path: '/pocket/messages',
      async handler(req, res) {
        const query = ctx.get('sessionQuery')
        if (!query?.readSession) return sendJson(res, 503, { ok: false, error: 'session-query unavailable' })

        const url = new URL(req.url ?? '/', 'http://pocket.local')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 80) || 80, 400)
        // before=<seq>：只要 seq 小于它的事件，用于向上翻历史
        const beforeRaw = url.searchParams.get('before')
        const before = beforeRaw === null ? null : Number(beforeRaw)
        if (!sessionId) return sendJson(res, 400, { ok: false, error: 'missing-sessionId' })
        if (before !== null && !Number.isFinite(before)) {
          return sendJson(res, 400, { ok: false, error: 'invalid-before' })
        }

        try {
          const snapshot = await query.readSession(sessionId)
          const visible = snapshot.events
            .map(summarizeSessionEvent)
            .filter(Boolean)
            .filter((item) => (before === null || (item.seq ?? 0) < before))
          const items = visible.slice(-limit)
          sendJson(res, 200, {
            ok: true,
            sessionId,
            total: snapshot.events.length,
            hasMore: visible.length > items.length,
            oldestSeq: items.length > 0 ? items[0].seq ?? null : null,
            items,
          })
        } catch (error) {
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // 语音转写：手机上录一段 WAV（base64）发过来，交给宿主的语音插件识别。
    safeRegister({
      kind: 'exact',
      path: '/pocket/transcribe',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const speech = ctx.get('speechToText')
        if (!speech?.resolve || !speech?.transcribe) {
          return sendJson(res, 503, { ok: false, error: 'no-speech-plugin' })
        }

        let body
        try {
          // 30 秒 16kHz 单声道约 960KB，base64 后约 1.3MB；留足余量
          body = await readBody(req, 8 * 1024 * 1024)
        } catch (error) {
          const tooLarge = String(error?.message ?? error) === 'body-too-large'
          return sendJson(res, tooLarge ? 413 : 400, {
            ok: false,
            error: tooLarge ? 'audio-too-large' : String(error?.message ?? error),
          })
        }
        const audio = Buffer.from(String(body?.audioBase64 ?? ''), 'base64')
        if (audio.length === 0) return sendJson(res, 400, { ok: false, error: 'empty-audio' })

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('transcribe timeout')), 60000)
        try {
          const spec = speech.resolve({
            audio: new Uint8Array(audio),
            ...(typeof body?.language === 'string' && body.language ? { language: body.language } : {}),
          })
          const transcript = await speech.transcribe(spec, controller.signal)
          sendJson(res, 200, {
            ok: true,
            text: transcript?.text ?? '',
            audioSeconds: transcript?.audioSeconds ?? null,
            inferenceSeconds: transcript?.inferenceSeconds ?? null,
          })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
        } finally {
          clearTimeout(timer)
        }
      },
    }),

    // 新建会话。cwd 省略时沿用最近一个会话的目录。
    safeRegister({
      kind: 'exact',
      path: '/pocket/new',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const controller = ctx.get('sessionController')
        if (!controller?.create) return sendJson(res, 503, { ok: false, error: 'session-controller unavailable' })

        let body = {}
        try { body = await readBody(req) } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }

        let cwd = typeof body?.cwd === 'string' && body.cwd ? body.cwd : null
        let workspaceNumber = null
        // 手机本机模式：每个会话一个短编号文件夹（001、002…），不继承上一个会话的目录。
        if (!cwd && process.env.DSH_POCKET_LOCAL_HOST === '1') {
          try {
            const ws = allocateSessionWorkspace(process.cwd())
            cwd = ws.dir
            workspaceNumber = ws.number
            writeSessionWorkspaceNote(ws.dir, { title: '新会话', number: ws.number, sessionId: null })
          } catch (error) {
            ctx.logger?.warn?.(error)
          }
        }
        if (!cwd) {
          try {
            const query = ctx.get('sessionQuery')
            const records = (await query?.listSessions?.()) ?? []
            cwd = records.find((r) => r?.header?.cwd)?.header?.cwd ?? null
          } catch {}
        }
        // 继承来的目录可能已经不存在（App 重装后沙盒路径会变、用户删了目录）。
        // 这种情况下宁可用宿主自己的 cwd（iOS 上就是 workspace），
        // 也不要创建一个所有文件工具都读不到的会话。
        if (!cwd || !fs.existsSync(cwd)) {
          try {
            if (fs.existsSync(process.cwd())) cwd = process.cwd()
          } catch {}
        }

        try {
          const value = await controller.create(cwd ? { cwd } : {})
          if (workspaceNumber && cwd) {
            writeSessionWorkspaceNote(cwd, { title: '新会话', number: workspaceNumber, sessionId: value?.sessionId ?? null })
          }
          sendJson(res, 200, {
            ok: true,
            sessionId: value?.sessionId ?? null,
            agentPreset: value?.agentPreset ?? null,
            ...(workspaceNumber ? { workspace: { number: workspaceNumber, cwd } } : {}),
          })
        } catch (error) {
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // 可用模型目录：来自宿主的 sessionController.modelCatalog()，
    // 包含 DeepSeek 官方适配器和已配置的 pi-ai 服务商。
    safeRegister({
      kind: 'exact',
      path: '/pocket/models',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const controller = ctx.get('sessionController')
        if (!controller?.modelCatalog) return sendJson(res, 503, { ok: false, error: 'session-controller unavailable' })
        try {
          const catalog = await controller.modelCatalog()
          sendJson(res, 200, { ok: true, ...catalog })
        } catch (error) {
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // 读某个会话当前的模型选择（modelSelection 投影）。
    safeRegister({
      kind: 'exact',
      path: '/pocket/model',
      async handler(req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (!sessionId) return sendJson(res, 400, { ok: false, error: 'missing-sessionId' })
          try {
            const sessions = ctx.get('sessions')
            const binding = sessions?.binding?.(sessionId)
            const projection = binding?.session?.projections?.faceOf?.('modelSelection')
            const state = projection?.getSnapshot?.()
            const selection = state?.next ?? state?.lastUsed ?? null
            sendJson(res, 200, { ok: true, selection })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const controller = ctx.get('sessionController')
        if (!controller?.selectModel) return sendJson(res, 503, { ok: false, error: 'session-controller unavailable' })
        let body
        try { body = await readBody(req) } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const sessionId = String(body?.sessionId ?? '')
        const provider = String(body?.provider ?? '')
        const model = String(body?.model ?? '')
        if (!sessionId) return sendJson(res, 400, { ok: false, error: 'missing-sessionId' })
        if (!provider || !model) return sendJson(res, 400, { ok: false, error: 'missing-model' })
        try {
          const value = await controller.selectModel({
            sessionId,
            provider,
            model,
            ...(typeof body?.reasoningEffort === 'string' && body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
          })
          sendJson(res, 200, { ok: true, value })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // 默认模型：新会话没有显式模型时用它；由 DSH 的 agentDefaultModel 持久化。
    safeRegister({
      kind: 'exact',
      path: '/pocket/default-model',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const defaults = ctx.get('agentDefaultModel')
        if (!defaults?.saveSelection) return sendJson(res, 503, { ok: false, error: 'default-model unavailable' })
        let body
        try { body = await readBody(req) } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const provider = String(body?.provider ?? '')
        const model = String(body?.model ?? '')
        if (!provider || !model) return sendJson(res, 400, { ok: false, error: 'missing-model' })
        const selection = {
          provider,
          model,
          ...(typeof body?.reasoningEffort === 'string' && body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
        }
        try {
          const llm = ctx.get('llm')
          if (llm?.resolveCallConfig) await llm.resolveCallConfig(selection)
          await defaults.saveSelection(selection)
          sendJson(res, 200, { ok: true, selection })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // ------------------------------------------------------------------
    // 手机端回答 ask_user_question
    // ------------------------------------------------------------------

    // App 前台心跳：决定提问要不要转发到手机（退到后台就还回桌面 UI）
    safeRegister({
      kind: 'exact',
      path: '/pocket/presence',
      async handler(req, res) {
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, foreground: phoneIsForeground(), at: presence.at })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        presence = { foreground: body?.foreground !== false, at: Date.now() }
        return sendJson(res, 200, { ok: true, foreground: presence.foreground, at: presence.at })
      },
    }),

    // 回答一组问题：{ id, answers: [{ id, selected: [label], custom? }] }
    safeRegister({
      kind: 'exact',
      path: '/pocket/question',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }

        const id = String(body?.id ?? '')
        if (!id) return sendJson(res, 400, { ok: false, error: 'missing-id' })

        // 先查已决表：结算时待答表会被清掉，只查待答表会把「主机已收到答案、
        // 但客户端丢了回执后又重试」误判成 409（issue #5）。
        const decision = questionBook.decisionOf(id)
        if (decision.status === 'decided') {
          if (sameQuestionAnswers(decision.outcome, body)) {
            return sendJson(res, 200, { ok: true, id, replayed: true })
          }
          return sendJson(res, 409, { ok: false, error: 'answer-already-settled', id })
        }

        const request = pendingQuestions.get(id)
        if (!request) {
          const settled = settledQuestions.get(id)
          if (settled?.outcome === 'delegated') {
            return sendJson(res, 409, { ok: false, error: 'question-delegated', id })
          }
          if (settled?.outcome === 'cancelled') {
            return sendJson(res, 409, { ok: false, error: 'question-cancelled', id })
          }
          return sendJson(res, 409, { ok: false, error: 'unknown-or-expired-question', id })
        }

        let batch
        try {
          batch = normalizeQuestionAnswers(request, body)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }

        const result = questionBook.decide(id, batch)
        if (result.status === 'replayed') {
          return sendJson(res, 200, { ok: true, id, replayed: true })
        }
        if (result.status === 'unknown') {
          return sendJson(res, 409, { ok: false, error: 'unknown-or-expired-question', id })
        }
        return sendJson(res, 200, { ok: true, id })
      },
    }),

    // ------------------------------------------------------------------
    // 接力：把电脑上没做完的轻办公文件 + 交接说明交给手机（docs/handoff.md）
    // ------------------------------------------------------------------

    safeRegister({
      kind: 'exact',
      path: '/pocket/handoff/candidates',
      async handler(req, res) {
        try {
          const url = new URL(req.url ?? '/', 'http://pocket.local')
          const info = await readSessionInfo(url.searchParams.get('sessionId'))
          const cwd = usableCwd(info.header.cwd)
          const folder = url.searchParams.get('path') ?? ''
          const files = collectCandidates({
            cwd,
            relative: folder,
            sessionCreatedAt: info.header.createdAt ?? 0,
          })
          sendJson(res, 200, {
            ok: true,
            session: { id: info.id, title: info.title, cwd, live: info.live },
            path: folder || null,
            files,
            limits: {
              maxFileBytes: MAX_FILE_BYTES,
              maxTotalBytes: MAX_TOTAL_BYTES,
              maxFiles: MAX_FILES,
            },
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    safeRegister({
      kind: 'exact',
      path: '/pocket/handoff/create',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }

        try {
          const info = await readSessionInfo(body?.sessionId)
          const cwd = usableCwd(info.header.cwd)
          if (!cwd) return sendJson(res, 400, { ok: false, error: 'session-has-no-cwd' })

          // 附件三态（issue #1）：
          //   省略 files          → 老调用者的约定：按推荐规则自动挑候选文件
          //   files: []           → 用户明确取消了所有勾选：零附件，纯计划也能发
          //   files: ['a','b']    → 只打这几个（只含所选文件）
          const request = body ?? {}
          const filesFieldPresent = Object.prototype.hasOwnProperty.call(request, 'files')
          const plan = typeof request.plan === 'string' ? request.plan.slice(0, 8000) : ''
          const note = typeof request.note === 'string' ? request.note : ''
          let paths
          if (filesFieldPresent) {
            if (!Array.isArray(request.files)) return sendJson(res, 400, { ok: false, error: 'bad-files' })
            paths = request.files
              .filter((name) => typeof name === 'string' && name.trim())
              .map((name) => name.replaceAll('\\', '/'))
          } else {
            const candidates = collectCandidates({ cwd, sessionCreatedAt: info.header.createdAt ?? 0 })
            const recommended = candidates.filter((file) => file.recommended)
            paths = (recommended.length > 0 ? recommended : candidates.slice(0, 5)).map((file) => file.path)
            if (paths.length === 0) return sendJson(res, 400, { ok: false, error: 'no-candidate-files' })
          }
          // 显式零附件 + 没有计划也没有备注：允许发也没有意义，给个明确错误。
          if (paths.length === 0 && !plan.trim() && !note.trim()) {
            return sendJson(res, 400, { ok: false, error: 'no-files-or-plan' })
          }

          const files = paths.length === 0 ? [] : loadPayloads({ cwd, paths })
          const now = Date.now()
          const id = newId(now)
          const origin = String(request.origin ?? '') || (() => {
            try { return ctx.webServer?.getOrigin?.() ?? null } catch { return null }
          })()
          const { manifest, digest, tar } = createBundle({
            id,
            now,
            session: { id: info.id, cwd, live: info.live },
            title: info.title ?? '',
            events: info.events,
            files,
            note,
            direction: request.direction === 'to-desktop' ? 'to-desktop' : 'to-phone',
            plan,
            source: { origin },
          })
          handoffStore.save(manifest, tar)
          sendJson(res, 200, {
            ok: true,
            bundle: {
              ...manifest,
              bytes: tar.length,
              downloadPath: `/pocket/handoff/file?id=${id}`,
            },
            digest,
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    // 反向接力：手机把「计划 + 文件」推到电脑，电脑解包后直接开一个会话按计划干活。
    //
    // 回执语义（issue #3）：文件接收结果和任务启动结果分开表达。
    //   ok:true + task.status:'started'  = 文件已落盘，计划已交给 agent
    //   ok:true + task.status:'failed'   = 文件已落盘，但计划没启动（重传会恢复）
    //   ok:true + task.status:'unknown'  = 启动结果未知（超时），重传用同一个
    //                                      requestId 幂等恢复，不会重复执行计划
    //   replayed:true + task.status:'started' = 这个包之前已经成功处理过
    safeRegister({
      kind: 'exact',
      path: '/pocket/handoff/receive',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const controller = ctx.get('sessionController')
        if (!controller?.create) return sendJson(res, 503, { ok: false, error: 'session-controller unavailable' })

        let raw
        try {
          raw = await readRawBody(req, 60 * 1024 * 1024 + 1024 * 1024)
        } catch (error) {
          const tooLarge = String(error?.message ?? error) === 'body-too-large'
          return sendJson(res, tooLarge ? 413 : 400, { ok: false, error: String(error?.message ?? error) })
        }

        let parsed
        try {
          parsed = parseHandoff(raw)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }

        const id = parsed.manifest.id
        // 同一个包并发到达：共享第一次的处理结果，避免两个请求都建会话（issue #4）。
        const running = receiveInFlight.get(id)
        if (running) {
          const shared = await running
          return sendJson(res, shared.status, { ...shared.body, coalesced: true })
        }

        const job = (async () => {
          try {
            return await receiveBundle(parsed)
          } catch (error) {
            ctx.logger?.warn?.(`pocket-whale: handoff receive failed: ${error?.message ?? error}`)
            return { status: 500, body: { ok: false, error: String(error?.message ?? error) } }
          }
        })()
        receiveInFlight.set(id, job)
        try {
          const result = await job
          sendJson(res, result.status, result.body)
        } finally {
          receiveInFlight.delete(id)
        }
      },
    }),

    safeRegister({
      kind: 'exact',
      path: '/pocket/handoff/bundles',
      handler(_req, res) {
        try {
          handoffStore.sweep()
          sendJson(res, 200, { ok: true, bundles: handoffStore.list() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),

    safeRegister({
      kind: 'exact',
      path: '/pocket/handoff/file',
      async handler(req, res) {
        const url = new URL(req.url ?? '/', 'http://pocket.local')
        const id = url.searchParams.get('id') ?? ''

        if (req.method === 'DELETE') {
          const removed = handoffStore.remove(id)
          return sendJson(res, removed ? 200 : 404, { ok: removed })
        }
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })

        try {
          const { tar } = handoffStore.read(id)
          sendHandoffFile(res, tar, `handoff-${id}.pockethandoff`)
        } catch {
          sendJson(res, 404, { ok: false, error: 'bundle-not-found' })
        }
      },
    }),

    // 仅用于联调：直接触发 approval/request 瀑布，绕开 policy 的 never 短路，
    // 用来验证"根 context 上的监听器能否收到该事件并回答"。
    safeRegister({
      kind: 'exact',
      path: '/pocket/debug/approval',
      async handler(req, res) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30_000)
        timer.unref?.()
        approvalDebugForce += 1
        try {
          const body = await readBody(req).catch(() => ({}))
          const id = `debug-${Date.now()}`
          // ctx.waterfall 的约定：最后一个参数是"最内层的 next"。
          // 不传就会让链上任何一个调用 next() 的监听器炸 "next is not a function"。
          const outcome = await ctx.waterfall(
            'approval/request',
            {
              id,
              toolName: body?.tool ?? 'bash',
              reason: body?.reason ?? 'pocket self-test',
              signal: controller.signal,
            },
            async () => 'unavailable',
          )
          sendJson(res, 200, { ok: true, id, outcome, approvalsSeen: stats.approvalsSeen })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        } finally {
          clearTimeout(timer)
          approvalDebugForce = Math.max(0, approvalDebugForce - 1)
        }
      },
    }),

    safeRegister({
      kind: 'exact',
      path: '/pocket/sweep',
      handler(_req, res) {
        sendJson(res, 200, { ok: true, expired: book.sweep(), pending: book.pendingCount })
      },
    }),
  ]

  // 局域网发现：客户端广播一句 DISCOVER，我们回自己的端口。
  // 用 UDP 广播而不是 Bonjour，是为了零依赖、也避免 mDNS 在不同网络下的坑。
  // 组播比 255.255.255.255 广播可靠：macOS 上发全网广播常报 EHOSTUNREACH。
  const DISCOVERY_GROUP = '239.255.42.99'
  const DISCOVERY_PORT = Number(process.env.DSH_POCKET_DISCOVERY_PORT ?? 48765)
  let discoverySocket = null
  try {
    if (process.env.DSH_POCKET_DISCOVERY === '0') throw new Error('disabled by DSH_POCKET_DISCOVERY=0')
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    discoverySocket.on('message', (msg, rinfo) => {
      if (!String(msg).startsWith('POCKETWHALE/1 DISCOVER')) return
      const port = ctx.webServer?.port ?? null
      if (!port) return
      let origin = null
      try { origin = ctx.webServer?.getOrigin?.() ?? null } catch {}
      // 只监听回环时，手机即使发现到这台机器也连不上，必须让客户端知道
      const loopbackOnly = !origin || /(^|\/\/)(127\.|localhost|\[::1\])/.test(origin)
      const reply = Buffer.from(JSON.stringify({
        service: 'pocket-whale',
        version: PLUGIN_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        port,
        origin,
        loopbackOnly,
        lanPort: gateway?.port ?? LAN_PORT,
        profile: process.env.DSH_PROFILE ?? null,
      }))
      discoverySocket.send(reply, rinfo.port, rinfo.address, () => {})
    })
    discoverySocket.on('error', (error) => {
      ctx.logger?.warn?.(`pocket-whale: discovery socket error: ${error?.message ?? error}`)
    })
    discoverySocket.bind(DISCOVERY_PORT, () => {
      // macOS 同时有 Wi-Fi / 以太网 / iPhone 热点时，只 join 默认接口会漏掉热点。
      // 每个非回环 IPv4 接口都加入一次组播，手机在任一网段都能发现宿主。
      let joined = 0
      try {
        for (const addresses of Object.values(os.networkInterfaces())) {
          for (const address of addresses ?? []) {
            if (address.family !== 'IPv4' || address.internal) continue
            try {
              discoverySocket.addMembership(DISCOVERY_GROUP, address.address)
              joined += 1
              ctx.logger?.info?.(`pocket-whale: discovery multicast on ${address.address}`)
            } catch (error) {
              ctx.logger?.warn?.(`pocket-whale: multicast join ${address.address} failed: ${error?.message ?? error}`)
            }
          }
        }
        if (joined === 0) discoverySocket.addMembership(DISCOVERY_GROUP)
        ctx.logger?.info?.(`pocket-whale: discovery on ${DISCOVERY_GROUP}:${DISCOVERY_PORT} (${joined} interfaces)`)
      } catch (error) {
        ctx.logger?.warn?.(`pocket-whale: multicast join failed: ${error?.message ?? error}`)
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(`pocket-whale: discovery unavailable: ${error?.message ?? error}`)
    discoverySocket = null
  }

  // 局域网网关：dsh web 只绑 127.0.0.1，手机连不上，所以自己开一个 0.0.0.0 的入口。
  // 默认开启，token 保护；配对必须由本机面板批准。DSH_POCKET_LAN=0 可关闭。
  const LAN_PORT = Number(process.env.DSH_POCKET_LAN_PORT ?? 48766)
  const lanEnabled = process.env.DSH_POCKET_LAN !== '0'
  let gateway = null
  // 已配对设备落盘，宿主重启后手机的 token 仍然有效
  const devicesFile = path.join(dshHome, 'pocket-devices.json')
  function loadDevices() {
    try {
      const raw = fs.readFileSync(devicesFile, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  function persistDevices(snapshot) {
    try {
      fs.mkdirSync(dshHome, { recursive: true })
      fs.writeFileSync(devicesFile, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
    } catch (error) {
      ctx.logger?.warn?.(`pocket-whale: cannot persist devices: ${error?.message ?? error}`)
    }
  }

  if (lanEnabled) {
    const knownDevices = loadDevices()
    gateway = new PairingGateway({
      // 插件被卸载/重载后 ctx 可能失效，这里必须兜住，否则每个请求都 500
      getTargetPort: () => {
        try {
          return ctx.webServer?.port ?? null
        } catch {
          return null
        }
      },
      devices: knownDevices,
      onChange: persistDevices,
    })
    // 端口被占通常是因为热重装：旧实例还占着 48766。
    // 这里只在同一个端口上重试一次——换端口会让已经记住旧地址的手机连到僵尸实例上。
    async function startGateway() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const port = await gateway.listen(LAN_PORT)
          ctx.logger?.info?.(`pocket-whale: LAN gateway on 0.0.0.0:${port} (token required)`)
          return
        } catch (error) {
          if (error?.code !== 'EADDRINUSE') {
            ctx.logger?.warn?.(`pocket-whale: LAN gateway failed: ${error?.message ?? error}`)
            gateway = null
            return
          }
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      ctx.logger?.warn?.(`pocket-whale: LAN port ${LAN_PORT} is still in use; gateway not started`)
      gateway = null
    }
    startGateway()
  }

  const sweeper = setInterval(() => book.sweep(), 60_000)
  sweeper.unref?.()

  ctx.logger?.info?.('pocket-whale: routes registered')

  return () => {
    clearInterval(sweeper)
    try { discoverySocket?.close() } catch {}
    gateway?.close().catch(() => {})
    for (const dispose of disposers) dispose()
    disposeApproval?.()
    disposeQuestions?.()
    disposeSessionEvents?.()
    questionBook.cancelAll()
    pendingQuestions.clear()
    pendingApprovals.clear()
    book.cancelAll()
    for (const res of subscribers) {
      try {
        res.end()
      } catch {}
    }
    subscribers.clear()
  }
}
