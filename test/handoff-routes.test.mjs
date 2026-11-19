/**
 * 路由级集成测试：真插件 apply() + 假 ctx + 真 HTTP。
 * 覆盖「列候选 → 生成 → 列表 → 下载 → 删包」，以及非法输入的拒绝路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createBundle, listTar } from '../lib/handoff.js'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 收集插件注册的 exact 路由，起一个最小 HTTP 服务器。 */
async function mountPlugin({ cwd, home }) {
  process.env.DSH_HOME = home
  process.env.DSH_POCKET_LAN = '0'
  process.env.DSH_POCKET_DISCOVERY = '0'

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
      if (name === 'sessionController') {
        return {
          async create(options) {
            calls.created.push(options)
            return { sessionId: `session-received-${calls.created.length}` }
          },
          async prompt(request) {
            calls.prompts.push(request)
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
    assert.equal(status.body.version, '1.0.0')
    assert.equal(status.body.features.handoff, true)

    const candidates = await getJson(`${mounted.base}/pocket/handoff/candidates?sessionId=session-a`)
    assert.equal(candidates.status, 200)
    assert.equal(candidates.body.session.title, '东京三日行程')
    const names = candidates.body.files.map((file) => file.path)
    assert.deepEqual(new Set(names), new Set(['东京行程.docx', '预算.xlsx', 'notes.md']))
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
    assert.equal(created.body.bundle.files.length, 3, '默认带全部推荐文件')
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
    ]))
    const manifest = JSON.parse(entries[0].data.toString())
    assert.equal(manifest.files.length, 3)
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
    for (const bad of ['../a.docx', '/etc/passwd', 'sub/a.docx', '.hidden.docx']) {
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
