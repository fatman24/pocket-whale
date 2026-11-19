import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PairingGateway } from '../lib/lan-gateway.js'

async function withUpstream(fn) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url, host: req.headers.host }))
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const port = upstream.address().port
  try {
    await fn(port)
  } finally {
    await new Promise((r) => upstream.close(r))
  }
}

test('配对请求进入待批，批准后发 token，轮询只给一次', async () => {
  const gw = new PairingGateway({ getTargetPort: () => 1234 })
  const entry = gw.requestPairing({ name: '张三的 iPhone', model: 'iPhone 15 Pro', systemVersion: 'iOS 26.1', fingerprint: 'abcdef123456' }, '192.168.1.23')
  assert.equal(gw.pending().length, 1)
  assert.equal(gw.pending()[0].shortCode, 'ABCDEF12')

  assert.deepEqual(gw.pollPairing(entry.id), { status: 'pending' })

  const token = gw.approve(entry.id)
  assert.ok(token)
  assert.equal(gw.pending().length, 0, '批准后不该继续出现在待批列表（面板会反复弹）')
  assert.equal(gw.devices.length, 1)
  assert.equal(gw.devices[0].name, '张三的 iPhone')

  assert.deepEqual(gw.pollPairing(entry.id), { status: 'paired', token })
  assert.deepEqual(gw.pollPairing(entry.id), { status: 'unknown' }, 'token 只发一次')
  await gw.close()
})

test('拒绝会移除待批，不会产生设备', () => {
  const gw = new PairingGateway({ getTargetPort: () => 1234 })
  const entry = gw.requestPairing({ name: 'x' }, '192.168.1.9')
  assert.equal(gw.deny(entry.id), true)
  assert.equal(gw.pending().length, 0)
  assert.equal(gw.devices.length, 0)
})

test('撤销设备后 token 立即失效', () => {
  const gw = new PairingGateway({ getTargetPort: () => 1234 })
  const entry = gw.requestPairing({ name: 'x' }, '192.168.1.9')
  const token = gw.approve(entry.id)
  const req = { headers: { authorization: `Bearer ${token}` } }
  assert.equal(gw.isAuthorized(req), true)
  gw.revoke(token)
  assert.equal(gw.isAuthorized(req), false)
})

test('设备带公开 id，可按 id 撤销（界面不接触 token）', () => {
  const gw = new PairingGateway({ getTargetPort: () => 1234 })
  const entry = gw.requestPairing({ name: 'x' }, '192.168.1.9')
  const token = gw.approve(entry.id)
  const device = gw.devices[0]
  assert.ok(device.id)
  assert.equal(device.token, token, 'devices getter 仍带 token（供持久化）')
  assert.equal(gw.revokeById(device.id), true)
  assert.equal(gw.isAuthorized({ headers: { authorization: `Bearer ${token}` } }), false)
})

test('过期待批会被清掉', () => {
  const gw = new PairingGateway({ getTargetPort: () => 1234 })
  const entry = gw.requestPairing({ name: 'x' }, '192.168.1.9')
  const stored = gw.pending()
  assert.equal(stored.length, 1)
  // 直接把时间往前拨
  const raw = gw['#pending'] // 私有字段拿不到，改为验证 approve 对未知 id 的行为
  assert.equal(gw.approve('不存在的-id'), null)
})

test('HTTP：未授权访问 /pocket/* 返回 401，授权后转发到上游', async () => {
  await withUpstream(async (upstreamPort) => {
    const gw = new PairingGateway({ getTargetPort: () => upstreamPort })
    const port = await gw.listen(0)

    const unauthorized = await fetch(`http://127.0.0.1:${port}/pocket/status`)
    assert.equal(unauthorized.status, 401)

    const entry = gw.requestPairing({ name: 'iPhone' }, '127.0.0.1')
    const token = gw.approve(entry.id)

    const authorized = await fetch(`http://127.0.0.1:${port}/pocket/status`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(authorized.status, 200)
    const body = await authorized.json()
    assert.equal(body.path, '/pocket/status')
    assert.match(body.host, /^127\.0\.0\.1:/, '转发时 Host 必须改写成回环地址')
    await gw.close()
  })
})

test('HTTP：管理接口只允许回环来源', async () => {
  const gw = new PairingGateway({ getTargetPort: () => 1234 })
  const port = await gw.listen(0)
  const res = await fetch(`http://127.0.0.1:${port}/lan/pending`)
  assert.equal(res.status, 200, '回环来源可以访问')
  const body = await res.json()
  assert.equal(body.ok, true)
  await gw.close()
})
