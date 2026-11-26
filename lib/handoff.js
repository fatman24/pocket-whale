/**
 * 接力（handoff）：把电脑上没做完的文件 + 交接说明打包，交给手机上的 DSH。
 * 不限制扩展名：代码、压缩包、二进制、无扩展名文件都可以，只要用户主动选。
 *
 * 这个文件不依赖 Cordis / http，纯逻辑 + 文件读写，方便单测。
 * 设计见 docs/handoff.md。
 */

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { summarizeSessionEvent } from './pocket-core.js'

export const HANDOFF_EXT = '.pockethandoff'
export const HANDOFF_DIR = 'handoff'
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024
export const MAX_FILES = 40
/** 生成的包保留多久：过一个星期还没被取走就没意义了。 */
export const BUNDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 协议版本：接力包 schema / HTTP 字段约定的版本，改字段语义时才动它。
 * 和安装包版本（package.json 的 version）分开：用户需要知道自己装的是哪一版插件，
 * 而包里要标记的是生成它的协议格式。
 */
export const PROTOCOL_VERSION = '1.0.0'

/** 安装包版本：只从 package.json 读一次，状态页/发现/manifest 共用同一个来源。 */
export const PLUGIN_VERSION = readPackageVersion()

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim()
  } catch {}
  // 打包器把 package.json 裁掉时也不至于让插件整个起不来。
  return '0.0.0'
}

const KIND_BY_EXT = {
  docx: 'docx', doc: 'docx',
  xlsx: 'xlsx', xls: 'xlsx',
  pptx: 'pptx', ppt: 'pptx',
  pdf: 'pdf',
  md: 'text', txt: 'text', csv: 'csv',
  png: 'image', jpg: 'image', jpeg: 'image', heic: 'image', webp: 'image',
}

export function extensionOf(name) {
  const base = String(name ?? '')
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function fileKind(name) {
  return KIND_BY_EXT[extensionOf(name)] ?? null
}

/**
 * 只做路径安全校验，不按扩展名筛文件：允许脚本、压缩包、二进制、
 * 无扩展名文件和隐藏文件；符号链接/目录由调用方排除。
 */
export function isAllowedFileName(name) {
  const base = String(name ?? '')
  return normalizeRelativePath(base) === base
}

/** 相对路径（用 / 分隔）的安全规范化；拒绝绝对路径、空段和 ..。 */
export function normalizeRelativePath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/')
  if (!raw || raw.startsWith('/') || raw.includes('\0')) return null
  const parts = raw.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function resolveWithin(cwd, relative) {
  const base = path.resolve(cwd)
  const full = path.resolve(base, ...relative.split('/'))
  const inside = path.relative(base, full)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return full
}

/** 只允许 `[a-z0-9-]` 的 id，路径拼接前必须过这一关。 */
export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{3,63}$/.test(id)
}

export function newId(now = Date.now()) {
  return `hf-${now.toString(36)}-${randomBytes(3).toString('hex')}`
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)) + '…'
}

/** 计划这类文本要保留换行，不能像普通摘要一样压成一行。 */
function clipMultiline(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function stamp(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 目录摘要：递归统计普通文件数/大小；超过上限只标记 tooLarge，不偷偷截断。
 * 不跟符号链接，限制遍历条目和深度，避免扫描爆炸。
 */
function summarizeFolder(root, { readdir = fs.readdirSync, lstat = fs.lstatSync } = {}) {
  let bytes = 0
  let files = 0
  let modified = 0
  let tooLarge = false
  let seen = 0
  const maxEntries = 4000
  function walk(dir, depth) {
    if (tooLarge) return
    if (depth > 24) { tooLarge = true; return }
    let entries = []
    try { entries = readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (tooLarge) return
      seen += 1
      if (seen > maxEntries) { tooLarge = true; return }
      const name = typeof entry === 'string' ? entry : entry.name
      const full = path.join(dir, name)
      let stat
      try { stat = lstat(full) } catch { continue }
      if (stat.isSymbolicLink?.()) continue
      if (stat.isDirectory()) {
        walk(full, depth + 1)
      } else if (stat.isFile()) {
        files += 1
        bytes += stat.size
        modified = Math.max(modified, stat.mtimeMs ?? 0)
        if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES) tooLarge = true
      }
    }
  }
  walk(root, 0)
  return { bytes, files, modified, tooLarge }
}

/**
 * 列会话工作目录里可以接力的文件。
 * 只扫顶层：避免递归扫一个代码仓库产生噪音；不限扩展名。
 */
export function collectCandidates({
  cwd,
  relative = '',
  sessionCreatedAt = 0,
  readdir = fs.readdirSync,
  lstat = fs.lstatSync,
  limit = 60,
} = {}) {
  if (!cwd) return []
  const folder = relative ? normalizeRelativePath(relative) : ''
  if (relative && !folder) throw new Error(`file-not-allowed: ${relative}`)
  const dir = folder ? resolveWithin(cwd, folder) : path.resolve(cwd)
  if (!dir) throw new Error(`file-not-allowed: ${relative}`)
  let dirStat
  try { dirStat = lstat(dir) } catch { return [] }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink?.()) return []
  let entries = []
  try {
    entries = readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const rows = []
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name
    if (!name || !isAllowedFileName(name)) continue
    const full = path.join(dir, name)
    const relativePath = folder ? `${folder}/${name}` : name
    let stat
    try {
      stat = lstat(full)
    } catch {
      continue
    }
    if (stat.isSymbolicLink?.()) continue
    if (stat.isDirectory()) {
      const summary = summarizeFolder(full, { readdir, lstat })
      rows.push({
        path: relativePath,
        bytes: summary.bytes,
        modified: summary.modified,
        kind: 'folder',
        isDirectory: true,
        fileCount: summary.files,
        tooLarge: summary.tooLarge,
        recommended: !name.startsWith('.') && Boolean(sessionCreatedAt) && summary.modified >= sessionCreatedAt - 60_000,
      })
      continue
    }
    if (!stat.isFile()) continue
    rows.push({
      path: relativePath,
      bytes: stat.size,
      modified: stat.mtimeMs ?? 0,
      kind: fileKind(name),
      isDirectory: false,
      fileCount: 1,
      tooLarge: stat.size > MAX_FILE_BYTES,
      // 会话开始之后改过的文件 = 这次任务的产物，默认勾上；隐藏文件不自动勾
      recommended: !name.startsWith('.') && Boolean(sessionCreatedAt) && (stat.mtimeMs ?? 0) >= sessionCreatedAt - 60_000,
    })
  }

  rows.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
    return b.modified - a.modified
  })
  return rows.slice(0, limit)
}

/** 读候选文件/目录并做第二道校验（限额、重名、真实路径）。 */
export function loadPayloads({
  cwd,
  paths = [],
  lstat = fs.lstatSync,
  readFile = fs.readFileSync,
  readdir = fs.readdirSync,
} = {}) {
  if (!cwd) throw new Error('no-cwd')
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('no-files')
  const base = path.resolve(cwd)
  const seen = new Set()
  const files = []
  let total = 0

  function addFile(relative, stat) {
    if (seen.has(relative)) return
    if (files.length >= MAX_FILES) throw new Error('too-many-files')
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file-too-large: ${relative}`)
    total += stat.size
    if (total > MAX_TOTAL_BYTES) throw new Error('bundle-too-large')
    const full = resolveWithin(base, relative)
    if (!full) throw new Error(`file-not-allowed: ${relative}`)
    const data = readFile(full)
    seen.add(relative)
    files.push({
      path: relative,
      data,
      bytes: data.length,
      modified: stat.mtimeMs ?? 0,
      kind: fileKind(relative),
      sha256: createHash('sha256').update(data).digest('hex'),
    })
  }

  function walk(relative, full, depth) {
    if (depth > 24) throw new Error(`folder-too-deep: ${relative}`)
    let entries = []
    try { entries = readdir(full, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name
      const child = relative ? `${relative}/${name}` : name
      const childFull = resolveWithin(base, child)
      if (!childFull) throw new Error(`file-not-allowed: ${child}`)
      let stat
      try { stat = lstat(childFull) } catch { continue }
      if (stat.isSymbolicLink?.()) continue
      if (stat.isDirectory()) walk(child, childFull, depth + 1)
      else if (stat.isFile()) addFile(child, stat)
    }
  }

  for (const raw of paths) {
    const relative = normalizeRelativePath(raw)
    if (!relative) throw new Error(`file-not-allowed: ${String(raw ?? '')}`)
    const full = resolveWithin(base, relative)
    if (!full) throw new Error(`file-not-allowed: ${relative}`)
    let stat
    try { stat = lstat(full) } catch { throw new Error(`not-a-file: ${relative}`) }
    if (stat.isSymbolicLink?.()) throw new Error(`not-a-file: ${relative}`)
    if (stat.isDirectory()) walk(relative, full, 0)
    else if (stat.isFile()) addFile(relative, stat)
    else throw new Error(`not-a-file: ${relative}`)
  }
  if (files.length === 0) throw new Error('no-files')
  return files
}

/** 给 agent 读的交接说明。目标读者是模型，所以"文件在哪、别重做"要说清楚。 */
export function buildDigest({
  id,
  now = Date.now(),
  title = '',
  sessionId = '',
  cwd = '',
  events = [],
  files = [],
  note = '',
  sessionLive = false,
  plan = '',
  direction = 'to-phone',
} = {}) {
  const items = events.map(summarizeSessionEvent).filter(Boolean)
  const userItems = items.filter((item) => item.kind === 'user')
  const firstAsk = userItems[0]?.text ?? ''
  const lastAsk = userItems.at(-1)?.text ?? ''
  const recent = items
    .filter((item) => item.kind === 'user' || item.kind === 'assistant')
    .slice(-8)
  const tools = [...new Set(items.filter((item) => item.kind === 'tool').map((item) => item.name).filter(Boolean))]

  const lines = []
  lines.push(`# 接力说明 · ${title || '未命名会话'}`)
  lines.push('')
  lines.push(`> 由电脑上的 DSH 在 ${stamp(now)} 生成，用来把没做完的轻办公任务交接到这台 iPhone。`)
  if (sessionId) lines.push(`> 原会话：${sessionId}`)
  if (note) lines.push(`> 用户备注：${clip(note, 300)}`)
  if (sessionLive) {
    lines.push('')
    lines.push('> ⚠️ 电脑上的原会话还在运行。接着做之前先确认它已经停下，')
    lines.push('> 否则两边会同时改同一批文件。')
  }
  lines.push('')

  if (plan) {
    lines.push('## 手机端定好的计划（按这个做）')
    lines.push('')
    lines.push(clipMultiline(plan, 8000))
    lines.push('')
  }

  if (firstAsk) {
    lines.push('## 一开始要做的事')
    lines.push('')
    lines.push(clip(firstAsk, 1200))
    lines.push('')
  }

  if (lastAsk && lastAsk !== firstAsk) {
    lines.push('## 交接前最后一句')
    lines.push('')
    lines.push(clip(lastAsk, 800))
    lines.push('')
  }

  if (recent.length) {
    lines.push('## 最近的对话（从旧到新）')
    lines.push('')
    for (const item of recent) {
      const who = item.kind === 'user' ? '你' : 'agent'
      lines.push(`- **${who}**：${clip(item.text, 500)}`)
    }
    lines.push('')
  }

  if (tools.length) {
    lines.push(`期间用过的工具：${tools.map((name) => `\`${name}\``).join('、')}`)
    lines.push('')
  }

  lines.push(direction === 'to-desktop'
    ? '## 文件（都已经在这台电脑的当前目录）'
    : '## 文件（都已经在这台 iPhone 的当前目录）')
  lines.push('')
  if (files.length === 0) {
    lines.push('- （这个接力包没有带文件）')
  } else {
    for (const file of files) {
      lines.push(`- \`${file.path}\`（${humanBytes(file.bytes)}，${file.kind ?? '文件'}）`)
    }
  }
  lines.push('')

  lines.push('## 接手后怎么做')
  lines.push('')
  if (direction === 'to-desktop') {
    lines.push(`1. 先读 \`${id ? `handoff-${id}.md` : '这份说明'}\` 和上面列出的计划/文件。`)
    lines.push('2. 这些文件是从手机带过来的，就在当前目录；用相对路径访问。')
    lines.push('3. 按「手机端定好的计划」开始做；这是一台电脑，命令、构建、测试都可以跑。')
    lines.push('4. 缺关键信息时用 ask_user_question 问；用户会从手机或电脑上回答。')
    lines.push('5. 做完把结果留在当前目录，并在回复里说明改了哪些文件。')
  } else {
    lines.push(`1. 先读 \`${id ? `handoff-${id}.md` : '这份说明'}\` 和上面列出的文件，确认已经做到哪一步。`)
    lines.push('2. 这些文件原来在电脑上，现在就在当前目录；用相对路径访问，不要去找电脑上的旧路径。')
    lines.push('3. 接着用户最后的要求继续做，别从头重写已经完成的部分。')
    lines.push('4. 缺关键信息时可以直接调用 ask_user_question：用户会在手机上收到问题卡片并回答。')
    lines.push('5. 改完直接保存到当前目录；用户会从手机里把成品发出去。')
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// tar（ustar）：写与读都只覆盖接力包需要的一小部分，但格式是标准的
// ---------------------------------------------------------------------------

function octal(value, width) {
  const text = Number(value).toString(8)
  if (text.length > width - 1) throw new Error('tar-field-overflow')
  return text.padStart(width - 1, '0') + '\0'
}

function tarHeader(name, size, mtimeSeconds, mode = 0o644) {
  const buffer = Buffer.alloc(512)
  let fileName = name
  let prefix = ''

  // ustar 的 name 字段只有 100 字节；更长的名字拆进 prefix
  if (Buffer.byteLength(name) > 100) {
    const slash = name.lastIndexOf('/')
    if (slash > 0 && Buffer.byteLength(name.slice(slash + 1)) <= 100) {
      prefix = name.slice(0, slash)
      fileName = name.slice(slash + 1)
      if (Buffer.byteLength(prefix) > 155) throw new Error('tar-name-too-long')
    } else {
      throw new Error('tar-name-too-long')
    }
  }

  buffer.write(fileName, 0, 100, 'utf8')
  buffer.write(octal(mode, 8), 100)
  buffer.write(octal(0, 8), 108)
  buffer.write(octal(0, 8), 116)
  buffer.write(octal(size, 12), 124)
  buffer.write(octal(mtimeSeconds, 12), 136)
  buffer.write('        ', 148) // 校验和先填空格
  buffer.write('0', 156)
  buffer.write('ustar\0', 257)
  buffer.write('00', 263)
  if (prefix) buffer.write(prefix, 345, 155, 'utf8')

  let checksum = 0
  for (const byte of buffer) checksum += byte
  buffer.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  return buffer
}

/** entries: [{ name, data: Buffer }] -> tar Buffer */
export function toTar(entries) {
  const chunks = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '')
    chunks.push(tarHeader(entry.name, data.length, entry.mtime ?? Math.floor(Date.now() / 1000)))
    chunks.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

/** 只给测试与自检用；手机端有等价的 Swift 实现。 */
export function listTar(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const name = prefix ? `${prefix}/${rawName}` : rawName
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('tar-bad-size')
    const start = offset + 512
    if (start + size > buffer.length) throw new Error('tar-truncated')
    entries.push({ name, data: buffer.subarray(start, start + size) })
    offset = start + size + ((512 - (size % 512)) % 512)
  }
  return entries
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

/**
 * 组装一个接力包。
 * @param {object} input
 * @param {Array<{path:string,data:Buffer,bytes:number,kind:string,sha256:string}>} input.files
 */
export function createBundle({
  id = newId(),
  now = Date.now(),
  session = {},
  title = '',
  events = [],
  files = [],
  note = '',
  source = {},
  plan = '',
  direction = 'to-phone',
} = {}) {
  if (!isValidId(id)) throw new Error('bad-id')
  // 允许零附件：手机可以只把「计划」发到电脑（纯计划接力）。
  if (!Array.isArray(files)) throw new Error('bad-files')

  const manifest = {
    schema: 1,
    id,
    direction: direction === 'to-desktop' ? 'to-desktop' : 'to-phone',
    createdAt: now,
    source: {
      service: 'pocket-whale',
      // 安装包版本（用户用来判断桌面加载的是不是新版）与协议版本分开上报。
      version: PLUGIN_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform,
      ...source,
    },
    session: {
      id: session.id ?? null,
      title: title || null,
      cwd: session.cwd ?? null,
      live: Boolean(session.live),
    },
    files: files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      kind: file.kind,
    })),
    note: note ? clip(note, 500) : null,
  }

  const digest = buildDigest({
    id,
    now,
    title,
    sessionId: session.id ?? '',
    cwd: session.cwd ?? '',
    events,
    files,
    note,
    sessionLive: Boolean(session.live),
    plan,
    direction,
  })

  const tar = toTar([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: Math.floor(now / 1000) },
    { name: 'handoff.md', data: Buffer.from(digest, 'utf8'), mtime: Math.floor(now / 1000) },
    ...files.map((file) => ({
      name: `files/${file.path}`,
      data: file.data,
      mtime: Math.floor(now / 1000),
    })),
  ])

  return { manifest, digest, tar }
}

/**
 * 解析一个收到的接力包（电脑端 /pocket/handoff/receive 用）。
 * 校验不过整包拒绝，不做部分写入。
 */
export function parseHandoff(tar) {
  const entries = listTar(tar)
  if (entries.length === 0 || entries.length > MAX_FILES + 8) throw new Error('too-many-entries')

  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) throw new Error('missing-manifest')
  let manifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'))
  } catch {
    throw new Error('bad-manifest')
  }
  if (manifest?.schema !== 1) throw new Error('unsupported-schema')
  if (!isValidId(manifest.id)) throw new Error('bad-id')

  const briefEntry = entries.find((entry) => entry.name === 'handoff.md')
  const brief = briefEntry ? briefEntry.data.toString('utf8') : ''

  const files = []
  let total = 0
  for (const entry of entries) {
    if (!entry.name.startsWith('files/')) continue
    const name = normalizeRelativePath(entry.name.slice('files/'.length))
    if (!name) throw new Error(`bad-file-name: ${entry.name}`)
    if (entry.data.length > MAX_FILE_BYTES) throw new Error(`file-too-large: ${name}`)
    total += entry.data.length
    if (total > MAX_TOTAL_BYTES) throw new Error('bundle-too-large')
    if (files.length >= MAX_FILES) throw new Error('too-many-files')
    files.push({ name, data: entry.data })
  }

  return { manifest, brief, files }
}

// ---------------------------------------------------------------------------
// 仓库：落盘 + 列表 + 读回
// ---------------------------------------------------------------------------

export class HandoffStore {
  #dir
  #clock
  #fs

  constructor({ dir, clock = () => Date.now(), fs: fileSystem = fs } = {}) {
    if (!dir) throw new Error('missing-dir')
    this.#dir = dir
    this.#clock = clock
    this.#fs = fileSystem
  }

  get dir() {
    return this.#dir
  }

  #ensure() {
    this.#fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
  }

  #tarPath(id) {
    if (!isValidId(id)) throw new Error('bad-id')
    return path.join(this.#dir, `${id}${HANDOFF_EXT}`)
  }

  #jsonPath(id) {
    if (!isValidId(id)) throw new Error('bad-id')
    return path.join(this.#dir, `${id}.json`)
  }

  save(manifest, tar) {
    this.#ensure()
    const tarPath = this.#tarPath(manifest.id)
    const jsonPath = this.#jsonPath(manifest.id)
    const tarTmp = `${tarPath}.tmp`
    const jsonTmp = `${jsonPath}.tmp`
    this.#fs.writeFileSync(tarTmp, tar, { mode: 0o600 })
    this.#fs.renameSync(tarTmp, tarPath)
    this.#fs.writeFileSync(jsonTmp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    this.#fs.renameSync(jsonTmp, jsonPath)
    return manifest.id
  }

  list() {
    let names = []
    try {
      names = this.#fs.readdirSync(this.#dir)
    } catch {
      return []
    }
    const rows = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!isValidId(id)) continue
      try {
        const manifest = JSON.parse(this.#fs.readFileSync(path.join(this.#dir, name), 'utf8'))
        const stat = this.#fs.statSync(this.#tarPath(id))
        rows.push({
          id,
          createdAt: manifest.createdAt ?? 0,
          session: manifest.session ?? null,
          note: manifest.note ?? null,
          files: (manifest.files ?? []).map((file) => ({
            path: file.path,
            bytes: file.bytes,
            kind: file.kind,
          })),
          bytes: stat.size,
        })
      } catch {
        // 半写/被手动删掉的包不阻塞列表
      }
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }

  read(id) {
    const manifest = JSON.parse(this.#fs.readFileSync(this.#jsonPath(id), 'utf8'))
    const tar = this.#fs.readFileSync(this.#tarPath(id))
    return { manifest, tar }
  }

  remove(id) {
    let removed = false
    try {
      this.#fs.unlinkSync(this.#tarPath(id))
      removed = true
    } catch {}
    try {
      this.#fs.unlinkSync(this.#jsonPath(id))
      removed = true
    } catch {}
    return removed
  }

  /** 清掉过期包，返回被清掉的数量。 */
  sweep(ttl = BUNDLE_TTL_MS) {
    const now = this.#clock()
    let count = 0
    for (const row of this.list()) {
      if (now - row.createdAt > ttl) {
        if (this.remove(row.id)) count += 1
      }
    }
    return count
  }
}
