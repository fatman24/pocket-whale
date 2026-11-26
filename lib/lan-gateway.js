/**
 * 局域网网关 + 配对待批。
 *
 * 背景：`dsh web` 默认只绑 127.0.0.1，手机在局域网上连不到；而插件无法改它的绑定。
 * 所以这里自己起一个监听 0.0.0.0 的 HTTP 服务：
 *   - /lan/pair 等配对接口（局域网可达）
 *   - /pocket/*  校验 token 后转发到 127.0.0.1:<port>（真正的实现仍只有一份）
 *
 * 安全模型：
 *   - 配对请求只登记成"待批"，必须由**本机**（127.0.0.1）批准，也就是 DSH 界面里那块面板
 *   - 批准后发放 token，客户端后续请求带 Authorization: Bearer <token>
 *   - /lan/pending、/lan/approve 等管理接口只接受回环地址
 */

import http from 'node:http'
import { randomUUID, randomBytes, createHash } from 'node:crypto'

const PAIR_TTL_MS = 10 * 60 * 1000

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function isLoopback(address) {
  if (!address) return false
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** 设备指纹的短码，方便用户在界面上口头核对。 */
function shortCode(fingerprint) {
  return String(fingerprint ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()
}

export class PairingGateway {
  #pending = new Map()
  /** 已批准、等手机来取 token 的条目（不在待批列表里显示） */
  #awaiting = new Map()
  #devices = new Map() // token -> device
  #server
  #targetPort
  #getTargetPort
  #onChange

  constructor({ getTargetPort, devices = {}, onChange } = {}) {
    this.#getTargetPort = getTargetPort
    this.#onChange = onChange
    this.#targetPort = null
    for (const [token, device] of Object.entries(devices)) this.#devices.set(token, device)
  }

  get port() {
    return this.#server?.address()?.port ?? null
  }

  get devices() {
    return [...this.#devices.entries()].map(([token, device]) => ({ token, ...device }))
  }

  /** 按公开 id 撤销（界面不接触 token 本身）。 */
  revokeById(id) {
    for (const [token, device] of this.#devices) {
      if (device.id === id) return this.revoke(token)
    }
    return false
  }

  /** 供持久化：token → device 的原始映射。 */
  snapshot() {
    return Object.fromEntries(this.#devices)
  }

  /** 局域网侧发起的配对请求。 */
  requestPairing(info, remoteAddress) {
    const fingerprint = String(info?.fingerprint ?? '').slice(0, 64)
    // 同一台设备重复发起时复用已有待批，别在面板里堆一串一模一样的条目
    if (fingerprint) {
      for (const [, entry] of this.#pending) {
        if (entry.fingerprint === fingerprint) return entry
      }
      for (const [, entry] of this.#awaiting) {
        if (entry.fingerprint === fingerprint) return entry
      }
    }
    const id = randomUUID()
    const entry = {
      id,
      name: String(info?.name ?? '未知设备').slice(0, 64),
      model: String(info?.model ?? '').slice(0, 64),
      systemVersion: String(info?.systemVersion ?? '').slice(0, 32),
      fingerprint,
      shortCode: shortCode(info?.fingerprint),
      address: remoteAddress ?? null,
      createdAt: Date.now(),
      expiresAt: Date.now() + PAIR_TTL_MS,
      token: null,
    }
    this.#pending.set(id, entry)
    return entry
  }

  /** 待批列表（给本机面板用）。只列还没被批准的；顺带清掉过期的。 */
  pending() {
    const now = Date.now()
    for (const [id, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(id)
    }
    for (const [id, entry] of this.#awaiting) {
      if (entry.expiresAt <= now) this.#awaiting.delete(id)
    }
    return [...this.#pending.values()].map((e) => ({
      id: e.id,
      name: e.name,
      model: e.model,
      systemVersion: e.systemVersion,
      shortCode: e.shortCode,
      address: e.address,
      expiresAt: e.expiresAt,
    }))
  }

  /** 本机面板批准：发 token。条目从待批移到"等待领取"，面板上立刻消失。 */
  approve(id) {
    const entry = this.#pending.get(id)
    if (!entry) {
      const already = this.#awaiting.get(id)
      return already ? already.token : null
    }
    const token = randomBytes(24).toString('base64url')
    entry.token = token
    this.#pending.delete(id)
    this.#awaiting.set(id, entry)
    this.#devices.set(token, {
      id: createHash('sha256').update(token).digest('hex').slice(0, 12),
      name: entry.name,
      model: entry.model,
      systemVersion: entry.systemVersion,
      shortCode: entry.shortCode,
      pairedAt: Date.now(),
    })
    this.#onChange?.(this.snapshot())
    return token
  }

  deny(id) {
    this.#awaiting.delete(id)
    return this.#pending.delete(id)
  }

  revoke(token) {
    const removed = this.#devices.delete(token)
    if (removed) this.#onChange?.(this.snapshot())
    return removed
  }

  /** 局域网侧轮询：拿到 token 就算配对完成（只发一次）。 */
  pollPairing(id) {
    const awaiting = this.#awaiting.get(id)
    if (awaiting) {
      this.#awaiting.delete(id)
      return { status: 'paired', token: awaiting.token }
    }
    const pending = this.#pending.get(id)
    // 待批时把短码带回去：手机等待页要能和电脑弹窗上的「验证码」核对。
    if (pending) return { status: 'pending', code: pending.shortCode }
    return { status: 'unknown' }
  }

  isAuthorized(req) {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token ? this.#devices.has(token) : false
  }

  #proxy(req, res) {
    const port = this.#getTargetPort?.() ?? this.#targetPort
    if (!port) return json(res, 503, { ok: false, error: 'host-not-ready' })
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (error) => json(res, 502, { ok: false, error: String(error?.message ?? error) }))
    req.pipe(upstream)
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://lan.local')
    const path = url.pathname
    const fromLan = !isLoopback(req.socket.remoteAddress)

    if (req.method === 'OPTIONS') return json(res, 204, {})

    if (path === '/lan/pair' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      const entry = this.requestPairing(body, req.socket.remoteAddress)
      // code 是与电脑端弹窗一致的短码；旧 App 忽略未知字段不受影响。
      return json(res, 200, { ok: true, id: entry.id, status: 'pending', code: entry.shortCode })
    }

    if (path === '/lan/pair-status') {
      return json(res, 200, { ok: true, ...this.pollPairing(url.searchParams.get('id') ?? '') })
    }

    if (path === '/lan/pending') {
      if (fromLan) return json(res, 403, { ok: false, error: 'loopback-only' })
      return json(res, 200, { ok: true, pending: this.pending() })
    }

    if (path === '/lan/approve' && req.method === 'POST') {
      if (fromLan) return json(res, 403, { ok: false, error: 'loopback-only' })
      const body = await readBody(req).catch(() => ({}))
      const token = this.approve(String(body?.id ?? ''))
      return token ? json(res, 200, { ok: true }) : json(res, 404, { ok: false, error: 'not-found' })
    }

    if (path === '/lan/deny' && req.method === 'POST') {
      if (fromLan) return json(res, 403, { ok: false, error: 'loopback-only' })
      const body = await readBody(req).catch(() => ({}))
      return json(res, 200, { ok: this.deny(String(body?.id ?? '')) })
    }

    if (path === '/lan/devices') {
      if (fromLan) return json(res, 403, { ok: false, error: 'loopback-only' })
      return json(res, 200, { ok: true, devices: this.devices.map(({ token, ...rest }) => rest) })
    }

    if (path === '/lan/revoke' && req.method === 'POST') {
      if (fromLan) return json(res, 403, { ok: false, error: 'loopback-only' })
      const body = await readBody(req).catch(() => ({}))
      return json(res, 200, { ok: this.revokeById(String(body?.id ?? '')) })
    }

    if (path.startsWith('/pocket/')) {
      if (!this.isAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
      return this.#proxy(req, res)
    }

    return json(res, 404, { ok: false, error: 'not-found' })
  }

  async listen(port = 48766) {
    this.#server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        try {
          json(res, 500, { ok: false, error: String(error?.message ?? error) })
        } catch {}
      })
    })
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, '0.0.0.0', resolve)
    })
    return this.port
  }

  async close() {
    const server = this.#server
    if (!server) return
    // SSE / keep-alive 连接不主动断开的话 close 永远不返回
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    this.#server = null
  }
}
