import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BUNDLE_TTL_MS,
  HandoffStore,
  collectCandidates,
  createBundle,
  fileKind,
  parseHandoff,
  isAllowedFileName,
  isValidId,
  listTar,
  loadPayloads,
  MAX_FILE_BYTES,
  newId,
  toTar,
} from '../lib/handoff.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-handoff-'))
}

function writeFile(dir, name, content) {
  const full = path.join(dir, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

test('候选文件：只列顶层、不限扩展名、跳过符号链接，隐藏文件可选', () => {
  const dir = tmpdir()
  writeFile(dir, '东京行程.docx', 'doc')
  writeFile(dir, '预算.xlsx', 'xlsx')
  writeFile(dir, '说明.md', 'md')
  writeFile(dir, 'main.rs', 'code')
  writeFile(dir, '.hidden.docx', 'hidden')
  fs.mkdirSync(path.join(dir, 'sub'))
  writeFile(path.join(dir, 'sub'), '深层.docx', 'nested')
  fs.symlinkSync(path.join(dir, '东京行程.docx'), path.join(dir, '链接.docx'))

  const rows = collectCandidates({ cwd: dir, sessionCreatedAt: Date.now() - 1000 })
  const names = rows.map((row) => row.path)
  assert.deepEqual(new Set(names), new Set(['东京行程.docx', '预算.xlsx', '说明.md', 'main.rs', '.hidden.docx', 'sub']))
  const hidden = rows.find((row) => row.path === '.hidden.docx')
  assert.equal(hidden.recommended, false)
  assert.equal(rows.find((row) => row.path === 'main.rs').kind, null)
  const folder = rows.find((row) => row.path === 'sub')
  assert.equal(folder.isDirectory, true)
  assert.equal(folder.fileCount, 1)
  assert.equal(rows.filter((row) => !row.path.startsWith('.') && !row.isDirectory).every((row) => row.recommended), true)
})

test('候选文件：会话开始之前的老文件不默认勾选', () => {
  const dir = tmpdir()
  const old = writeFile(dir, '旧文件.docx', 'old')
  const past = Date.now() - 3 * 24 * 3600 * 1000
  fs.utimesSync(old, new Date(past), new Date(past))

  const rows = collectCandidates({ cwd: dir, sessionCreatedAt: Date.now() - 60_000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].recommended, false)
})

test('文件名与 id 校验', () => {
  assert.equal(isAllowedFileName('a.docx'), true)
  assert.equal(isAllowedFileName('a.DOCX'), true)
  assert.equal(isAllowedFileName('../a.docx'), false)
  assert.equal(isAllowedFileName('/tmp/a.docx'), false)
  assert.equal(isAllowedFileName('.a.docx'), true)
  assert.equal(isAllowedFileName('a.exe'), true)
  assert.equal(isAllowedFileName('Makefile'), true)
  assert.equal(fileKind('a.pptx'), 'pptx')
  assert.equal(isValidId('hf-mabc123-4f2a'), true)
  assert.equal(isValidId('../etc'), false)
  assert.equal(isValidId('hf/a'), false)
})

test('读文件：目录展开、保留相对路径', () => {
  const dir = tmpdir()
  writeFile(dir, 'src/a.ts', 'code')
  writeFile(dir, 'src/b.md', 'notes')
  writeFile(dir, 'src/.env', 'secret')
  const files = loadPayloads({ cwd: dir, paths: ['src'] })
  assert.deepEqual(new Set(files.map((file) => file.path)), new Set(['src/a.ts', 'src/b.md', 'src/.env']))
  assert.equal(files.every((file) => file.data.length > 0), true)
})

test('读文件：拒绝穿越、超限与不存在的名字', () => {
  const dir = tmpdir()
  writeFile(dir, 'ok.docx', 'ok')
  assert.throws(() => loadPayloads({ cwd: dir, paths: ['../ok.docx'] }), /file-not-allowed/)
  assert.throws(() => loadPayloads({ cwd: dir, paths: ['sub/ok.docx'] }), /not-a-file/)
  assert.throws(() => loadPayloads({ cwd: dir, paths: ['missing.docx'] }), /not-a-file/)
  assert.throws(() => loadPayloads({ cwd: dir, paths: [] }), /no-files/)

  const big = path.join(dir, 'big.pdf')
  const fd = fs.openSync(big, 'w')
  fs.ftruncateSync(fd, MAX_FILE_BYTES + 1)
  fs.closeSync(fd)
  assert.throws(() => loadPayloads({ cwd: dir, paths: ['big.pdf'] }), /file-too-large/)
})

test('tar：中文名 / 二进制 / 长路径都能往返', () => {
  const payload = Buffer.from([0, 1, 2, 255, 254, 10])
  const longName = 'files/' + 'n'.repeat(60) + '/' + 'm'.repeat(80) + '.docx'
  const tar = toTar([
    { name: 'manifest.json', data: Buffer.from('{"a":1}'), mtime: 1 },
    { name: 'files/东京行程.docx', data: Buffer.from('hello'), mtime: 2 },
    { name: 'files/预算.xlsx', data: payload, mtime: 3 },
    { name: longName, data: Buffer.from('long'), mtime: 4 },
  ])

  assert.equal(tar.length % 512, 0)
  const entries = listTar(tar)
  assert.deepEqual(entries.map((entry) => entry.name), [
    'manifest.json',
    'files/东京行程.docx',
    'files/预算.xlsx',
    longName,
  ])
  assert.deepEqual(entries[2].data, payload)
  assert.equal(entries[0].data.toString(), '{"a":1}')
})

test('超过 100 字节又没有目录分隔的名字直接报错（而不是写出坏包）', () => {
  const tooLong = 'x'.repeat(120)
  assert.throws(() => toTar([{ name: tooLong, data: Buffer.from('x') }]), /tar-name-too-long/)
})

test('交接说明：带上原始诉求、文件清单与"别重做"', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我排东京三天行程，第二天还没定' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '第一天和第三天排好了，第二天留给你' }] } } },
    { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'office_write', arguments: '{}' } },
    // 系统注入的上下文不该进交接说明
    { type: 'user/message', seq: 4, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '内部上下文' }] } },
  ]
  const { manifest, digest } = createBundle({
    id: 'hf-test-0001',
    now: 1_794_885_000_000,
    title: '东京三日行程',
    session: { id: 'session-x', cwd: '/tmp/ws' },
    events,
    files: [{ path: '东京行程.docx', data: Buffer.from('doc'), bytes: 3, kind: 'docx', sha256: 'abc' }],
    note: '第二天要去看展',
  })

  assert.equal(manifest.schema, 1)
  assert.equal(manifest.session.title, '东京三日行程')
  assert.equal(manifest.files[0].path, '东京行程.docx')
  assert.match(digest, /帮我排东京三天行程/)
  assert.match(digest, /第一天和第三天排好了/)
  assert.match(digest, /东京行程\.docx/)
  assert.match(digest, /别从头重写/)
  assert.match(digest, /handoff-hf-test-0001\.md/)
  assert.doesNotMatch(digest, /原会话还在运行/)
  assert.match(digest, /第二天要去看展/)
  assert.doesNotMatch(digest, /内部上下文/)
})

test('会话还在跑时，交接说明里要提醒先停掉电脑那边', () => {
  const { digest } = createBundle({
    id: 'hf-test-live1',
    now: 1_000,
    title: 't',
    session: { id: 's', cwd: '/tmp', live: true },
    files: [{ path: 'a.md', data: Buffer.from('a'), bytes: 1, kind: 'text', sha256: 'h' }],
  })
  assert.match(digest, /原会话还在运行/)
  assert.match(digest, /同时改同一批文件/)
})

test('createBundle：manifest 与 tar 内容一致', () => {
  const { manifest, tar } = createBundle({
    id: 'hf-test-0002',
    now: 1_000,
    title: 't',
    session: { id: 's', cwd: '/tmp' },
    files: [{ path: 'a.md', data: Buffer.from('abc'), bytes: 3, kind: 'text', sha256: createHash('sha256').update('abc').digest('hex') }],
  })
  const entries = listTar(tar)
  assert.deepEqual(entries.map((entry) => entry.name), ['manifest.json', 'handoff.md', 'files/a.md'])
  const onDisk = JSON.parse(entries[0].data.toString())
  assert.equal(onDisk.id, manifest.id)
  assert.equal(onDisk.files[0].sha256, manifest.files[0].sha256)
  assert.equal(entries[2].data.toString(), 'abc')
})

test('仓库：保存 / 列表 / 读回 / 删除 / 过期清理', () => {
  const dir = tmpdir()
  let now = 1_700_000_000_000
  const store = new HandoffStore({ dir, clock: () => now })
  const id = newId(now)
  const { manifest, tar } = createBundle({
    id,
    now,
    title: '预算表',
    session: { id: 'session-y', cwd: dir },
    files: [{ path: '预算.xlsx', data: Buffer.from('x'), bytes: 1, kind: 'xlsx', sha256: 'h' }],
  })
  store.save(manifest, tar)

  const rows = store.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, id)
  assert.equal(rows[0].files[0].path, '预算.xlsx')
  assert.equal(rows[0].bytes, tar.length)

  const read = store.read(id)
  assert.equal(read.manifest.id, id)
  assert.deepEqual(read.tar, tar)

  assert.equal(store.sweep(BUNDLE_TTL_MS), 0, '没过期不删')
  now += BUNDLE_TTL_MS + 1
  assert.equal(store.sweep(BUNDLE_TTL_MS), 1)
  assert.equal(store.list().length, 0)
  assert.throws(() => store.read(id))

  assert.equal(store.remove('../etc'), false, '非法 id 不落到别的路径')
})

test('仓库：坏掉的 sidecar 不影响其它包', () => {
  const dir = tmpdir()
  const store = new HandoffStore({ dir })
  fs.writeFileSync(path.join(dir, 'hf-broken-1.json'), '{oops')
  const { manifest, tar } = createBundle({
    id: 'hf-good-0001',
    now: 1,
    title: 'ok',
    session: { id: 's', cwd: dir },
    files: [{ path: 'a.md', data: Buffer.from('a'), bytes: 1, kind: 'text', sha256: 'h' }],
  })
  store.save(manifest, tar)
  assert.deepEqual(store.list().map((row) => row.id), ['hf-good-0001'])
})


test('反向接力：计划写进说明，措辞面向"电脑上按计划开工"', () => {
  const { manifest, digest } = createBundle({
    id: 'hf-rev-0001',
    now: 1_000,
    title: '给项目定计划',
    session: { id: 's', cwd: '/tmp' },
    files: [{ path: 'plan.md', data: Buffer.from('x'), bytes: 1, kind: 'text', sha256: 'h' }],
    direction: 'to-desktop',
    plan: '# 计划\n\n1. 初始化仓库\n2. 写 README\n3. 跑测试',
  })
  assert.equal(manifest.direction, 'to-desktop')
  assert.match(digest, /手机端定好的计划/)
  assert.match(digest, /初始化仓库/)
  assert.match(digest, /按「手机端定好的计划」开始做/)
  assert.match(digest, /这台电脑的当前目录/)
  assert.doesNotMatch(digest, /别从头重写/)
})

test('parseHandoff：解包往返、拒绝非法文件名', () => {
  const { tar, manifest } = createBundle({
    id: 'hf-rev-0002',
    now: 1_000,
    title: 't',
    session: { id: 's', cwd: '/tmp' },
    files: [
      { path: 'plan.md', data: Buffer.from('plan'), bytes: 4, kind: 'text', sha256: 'a' },
      { path: '东京行程.docx', data: Buffer.from('docx'), bytes: 4, kind: 'docx', sha256: 'b' },
    ],
    direction: 'to-desktop',
    plan: '步骤',
  })
  const parsed = parseHandoff(tar)
  assert.equal(parsed.manifest.id, manifest.id)
  assert.match(parsed.brief, /步骤/)
  assert.deepEqual(parsed.files.map((file) => file.name), ['plan.md', '东京行程.docx'])
  assert.equal(parsed.files[1].data.toString(), 'docx')

  const evil = toTar([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ schema: 1, id: 'hf-rev-0003' })) },
    { name: 'files/../evil.docx', data: Buffer.from('x') },
  ])
  assert.throws(() => parseHandoff(evil), /bad-file-name/)

  const badSchema = toTar([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ schema: 99, id: 'hf-rev-0004' })) },
  ])
  assert.throws(() => parseHandoff(badSchema), /unsupported-schema/)
})
