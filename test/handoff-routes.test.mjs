/**
 * 路由级集成测试：真插件 apply() + 假 ctx + 真 HTTP。
 * 覆盖「列候选 → 生成 → 列表 → 下载 → 删包」，以及非法输入的拒绝路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createBundle, listTar } from '../lib/handoff.js'
import { PLUGIN_VERSION, PROTOCOL_VERSION } from '../lib/handoff.js'

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 收集插件注册的 exact 路由，起一个最小 HTTP 服务器。hooks 可注入慢/失败的会话控制器。 */
async function mountPlugin({ cwd, home, hooks = {}, discoveryPort, hostPort } = {}) {
  process.env.DSH_HOME = home
  process.env.DSH_POCKET_LAN = '0'
  if (discoveryPort) {
    process.env.DSH_POCKET_DISCOVERY_PORT = String(discoveryPort)
    delete process.env.DSH_POCKET_DISCOVERY
  } else {
    process.env.DSH_POCKET_DISCOVERY = '0'
  }

  const routes = new Map()
  const createdAt = Date.now() - 120_000
  const events = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我排东京三天行程' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '第一天排好了，第二天还没定' }] } } },
  ]

  const calls = { created: [], prompts: [] }

  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      port: hostPort ?? 0,
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      getOrigin() {
        return null
      },
    },
    get(name) {
      if (name === 'sessionController') {
        return {
          async create(options) {
            calls.created.push(options)
            if (hooks.beforeCreate) await hooks.beforeCreate(options, calls)
            if (hooks.create) return hooks.create(options, calls)
            return { sessionId: `session-received-${calls.created.length}` }
          },
          async prompt(request) {
            calls.prompts.push(request)
            if (hooks.prompt) return hooks.prompt(request, calls)
            return { accepted: true }
          },
        }
      }
      if (name === 'sessionQuery') {
        return {
          async listSessions() {
            return [{ header: { id: 'session-a', cwd, createdAt }, live: false, persisted: true }]
          },
          async readSession(id) {
            if (id !== 'session-a') throw new Error('session-not-found')
            return { session: { id, cwd, createdAt, agentPreset: 'standard' }, events }
          },
          async readTitle() {
            return '东京三日行程'
          },
        }
      }
      return undefined
    },
    on() {
      return () => {}
    },
    async waterfall() {
      return 'unavailable'
    },
  }

  const { apply } = await import('../index.js')
  const dispose = apply(ctx)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://test.local')
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404)
      res.end('no route')
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    base,
    createdCwd: cwd,
    calls,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      dispose?.()
      delete process.env.DSH_POCKET_DISCOVERY_PORT
    },
  }
}

async function getJson(url, options) {
  const res = await fetch(url, options)
  const body = await res.json()
  return { status: res.status, body }
}

test('接力路由：候选 → 生成 → 列表 → 下载 → 删除', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  fs.writeFileSync(path.join(cwd, '东京行程.docx'), 'docx-body')
  fs.writeFileSync(path.join(cwd, '预算.xlsx'), 'xlsx-body')
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'notes')
  fs.writeFileSync(path.join(cwd, 'main.rs'), 'code')
  fs.writeFileSync(path.join(cwd, 'empty-dir'), '')

  const mounted = await mountPlugin({ cwd, home })
  try {
    const status = await getJson(`${mounted.base}/pocket/status`)
    assert.equal(PACKAGE_VERSION, '1.0.1', 'package.json 版本')
    assert.equal(status.body.version, PACKAGE_VERSION, '状态接口上报安装包版本')
    assert.equal(status.body.version, PLUGIN_VERSION, '状态版本来自同一个来源')
    assert.equal(status.body.protocolVersion, PROTOCOL_VERSION, '协议版本单独上报')
    assert.notEqual(status.body.version, status.body.protocolVersion, '安装包版本与协议版本必须区分')
    assert.equal(status.body.features.handoff, true)

    const candidates = await getJson(`${mounted.base}/pocket/handoff/candidates?sessionId=session-a`)
    assert.equal(candidates.status, 200)
    assert.equal(candidates.body.session.title, '东京三日行程')
    const names = candidates.body.files.map((file) => file.path)
    assert.deepEqual(new Set(names), new Set(['东京行程.docx', '预算.xlsx', 'notes.md', 'main.rs', 'empty-dir']))
    assert.equal(candidates.body.files.every((file) => file.recommended), true)

    // 不传 sessionId 时自动选最近的会话
    const auto = await getJson(`${mounted.base}/pocket/handoff/candidates`)
    assert.equal(auto.body.session.id, 'session-a')

    const created = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', note: '第二天要去看展' }),
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.bundle.files.length, 5, '默认带全部推荐文件')
    assert.match(created.body.digest, /帮我排东京三天行程/)
    assert.match(created.body.digest, /第二天要去看展/)
    assert.match(created.body.bundle.downloadPath, /^\/pocket\/handoff\/file\?id=/)

    const bundles = await getJson(`${mounted.base}/pocket/handoff/bundles`)
    assert.equal(bundles.body.bundles.length, 1)
    assert.equal(bundles.body.bundles[0].id, created.body.bundle.id)

    const download = await fetch(`${mounted.base}${created.body.bundle.downloadPath}`)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'application/x-pocket-handoff')
    const tar = Buffer.from(await download.arrayBuffer())
    assert.equal(tar.length, created.body.bundle.bytes)

    const entries = listTar(tar)
    const tarNames = entries.map((entry) => entry.name)
    assert.equal(tarNames[0], 'manifest.json')
    assert.equal(tarNames[1], 'handoff.md')
    assert.deepEqual(new Set(tarNames.slice(2)), new Set([
      'files/东京行程.docx',
      'files/预算.xlsx',
      'files/notes.md',
      'files/main.rs',
      'files/empty-dir',
    ]))
    const manifest = JSON.parse(entries[0].data.toString())
    assert.equal(manifest.files.length, 5)
    for (const file of manifest.files) {
      assert.equal(file.sha256, createHash('sha256').update(fs.readFileSync(path.join(cwd, file.path))).digest('hex'))
    }

    // 手机上按 id 删包
    const removed = await fetch(`${mounted.base}/pocket/handoff/file?id=${created.body.bundle.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    const after = await getJson(`${mounted.base}/pocket/handoff/bundles`)
    assert.equal(after.body.bundles.length, 0)
  } finally {
    await mounted.close()
  }
})

test('接力路由：非法路径与未知会话被拒绝', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  fs.writeFileSync(path.join(cwd, 'a.docx'), 'a')

  const mounted = await mountPlugin({ cwd, home })
  try {
    for (const bad of ['../a.docx', '/etc/passwd', 'sub/a.docx']) {
      const res = await getJson(`${mounted.base}/pocket/handoff/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-a', files: [bad] }),
      })
      assert.equal(res.status, 400, `应拒绝 ${bad}`)
      assert.equal(res.body.ok, false)
    }

    const unknown = await getJson(`${mounted.base}/pocket/handoff/candidates?sessionId=session-missing`)
    assert.equal(unknown.status, 400)
    assert.match(unknown.body.error, /session-not-found/)

    const missing = await fetch(`${mounted.base}/pocket/handoff/file?id=../etc`)
    assert.equal(missing.status, 404)
  } finally {
    await mounted.close()
  }
})

test('接力路由：没有推荐文件时退化为最近几个文件', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  // 会话时间设成未来，让所有文件都不算 "recommended"
  const mounted = await mountPlugin({ cwd, home })
  const old = path.join(cwd, '老文件.docx')
  fs.writeFileSync(old, 'x')
  const past = new Date(Date.now() - 10 * 24 * 3600 * 1000)
  fs.utimesSync(old, past, past)
  try {
    const created = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.bundle.files.length, 1, '没有推荐文件时用最近的文件兜底')
  } finally {
    await mounted.close()
  }
})


test('反向接力：手机推来的包解包、建会话并按计划开工', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  fs.writeFileSync(path.join(cwd, 'a.docx'), 'a')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox

  const mounted = await mountPlugin({ cwd, home })
  try {
    const now = Date.now()
    const { tar, manifest } = createBundle({
      id: 'hf-rev-route1',
      now,
      title: '给新项目定计划',
      session: { id: 's', cwd },
      files: [{ path: 'plan.md', data: Buffer.from('# 计划\n1. 初始化'), bytes: 15, kind: 'text', sha256: 'h' }],
      direction: 'to-desktop',
      plan: '# 计划\n1. 初始化仓库\n2. 跑测试',
    })

    const res = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 'session-received-1')
    assert.deepEqual(body.files, ['plan.md'])

    const dir = path.join(inbox, manifest.id)
    assert.equal(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), '# 计划\n1. 初始化')
    assert.match(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf8'), /初始化仓库/)
    assert.match(fs.readFileSync(path.join(dir, `handoff-${manifest.id}.md`), 'utf8'), /初始化仓库/)
    assert.equal(mounted.calls.created.length, 1)
    assert.equal(mounted.calls.created[0].cwd, dir)
    assert.match(mounted.calls.prompts[0].content[0].text, /按计划开始做/)

    // 同一个包重复上传：不再建会话
    const again = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    const replay = await again.json()
    assert.equal(replay.replayed, true)
    assert.equal(replay.sessionId, 'session-received-1')
    assert.equal(mounted.calls.created.length, 1)

    // 垃圾包：400，不落盘
    const bad = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: Buffer.from('not a tar'),
    })
    assert.equal(bad.status, 400)
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

// ---------------------------------------------------------------------------
// issue #1：附件三态（省略 / 显式空数组 / 显式列表）
// ---------------------------------------------------------------------------

function handoffFile(path, text) {
  const data = Buffer.from(text)
  return { path, data, bytes: data.length, kind: 'text', sha256: createHash('sha256').update(data).digest('hex') }
}

test('附件三态：显式空数组打纯计划包，不再自动推荐文件', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  fs.writeFileSync(path.join(cwd, 'sample.txt'), 's')
  const mounted = await mountPlugin({ cwd, home })
  try {
    const created = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', files: [], plan: '只发计划，不带附件', direction: 'to-desktop' }),
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.bundle.files.length, 0, '显式零附件必须真的零附件')
    assert.equal(created.body.bundle.direction, 'to-desktop')

    const download = await fetch(`${mounted.base}${created.body.bundle.downloadPath}`)
    const entries = listTar(Buffer.from(await download.arrayBuffer()))
    const manifest = JSON.parse(entries.find((entry) => entry.name === 'manifest.json').data.toString())
    assert.equal(manifest.files.length, 0)
    assert.equal(manifest.source.version, PACKAGE_VERSION, 'manifest 带上生成它的插件版本')
    assert.equal(manifest.source.protocolVersion, PROTOCOL_VERSION)
  } finally {
    await mounted.close()
  }
})

test('附件三态：显式列表只包含所选文件，省略字段仍自动推荐', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'keep')
  fs.writeFileSync(path.join(cwd, 'drop.txt'), 'drop')
  const mounted = await mountPlugin({ cwd, home })
  try {
    const explicit = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', files: ['keep.txt'] }),
    })
    assert.equal(explicit.status, 200, JSON.stringify(explicit.body))
    assert.deepEqual(explicit.body.bundle.files.map((file) => file.path), ['keep.txt'])

    const omitted = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    })
    assert.equal(omitted.status, 200, JSON.stringify(omitted.body))
    assert.equal(omitted.body.bundle.files.length, 2, '省略 files 的老约定不变：自动推荐')

    const emptyButNothing = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', files: [] }),
    })
    assert.equal(emptyButNothing.status, 400)
    assert.equal(emptyButNothing.body.error, 'no-files-or-plan')
  } finally {
    await mounted.close()
  }
})

test('附件三态：空目录也能发纯计划，但省略字段仍然报没有候选', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-empty-')
  const mounted = await mountPlugin({ cwd, home })
  try {
    const planOnly = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', files: [], plan: '空目录纯计划', direction: 'to-desktop' }),
    })
    assert.equal(planOnly.status, 200, JSON.stringify(planOnly.body))
    assert.equal(planOnly.body.bundle.files.length, 0)

    const omitted = await getJson(`${mounted.base}/pocket/handoff/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    })
    assert.equal(omitted.status, 400)
    assert.equal(omitted.body.error, 'no-candidate-files')
  } finally {
    await mounted.close()
  }
})

// ---------------------------------------------------------------------------
// issue #2：接收包含子目录的接力包
// ---------------------------------------------------------------------------

test('接收子目录：保留层级/内容，同名不同目录不互相覆盖', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  const mounted = await mountPlugin({ cwd, home })
  try {
    const { tar, manifest } = createBundle({
      id: 'hf-subdir-1',
      now: Date.now(),
      title: '子目录接力',
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '按层级文件干活',
      files: [
        handoffFile('flat.txt', 'flat'),
        handoffFile('sub/plan.txt', 'plan in sub'),
        handoffFile('sub/deep/notes.md', 'deep notes'),
        handoffFile('a/same.txt', 'same-a'),
        handoffFile('b/same.txt', 'same-b'),
      ],
    })

    const res = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.task.status, 'started')
    assert.equal(mounted.calls.created.length, 1)
    assert.equal(mounted.calls.prompts.length, 1)

    const dir = path.join(inbox, manifest.id)
    assert.equal(fs.readFileSync(path.join(dir, 'flat.txt'), 'utf8'), 'flat')
    assert.equal(fs.readFileSync(path.join(dir, 'sub/plan.txt'), 'utf8'), 'plan in sub')
    assert.equal(fs.readFileSync(path.join(dir, 'sub/deep/notes.md'), 'utf8'), 'deep notes')
    assert.equal(fs.readFileSync(path.join(dir, 'a/same.txt'), 'utf8'), 'same-a')
    assert.equal(fs.readFileSync(path.join(dir, 'b/same.txt'), 'utf8'), 'same-b')
    assert.ok(fs.existsSync(path.join(dir, `handoff-${manifest.id}.md`)))
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

test('接收子目录：中途写入失败重试，不产生成功回执或重复会话', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  const mounted = await mountPlugin({ cwd, home })
  try {
    const { tar, manifest } = createBundle({
      id: 'hf-subdir-retry',
      now: Date.now(),
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '重试计划',
      files: [handoffFile('sub/plan.txt', 'plan')],
    })
    // 先占位：让 sub 变成普通文件，第一次写入必然失败
    const dir = path.join(inbox, manifest.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub'), 'blocker')

    const first = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    assert.equal(first.status, 500)
    assert.equal(fs.existsSync(path.join(dir, 'received.json')), false, '失败不能留成功回执')
    assert.equal(mounted.calls.created.length, 0, '落盘失败不能建会话')

    fs.rmSync(path.join(dir, 'sub'))
    const second = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    const body = await second.json()
    assert.equal(second.status, 200, JSON.stringify(body))
    assert.equal(body.task.status, 'started')
    assert.equal(mounted.calls.created.length, 1)
    assert.equal(mounted.calls.prompts.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, 'sub/plan.txt'), 'utf8'), 'plan')
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

// ---------------------------------------------------------------------------
// issue #3：回执区分「文件已收」与「计划已启动」，失败可恢复
// ---------------------------------------------------------------------------

test('启动失败：回执明确 failed，重传用同一 requestId 恢复且不重复建会话', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  let promptCalls = 0
  const mounted = await mountPlugin({
    cwd,
    home,
    hooks: {
      prompt() {
        promptCalls += 1
        if (promptCalls === 1) throw new Error('agent-busy')
        return { accepted: true }
      },
    },
  })
  try {
    const { tar, manifest } = createBundle({
      id: 'hf-start-fail-1',
      now: Date.now(),
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '先失败后恢复',
      files: [handoffFile('plan.md', 'p')],
    })
    const first = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    const firstBody = await first.json()
    assert.equal(first.status, 200, '文件已经收下，HTTP 仍是 200')
    assert.equal(firstBody.ok, true)
    assert.equal(firstBody.task.status, 'failed', '但回执必须说明计划没启动')
    assert.match(firstBody.task.error, /agent-busy/)
    assert.equal(mounted.calls.created.length, 1)

    const retry = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    const retryBody = await retry.json()
    assert.equal(retry.status, 200, JSON.stringify(retryBody))
    assert.equal(retryBody.task.status, 'started')
    assert.equal(retryBody.sessionId, firstBody.sessionId, '恢复必须复用同一会话')
    assert.equal(mounted.calls.created.length, 1, '重传不能重复建会话')
    assert.equal(mounted.calls.prompts.length, 2)
    assert.equal(
      new Set(mounted.calls.prompts.map((request) => request.requestId)).size,
      1,
      '重试必须用同一个 requestId（DSH 侧幂等）'
    )

    const meta = JSON.parse(fs.readFileSync(path.join(inbox, manifest.id, 'received.json'), 'utf8'))
    assert.equal(meta.task.status, 'started')
    assert.equal(meta.task.attempts, 2)
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

test('启动超时：回执标 unknown，恢复成功后变 started', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  let promptCalls = 0
  const mounted = await mountPlugin({
    cwd,
    home,
    hooks: {
      prompt() {
        promptCalls += 1
        if (promptCalls === 1) {
          const error = new Error('The operation was aborted due to timeout')
          error.name = 'TimeoutError'
          throw error
        }
        return { accepted: true }
      },
    },
  })
  try {
    const { tar } = createBundle({
      id: 'hf-start-timeout-1',
      now: Date.now(),
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '超时恢复',
      files: [handoffFile('plan.md', 'p')],
    })
    const first = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    }).then((response) => response.json())
    assert.equal(first.task.status, 'unknown')

    const second = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    }).then((response) => response.json())
    assert.equal(second.task.status, 'started')
    assert.equal(mounted.calls.created.length, 1)
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

test('中断恢复：已有回执但任务未启动时，恢复启动而不是新建会话', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  const mounted = await mountPlugin({ cwd, home })
  try {
    const { tar, manifest } = createBundle({
      id: 'hf-resume-1',
      now: Date.now(),
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '恢复启动',
      files: [handoffFile('plan.md', 'p')],
    })
    const dir = path.join(inbox, manifest.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'received.json'), JSON.stringify({
      id: manifest.id,
      sessionId: 'session-existing',
      cwd: dir,
      files: ['plan.md'],
      receivedAt: Date.now(),
      task: { status: 'starting', requestId: `pocket-handoff-${manifest.id}`, attempts: 0 },
    }))

    const res = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.task.status, 'started')
    assert.equal(body.sessionId, 'session-existing')
    assert.equal(mounted.calls.created.length, 0, '中断恢复不能再建会话')
    assert.equal(mounted.calls.prompts.length, 1)
    assert.equal(mounted.calls.prompts[0].sessionId, 'session-existing')
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

test('已完成：串行重传回 replayed，不再提交计划', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  const mounted = await mountPlugin({ cwd, home })
  try {
    const { tar } = createBundle({
      id: 'hf-replayed-1',
      now: Date.now(),
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '只跑一次',
      files: [handoffFile('plan.md', 'p')],
    })
    const send = () => fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    }).then((response) => response.json())

    const first = await send()
    assert.equal(first.task.status, 'started')
    const second = await send()
    assert.equal(second.replayed, true)
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(second.task.status, 'started')
    assert.equal(mounted.calls.created.length, 1)
    assert.equal(mounted.calls.prompts.length, 1)
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

// ---------------------------------------------------------------------------
// issue #4：并发到达只建一个会话、只提交一次计划
// ---------------------------------------------------------------------------

test('并发到达：同一个包共享一次处理，回执指向同一会话', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  const mounted = await mountPlugin({
    cwd,
    home,
    hooks: {
      beforeCreate: () => new Promise((resolve) => setTimeout(resolve, 120)),
    },
  })
  try {
    const { tar } = createBundle({
      id: 'hf-concurrent-1',
      now: Date.now(),
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '并发到达',
      files: [handoffFile('plan.md', 'p')],
    })
    const send = () => fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    }).then(async (response) => ({ status: response.status, body: await response.json() }))

    const [a, b] = await Promise.all([send(), send()])
    assert.equal(a.status, 200, JSON.stringify(a.body))
    assert.equal(b.status, 200, JSON.stringify(b.body))
    assert.equal(a.body.sessionId, b.body.sessionId, '两个回执必须指向同一会话')
    assert.equal(mounted.calls.created.length, 1, '同一个包至多建一个会话')
    assert.equal(mounted.calls.prompts.length, 1, '计划只提交一次')
    assert.equal(a.body.task.status, 'started')
    assert.equal(b.body.task.status, 'started')
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})

test('发现响应：区分安装包版本与协议版本', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const discoveryPort = 49000 + Math.floor(Math.random() * 500)
  const mounted = await mountPlugin({ cwd, home, discoveryPort, hostPort: 47311 })
  const socket = dgram.createSocket('udp4')
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('discovery timeout')), 3000)
      socket.once('message', (message) => {
        clearTimeout(timer)
        resolve(JSON.parse(message.toString('utf8')))
      })
      socket.send('POCKETWHALE/1 DISCOVER', discoveryPort, '127.0.0.1', (error) => {
        if (error) {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
    assert.equal(reply.service, 'pocket-whale')
    assert.equal(reply.version, PACKAGE_VERSION, '发现响应上报安装包版本')
    assert.equal(reply.protocolVersion, PROTOCOL_VERSION, '协议版本单独上报')
    assert.equal(reply.port, 47311)
  } finally {
    socket.close()
    await mounted.close()
  }
})

test('旧版回执恢复：没有 task 字段时用同一 requestId 补启动，不重复建会话', async () => {
  const home = tmpdir('pocket-home-')
  const cwd = tmpdir('pocket-ws-')
  const inbox = tmpdir('pocket-inbox-')
  process.env.DSH_POCKET_INBOX = inbox
  const mounted = await mountPlugin({ cwd, home })
  try {
    const { tar, manifest } = createBundle({
      id: 'hf-legacy-1',
      now: Date.now(),
      session: { id: 's', cwd },
      direction: 'to-desktop',
      plan: '旧回执恢复',
      files: [handoffFile('plan.md', 'p')],
    })
    const dir = path.join(inbox, manifest.id)
    fs.mkdirSync(dir, { recursive: true })
    // 旧版 received.json：只有 sessionId，没有 task 状态
    fs.writeFileSync(path.join(dir, 'received.json'), JSON.stringify({
      id: manifest.id,
      sessionId: 'session-legacy',
      cwd: dir,
      files: ['plan.md'],
      receivedAt: Date.now(),
    }))

    const body = await fetch(`${mounted.base}/pocket/handoff/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-pocket-handoff' },
      body: tar,
    }).then((response) => response.json())
    assert.equal(body.task.status, 'started')
    assert.equal(body.sessionId, 'session-legacy')
    assert.equal(mounted.calls.created.length, 0)
    assert.equal(mounted.calls.prompts.length, 1)
    assert.equal(mounted.calls.prompts[0].requestId, `pocket-handoff-${manifest.id}`)
  } finally {
    delete process.env.DSH_POCKET_INBOX
    await mounted.close()
  }
})
