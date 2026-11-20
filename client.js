window.__ModuleLoader__.load({
  id: 'dsh-pocket-whale',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useCallback } = React

    const COLORS = {
      accent: '#5b5bd6',
      warn: '#f0a020',
      ok: '#3fa34d',
      danger: '#d05050',
      border: '1px solid rgba(128,128,128,0.24)',
      subtleBorder: '1px solid rgba(128,128,128,0.4)',
    }

    const buttonBase = {
      padding: '6px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      fontSize: 13,
      font: 'inherit',
    }

    const cardStyle = {
      background: 'Canvas',
      color: 'CanvasText',
      border: COLORS.border,
      borderRadius: 14,
      boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
      backdropFilter: 'blur(12px)',
    }

    const LABELS = {
      title: '口袋鲸',
      subtitle: '手机 agent · 接力',
      tabHandoff: '接力',
      tabDevices: '设备',
      tabSettings: '设置',
    }

    // ---------------------------------------------------------------------
    // 本地偏好（入口显隐、面板位置）
    // ---------------------------------------------------------------------

    const PREF = {
      entryVisible: 'pocket.entryVisible',
      tab: 'pocket.panelTab',
      panelPos: 'pocket.panelPos',
      launcherPos: 'pocket.launcherPos',
    }

    function readPref(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        if (raw === null) return fallback
        return JSON.parse(raw)
      } catch (error) {
        return fallback
      }
    }

    function writePref(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch (error) { /* 隐私模式 / 配额满：不影响功能 */ }
    }

    /** 截图/调试：?pocket=handoff|devices|settings 直接打开对应页签。 */
    function debugPanel() {
      try {
        const value = new URLSearchParams(window.location.search).get('pocket')
        return value === 'handoff' || value === 'devices' || value === 'settings' ? value : null
      } catch (error) {
        return null
      }
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max))
    }

    // ---------------------------------------------------------------------
    // 同源接口
    // ---------------------------------------------------------------------

    async function getJson(path) {
      const res = await fetch(path, { credentials: 'same-origin' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status)
      return body
    }

    async function postJson(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    /** 插件自起的 0.0.0.0 网关（配对与 /lan/* 管理接口）。 */
    async function resolveGateway() {
      const status = await getJson('/pocket/status')
      if (!status.lanPort) throw new Error('局域网网关没有启动')
      return { status, gateway: 'http://127.0.0.1:' + status.lanPort }
    }

    function meta(device) {
      return [device.model, device.systemVersion, device.address].filter(Boolean).join(' · ')
    }

    // ---------------------------------------------------------------------
    // 小部件
    // ---------------------------------------------------------------------

    function Switch(props) {
      return h('label', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 },
      },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', null, props.label))
    }

    function Hint(props) {
      return h('div', {
        style: { fontSize: 12, lineHeight: 1.55, opacity: 0.62 },
      }, props.children)
    }

    function ErrorBox(props) {
      if (!props.children) return null
      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 6,
          fontSize: 12, lineHeight: 1.5, color: COLORS.danger,
          padding: '8px 10px', borderRadius: 8,
          background: 'rgba(208,80,80,0.08)',
        },
      },
        h('span', { style: { flex: '0 0 auto' } }, '⚠'),
        h('span', { style: { flex: 1, minWidth: 0 } }, props.children))
    }

    function SpinnerStyle() {
      // 组件级样式：卸载即消失，不需要额外注册
      return h('style', null, '@keyframes pocket-spin{to{transform:rotate(360deg)}}')
    }

    // ---------------------------------------------------------------------
    // 接力
    // ---------------------------------------------------------------------

    function HandoffSection(props) {
      const { gateway, currentSessionId } = props
      const [sessions, setSessions] = useState([])
      const [query, setQuery] = useState('')
      const [sessionId, setSessionId] = useState(currentSessionId || null)
      const [candidates, setCandidates] = useState(null)
      const [picked, setPicked] = useState({})
      const [note, setNote] = useState('')
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [folderPath, setFolderPath] = useState('')
      const [folderLoading, setFolderLoading] = useState(false)
      const [folderError, setFolderError] = useState(null)

      const loadSessions = useCallback(async function () {
        try {
          const body = await getJson('/pocket/sessions')
          const list = (body.sessions || []).filter(function (item) { return item.id })
          setSessions(list)
          setError(null)
          const target = (currentSessionId && list.find(function (s) { return s.id === currentSessionId }))
            || (sessionId && list.find(function (s) { return s.id === sessionId }))
            || list[0]
          if (target) await select(target.id)
        } catch (error) {
          setError('读不到会话：' + error.message)
        }
      }, [currentSessionId])

      const select = useCallback(async function (id) {
        setSessionId(id)
        setFolderPath('')
        setFolderLoading(false)
        setFolderError(null)
        setCandidates(null)
        setResult(null)
        try {
          const body = await getJson('/pocket/handoff/candidates?sessionId=' + encodeURIComponent(id))
          if (!body.ok) throw new Error(body.error || '读取失败')
          setCandidates(body)
          const next = {}
          ;(body.files || []).forEach(function (file) {
            if (file.recommended && !file.tooLarge) next[file.path] = true
          })
          setPicked(next)
          setError(null)
        } catch (error) {
          setError(error.message)
        }
      }, [])

      const openFolder = useCallback(async function (nextPath) {
        if (!sessionId) return
        setFolderLoading(true)
        setFolderError(null)
        try {
          const body = await getJson('/pocket/handoff/candidates?sessionId=' + encodeURIComponent(sessionId)
            + '&path=' + encodeURIComponent(nextPath || ''))
          if (!body.ok) throw new Error(body.error || '读取文件夹失败')
          setCandidates(body)
          setFolderPath(nextPath || '')
          setPicked(function (old) {
            const merged = Object.assign({}, old)
            ;(body.files || []).forEach(function (file) {
              if (file.recommended && !file.tooLarge) merged[file.path] = true
            })
            return merged
          })
        } catch (error) {
          setFolderError(error.message)
        } finally {
          setFolderLoading(false)
        }
      }, [sessionId])

      useEffect(function () { loadSessions() }, [])

      // 侧边栏切换会话时，跟着把候选文件切过去
      useEffect(function () {
        if (currentSessionId && currentSessionId !== sessionId) select(currentSessionId)
      }, [currentSessionId])

      const listRef = useRef(null)
      useEffect(function () {
        const node = listRef.current && listRef.current.querySelector('[data-current="true"]')
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
      }, [currentSessionId, sessions.length])

      const files = (candidates && candidates.files) || []
      const filteredSessions = sessions.filter(function (session) {
        if (!query.trim()) return true
        return (session.title || '未命名会话').toLowerCase().includes(query.trim().toLowerCase())
      })
      const count = Object.keys(picked).filter(function (key) { return picked[key] }).length
      const current = sessions.find(function (item) { return item.id === sessionId })

      async function create() {
        if (!sessionId || busy) return
        setBusy(true)
        setError(null)
        try {
          const chosen = Object.keys(picked).filter(function (key) { return picked[key] })
          const body = await postJson('/pocket/handoff/create', {
            sessionId: sessionId,
            files: chosen,
            note: note,
          })
          setResult(body.bundle)
        } catch (error) {
          setError(error.message)
        } finally {
          setBusy(false)
        }
      }

      if (result) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: 4,
              padding: '10px 12px', borderRadius: 10,
              background: 'rgba(63,163,77,0.08)',
            },
          },
            h('div', { style: { color: COLORS.ok, fontWeight: 600, fontSize: 13 } }, '接力包已生成'),
            h('div', { style: { fontSize: 12, opacity: 0.75 } },
              (result.session && result.session.title ? result.session.title + ' · ' : '')
              + result.files.length + ' 个文件 · ' + (result.bytes / 1024).toFixed(1) + ' KB'),
            h('div', { style: { fontSize: 12, lineHeight: 1.6, opacity: 0.72 } },
              '打开手机 App →「接力」→ 接收。手机不在同一 Wi-Fi 时，也可以直接下载：'),
            h('a', {
              href: result.downloadPath,
              style: { color: COLORS.accent, fontSize: 12 },
            }, '下载 .pockethandoff')),
          h('button', {
            onClick: function () { setResult(null) },
            style: Object.assign({}, buttonBase, { border: COLORS.subtleBorder, background: 'transparent', color: 'inherit', alignSelf: 'flex-start' }),
          }, '再打一个'))
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(Hint, null, '把电脑上没做完的轻办公文件（docx / xlsx / pptx / pdf / md / txt / 图片）打包，手机接收后接着做。'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, flex: 1 } }, '选一个会话'),
          h('button', {
            onClick: loadSessions,
            style: Object.assign({}, buttonBase, { padding: '2px 8px', border: 'none', background: 'transparent', color: COLORS.accent }),
          }, '刷新')),
        sessions.length === 0
          ? h(Hint, null, '还没有可接力的会话。先开会话、聊到一半再回来。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            folderPath
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                h('button', {
                  onClick: function () { openFolder(folderPath.split('/').slice(0, -1).join('/')) },
                  style: Object.assign({}, buttonBase, { padding: '2px 8px', border: COLORS.border, background: 'transparent', color: 'inherit' }),
                }, '← 上级'),
                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7 } },
                  '当前文件夹：' + folderPath))
              : null,
            folderLoading ? h(Hint, null, '正在读取文件夹…') : null,
            folderError ? h(ErrorBox, null, folderError) : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                value: query,
                placeholder: '搜会话标题…',
                onChange: function (event) { setQuery(event.target.value) },
                style: {
                  flex: 1, minWidth: 0, fontSize: 12, padding: '6px 9px', borderRadius: 8,
                  border: COLORS.border, background: 'transparent', color: 'inherit',
                },
              }),
              h('span', { style: { fontSize: 11, opacity: 0.5, flex: '0 0 auto' } },
                filteredSessions.length + ' / ' + sessions.length)),
            h('div', {
              ref: listRef,
              style: {
                display: 'flex', flexDirection: 'column', gap: 6,
                maxHeight: 190, overflowY: 'auto', overscrollBehavior: 'contain',
                paddingRight: 4,
              },
            },
              filteredSessions.length === 0
                ? h(Hint, null, '没有匹配的会话。')
                : filteredSessions.map(function (session) {
                  const active = session.id === sessionId
                  const isCurrent = Boolean(currentSessionId) && session.id === currentSessionId
                  return h('button', {
                    key: session.id,
                    onClick: function () { select(session.id) },
                    'data-current': isCurrent ? 'true' : undefined,
                    title: isCurrent ? '当前会话' : undefined,
                    style: Object.assign({}, buttonBase, {
                      textAlign: 'left',
                      border: isCurrent
                        ? '1px solid ' + COLORS.accent
                        : active ? '1px solid ' + COLORS.accent : COLORS.border,
                      background: isCurrent
                        ? 'rgba(91,91,214,0.16)'
                        : active ? 'rgba(91,91,214,0.10)' : 'transparent',
                      color: isCurrent ? COLORS.accent : 'inherit',
                      fontWeight: isCurrent ? 600 : 500,
                      boxShadow: isCurrent ? 'inset 3px 0 0 ' + COLORS.accent : 'none',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      flex: '0 0 auto',
                    }),
                  }, (session.title || '未命名会话')
                    + (isCurrent ? ' · 当前会话' : '')
                    + (session.live ? ' · 运行中' : ''))
                }))),
        candidates
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, '带过去哪些文件/文件夹'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 180, overflowY: 'auto' } },
              files.length === 0
                ? h(Hint, null, '这个目录里没有可接力的文件。')
                : files.slice(0, 60).map(function (file) {
                  const on = Boolean(picked[file.path])
                  const folder = Boolean(file.isDirectory)
                  const emptyFolder = folder && Number(file.fileCount || 0) === 0
                  const disabled = Boolean(file.tooLarge) || emptyFolder
                  const detail = folder
                    ? (emptyFolder ? '空文件夹' : disabled ? '超过 25MB/60MB/40 个文件限制' : String(file.fileCount || 0) + ' 个文件')
                    : (file.tooLarge ? '超过单文件 25MB' : String(file.kind || '文件'))
                  return h('div', {
                    key: file.path,
                    title: file.path,
                    style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: disabled ? 0.6 : 1 },
                  },
                    h('label', {
                      style: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: disabled ? 'not-allowed' : 'pointer' },
                    },
                      h('input', {
                        type: 'checkbox',
                        checked: on,
                        disabled,
                        onChange: function () {
                          if (disabled) return
                          setPicked(function (old) {
                            const next = Object.assign({}, old)
                            next[file.path] = !on
                            return next
                          })
                        },
                      }),
                      h('span', { style: { opacity: 0.7, flex: '0 0 auto' } }, folder ? '▸' : '·'),
                      h('span', {
                        style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      }, file.path)),
                    h('span', { style: { opacity: 0.45, fontSize: 11, flex: '0 0 auto' } }, detail),
                    folder
                      ? h('button', {
                        onClick: function () { openFolder(file.path) },
                        disabled: folderLoading,
                        style: Object.assign({}, buttonBase, { padding: '2px 7px', border: COLORS.border, background: 'transparent', color: COLORS.accent, flex: '0 0 auto' }),
                      }, '打开 ›')
                      : null)
                })),
            h('input', {
              value: note,
              placeholder: '给手机上的自己留一句备注（可空）',
              onChange: function (event) { setNote(event.target.value) },
              style: {
                fontSize: 12, padding: '7px 9px', borderRadius: 8,
                border: COLORS.border, background: 'transparent', color: 'inherit',
              },
            }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('div', { style: { fontSize: 11, opacity: 0.55, flex: 1 } },
                current && current.live ? '注意：这个会话还在跑，手机接手前先在电脑上停掉。' : ''),
              h('button', {
                onClick: create,
                disabled: busy || count === 0,
                style: Object.assign({}, buttonBase, {
                  border: 'none', background: COLORS.accent, color: '#fff',
                  opacity: busy || count === 0 ? 0.5 : 1,
                }),
              }, busy ? '打包中…' : '生成接力包（' + count + '）')))
          : h(Hint, null, sessionId ? '正在读取文件…' : '先选一个会话。'),
        h(ErrorBox, null, error))
    }

    // ---------------------------------------------------------------------
    // 设备
    // ---------------------------------------------------------------------

    function DevicesSection(props) {
      const { gateway, status } = props
      const [pending, setPending] = useState([])
      const [devices, setDevices] = useState([])
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)

      useEffect(function () {
        let alive = true
        let timer = null

        async function tick() {
          if (!gateway) return
          try {
            const [pRes, dRes] = await Promise.all([
              fetch(gateway + '/lan/pending', { credentials: 'same-origin' }),
              fetch(gateway + '/lan/devices', { credentials: 'same-origin' }),
            ])
            if (!alive) return
            if (pRes.ok) setPending(((await pRes.json()).pending) || [])
            if (dRes.ok) setDevices(((await dRes.json()).devices) || [])
            setError(null)
          } catch (error) {
            if (alive) setError('管理接口不可用：' + error.message)
          }
          if (alive) timer = setTimeout(tick, 2500)
        }

        tick()
        return function cleanup() {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [gateway])

      async function decide(id, allow) {
        if (!gateway) return
        setBusy(id)
        try {
          await postJson(gateway + '/lan/' + (allow ? 'approve' : 'deny'), { id })
          setPending(function (list) { return list.filter(function (item) { return item.id !== id }) })
          const res = await fetch(gateway + '/lan/devices', { credentials: 'same-origin' })
          if (res.ok) setDevices(((await res.json()).devices) || [])
        } catch (error) {
          setError(error.message)
        } finally {
          setBusy(null)
        }
      }

      async function revoke(id) {
        if (!gateway) return
        try {
          await postJson(gateway + '/lan/revoke', { id })
          setDevices(function (list) { return list.filter(function (item) { return item.id !== id }) })
        } catch (error) {
          setError(error.message)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(Hint, null, '手机和电脑连同一个 Wi-Fi。手机 App 里点「查找附近的 DSH」，这里会出现一条待确认请求。'),
        pending.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, color: COLORS.warn } }, '等待你允许'),
            pending.map(function (device) {
              return h('div', {
                key: device.id,
                style: {
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 10,
                  border: '1px solid rgba(240,160,32,0.35)',
                  background: 'rgba(240,160,32,0.07)',
                },
              },
                h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: { fontWeight: 600, fontSize: 12 } }, device.name || '未知设备'),
                  h('span', { style: { opacity: 0.65, fontSize: 11 } }, meta(device)),
                  h('span', { style: { opacity: 0.5, fontSize: 11, fontFamily: 'monospace' } },
                    '验证码 ' + (device.shortCode || '----'))),
                h('div', { style: { display: 'flex', gap: 6 } },
                  h('button', {
                    onClick: function () { decide(device.id, false) },
                    disabled: busy === device.id,
                    style: Object.assign({}, buttonBase, { padding: '4px 9px', border: COLORS.subtleBorder, background: 'transparent', color: 'inherit' }),
                  }, '拒绝'),
                  h('button', {
                    onClick: function () { decide(device.id, true) },
                    disabled: busy === device.id,
                    style: Object.assign({}, buttonBase, { padding: '4px 9px', border: 'none', background: COLORS.accent, color: '#fff' }),
                  }, busy === device.id ? '处理中…' : '允许')))
            }))
          : null,
        h('div', { style: { fontSize: 12, fontWeight: 600 } }, '已配对设备'),
        devices.length === 0
          ? h(Hint, null, '还没有配对设备。手机 App → 设置 → 运行位置选「这台 iPhone」，或直接连接电脑。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            devices.map(function (device) {
              return h('div', {
                key: device.id,
                style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
              },
                h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
                  h('span', { style: { fontWeight: 500 } }, device.name || '未知设备'),
                  h('span', { style: { opacity: 0.55, fontSize: 11 } }, meta(device))),
                h('button', {
                  onClick: function () { revoke(device.id) },
                  style: Object.assign({}, buttonBase, { padding: '3px 8px', border: COLORS.subtleBorder, background: 'transparent', color: COLORS.danger }),
                }, '断开'))
            })),
        h('div', {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 11,
            opacity: 0.55, paddingTop: 2,
          },
        },
          status ? h('span', null, '宿主 ' + status.version) : null,
          status && status.lanPort ? h('span', null, '局域网端口 ' + status.lanPort) : null,
          status && status.questions ? h('span', null, '手机' + (status.questions.phoneForeground ? '在前台' : '未在前台')) : null),
        h(ErrorBox, null, error))
    }

    // ---------------------------------------------------------------------
    // 设置
    // ---------------------------------------------------------------------

    function SettingsSection(props) {
      const { status, sidebarAvailable, onResetPosition, entryVisible, onEntryVisible } = props
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, '入口'),
          sidebarAvailable
            ? h(Switch, { checked: entryVisible, onChange: onEntryVisible, label: '显示右下角浮动入口' })
            : h(Hint, null, '浮动入口是当前唯一的入口；安装 dsh-better-sidebar 后可以关掉它，改用侧边栏。'),
          h('button', {
            onClick: onResetPosition,
            style: Object.assign({}, buttonBase, { border: COLORS.subtleBorder, background: 'transparent', color: 'inherit', alignSelf: 'flex-start' }),
          }, '复位面板位置'),
          h(Hint, null, sidebarAvailable
            ? '已注册到侧边栏：右侧栏的 + 菜单里可以打开「口袋鲸」，和浮动入口是同一页。'
            : '安装 dsh-better-sidebar 后，同一个页面也会出现在右侧栏的 + 菜单里。')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, '这个插件做什么'),
          h(Hint, null, '电脑 → 手机：把没做完的文件和交接说明打包，手机接收后接着做，做完从系统分享面板发到微信 / QQ / 邮件。'),
          h(Hint, null, '手机 → 电脑：在手机上把项目计划定好，发到电脑，电脑上的 agent 按计划开工。'),
          h(Hint, null, '手机端还能回答 ask_user_question；手表上可以直接答单题单选。')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, '运行信息'),
          h('div', { style: { fontSize: 11, opacity: 0.6, fontFamily: 'monospace', lineHeight: 1.7 } },
            '插件 ' + (status ? status.version : '—')
            + (status && status.lanPort ? ' · 网关 ' + status.lanPort : '')
            + (status ? ' · 待批 ' + (status.pending || 0) : ''))),
        h('div', { style: { fontSize: 11, opacity: 0.45, lineHeight: 1.6 } },
          '面板和入口都可以拖动；位置会记在这个浏览器里。'))
    }

    // 侧边栏服务是异步出现的：用一个极小的订阅让已挂载的面板跟着刷新
    const sidebarState = { value: false, listeners: new Set() }

    function markSidebarAvailable() {
      sidebarState.value = true
      for (const listener of sidebarState.listeners) listener()
    }

    function useSidebarAvailable() {
      const [value, setValue] = useState(sidebarState.value)
      useEffect(function () {
        const listener = function () { setValue(sidebarState.value) }
        sidebarState.listeners.add(listener)
        listener()
        return function () { sidebarState.listeners.delete(listener) }
      }, [])
      return value
    }

    // ---------------------------------------------------------------------
    // 面板
    // ---------------------------------------------------------------------

    function PanelBody(props) {
      const { tab, setTab, status, gateway, currentSessionId, sidebarAvailable, onResetPosition, entryVisible, onEntryVisible } = props
      return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h('div', { style: { display: 'flex', gap: 2, padding: '0 12px 8px', borderBottom: COLORS.border } },
          [[LABELS.tabHandoff, 'handoff'], [LABELS.tabDevices, 'devices'], [LABELS.tabSettings, 'settings']].map(function (pair) {
            const active = tab === pair[1]
            return h('button', {
              key: pair[1],
              onClick: function () { setTab(pair[1]) },
              style: Object.assign({}, buttonBase, {
                padding: '6px 10px',
                border: 'none',
                borderBottom: '2px solid ' + (active ? COLORS.accent : 'transparent'),
                borderRadius: 0,
                background: 'transparent',
                color: active ? COLORS.accent : 'inherit',
                opacity: active ? 1 : 0.6,
                fontWeight: active ? 600 : 500,
              }),
            }, pair[0])
          })),
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 } },
          tab === 'devices'
            ? h(DevicesSection, { gateway, status })
            : tab === 'settings'
              ? h(SettingsSection, {
                status, sidebarAvailable, onResetPosition,
                entryVisible, onEntryVisible,
              })
              : h(HandoffSection, { gateway, currentSessionId })))
    }

    function PanelHeader(props) {
      return h('div', {
        onPointerDown: props.onDragStart,
        onPointerMove: props.onDragMove,
        onPointerUp: props.onDragEnd,
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', cursor: 'move', userSelect: 'none',
          borderBottom: COLORS.border,
        },
      },
        h('span', {
          style: { width: 8, height: 8, borderRadius: 4, background: props.online ? COLORS.ok : COLORS.warn, flex: '0 0 auto' },
        }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 13, fontWeight: 700, lineHeight: 1.3 } }, LABELS.title),
          h('div', { style: { fontSize: 11, opacity: 0.55, lineHeight: 1.3 } }, LABELS.subtitle)),
        props.onClose
          ? h('button', {
            onClick: props.onClose,
            onPointerDown: function (event) { event.stopPropagation() },
            style: Object.assign({}, buttonBase, { padding: '2px 8px', border: 'none', background: 'transparent', color: 'inherit', opacity: 0.55 }),
            'aria-label': '关闭',
          }, '✕')
          : null)
    }

    // ---------------------------------------------------------------------
    // 浮动入口：一个可拖动的小胶囊 + 一个可拖动的面板
    // ---------------------------------------------------------------------

    function FloatingEntry(props) {
      const [gateway, setGateway] = useState(null)
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [open, setOpen] = useState(function () { return Boolean(debugPanel()) })
      const [tab, setTabState] = useState(function () { return debugPanel() || readPref(PREF.tab, 'handoff') })
      const [entryVisible, setEntryVisible] = useState(function () { return readPref(PREF.entryVisible, true) })
      const sidebarAvailable = useSidebarAvailable()
      const [pendingCount, setPendingCount] = useState(0)
      const [currentSessionId, setCurrentSessionId] = useState(function () {
        try { return props.getCurrentSessionId ? props.getCurrentSessionId() : null } catch (error) { return null }
      })
      const [launcherPos, setLauncherPos] = useState(function () {
        return readPref(PREF.launcherPos, null) || { x: Math.max(16, window.innerWidth - 150), y: Math.max(16, window.innerHeight - 140) }
      })
      const [panelPos, setPanelPos] = useState(function () {
        const stored = readPref(PREF.panelPos, null)
        if (stored) return stored
        return { x: Math.max(16, window.innerWidth - 410), y: Math.max(16, window.innerHeight - 620) }
      })
      const drag = useRef(null)

      function setTab(next) {
        setTabState(next)
        writePref(PREF.tab, next)
      }

      useEffect(function () {
        let alive = true
        let timer = null
        async function tick() {
          try {
            const resolved = await resolveGateway()
            if (!alive) return
            setGateway(resolved.gateway)
            setStatus(resolved.status)
            setError(null)
            try {
              const pending = await getJson(resolved.gateway + '/lan/pending')
              if (alive) setPendingCount((pending.pending || []).length)
            } catch (e) { /* 面板里会显示 */ }
          } catch (error) {
            if (alive) setError('电脑端插件还没就绪：' + error.message)
          }
          if (alive) timer = setTimeout(tick, 5000)
        }
        tick()
        return function cleanup() {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      useEffect(function () {
        function syncCurrent() {
          try {
            const next = props.getCurrentSessionId ? props.getCurrentSessionId() : null
            setCurrentSessionId(function (old) { return old === next ? old : next })
          } catch (error) { /* DSH 还没挂载会话服务 */ }
        }
        syncCurrent()
        const timer = setInterval(syncCurrent, 1500)
        return function () { clearInterval(timer) }
      }, [])

      useEffect(function () {
        function onStorage() { setEntryVisible(readPref(PREF.entryVisible, true)) }
        window.addEventListener('storage', onStorage)
        return function () { window.removeEventListener('storage', onStorage) }
      }, [])

      function startDrag(event, kind) {
        if (event.button !== undefined && event.button !== 0) return
        const pos = kind === 'launcher' ? launcherPos : panelPos
        drag.current = {
          kind,
          dx: event.clientX - pos.x,
          dy: event.clientY - pos.y,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        }
        if (event.currentTarget.setPointerCapture) {
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch (e) {}
        }
      }

      function moveDrag(event) {
        const state = drag.current
        if (!state) return
        const width = state.kind === 'launcher' ? 130 : Math.min(370, window.innerWidth - 20)
        const height = state.kind === 'launcher' ? 44 : Math.min(560, window.innerHeight - 20)
        const x = clamp(event.clientX - state.dx, 8, window.innerWidth - width - 8)
        const y = clamp(event.clientY - state.dy, 8, window.innerHeight - height - 8)
        if (Math.abs(event.clientX - state.startX) > 3 || Math.abs(event.clientY - state.startY) > 3) state.moved = true
        if (state.kind === 'launcher') setLauncherPos({ x, y })
        else setPanelPos({ x, y })
      }

      function endDrag() {
        const state = drag.current
        if (!state) return
        drag.current = null
        if (state.kind === 'launcher') {
          writePref(PREF.launcherPos, launcherPos)
          if (!state.moved) setOpen(function (value) { return !value })
        } else {
          writePref(PREF.panelPos, panelPos)
        }
      }

      function resetPosition() {
        const launcher = { x: Math.max(16, window.innerWidth - 150), y: Math.max(16, window.innerHeight - 140) }
        const panel = { x: Math.max(16, window.innerWidth - 410), y: Math.max(16, window.innerHeight - 620) }
        setLauncherPos(launcher)
        setPanelPos(panel)
        writePref(PREF.launcherPos, launcher)
        writePref(PREF.panelPos, panel)
      }

      if (!entryVisible) return null

      return h(React.Fragment, null,
        h(SpinnerStyle),
        h('div', {
          onPointerDown: function (event) { startDrag(event, 'launcher') },
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          style: Object.assign({}, cardStyle, {
            position: 'fixed',
            left: launcherPos.x,
            top: launcherPos.y,
            zIndex: 9998,
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 12px', borderRadius: 999, cursor: 'grab',
            fontSize: 12, fontWeight: 600, userSelect: 'none', touchAction: 'none',
          }),
          title: '拖动可以换位置；点一下打开',
        },
          h('span', {
            style: { width: 8, height: 8, borderRadius: 4, background: gateway ? COLORS.accent : COLORS.warn },
          }),
          '口袋鲸',
          pendingCount > 0
            ? h('span', {
              style: {
                minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px',
                background: COLORS.warn, color: '#fff', fontSize: 10,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              },
            }, pendingCount)
            : null),
        open
          ? h('div', {
            style: Object.assign({}, cardStyle, {
              position: 'fixed',
              left: panelPos.x,
              top: panelPos.y,
              width: 370,
              maxWidth: 'calc(100vw - 16px)',
              height: 560,
              maxHeight: 'calc(100vh - 16px)',
              zIndex: 9999,
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
            }),
          },
            h(PanelHeader, {
              online: Boolean(gateway),
              onClose: function () { setOpen(false) },
              onDragStart: function (event) { startDrag(event, 'panel') },
              onDragMove: moveDrag,
              onDragEnd: endDrag,
            }),
            h(PanelBody, {
              tab, setTab, status, gateway,
              currentSessionId,
              sidebarAvailable,
              onResetPosition: resetPosition,
              entryVisible,
              onEntryVisible: function (value) {
                setEntryVisible(value)
                writePref(PREF.entryVisible, value)
              },
            }),
            error
              ? h('div', { style: { padding: '0 12px 10px' } }, h(ErrorBox, null, error))
              : null)
          : null)
    }

    // ---------------------------------------------------------------------
    // better-sidebar 标签页（可选）
    // ---------------------------------------------------------------------

    function SidebarTab(props) {
      const [gateway, setGateway] = useState(null)
      const [status, setStatus] = useState(null)
      const [tab, setTabState] = useState('handoff')
      const [entryVisible, setEntryVisible] = useState(function () { return readPref(PREF.entryVisible, true) })
      const sessionId = props.scope && props.scope.sessionId

      useEffect(function () {
        let alive = true
        resolveGateway().then(function (resolved) {
          if (!alive) return
          setGateway(resolved.gateway)
          setStatus(resolved.status)
        }).catch(function () {})
        return function () { alive = false }
      }, [])

      function setTab(next) { setTabState(next) }

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      },
        h(PanelBody, {
          tab, setTab, status, gateway,
          currentSessionId: sessionId || null,
          sidebarAvailable: true,
          onResetPosition: function () {
            writePref(PREF.panelPos, null)
            writePref(PREF.launcherPos, null)
          },
          entryVisible,
          onEntryVisible: function (value) {
            setEntryVisible(value)
            writePref(PREF.entryVisible, value)
          },
        }))
    }

    function SidebarSettings(props) {
      const [status, setStatus] = useState(null)
      const [devices, setDevices] = useState([])
      const [entryVisible, setEntryVisible] = useState(function () { return readPref(PREF.entryVisible, true) })
      const [error, setError] = useState(null)

      useEffect(function () {
        let alive = true
        async function load() {
          try {
            const resolved = await resolveGateway()
            if (!alive) return
            setStatus(resolved.status)
            const res = await fetch(resolved.gateway + '/lan/devices', { credentials: 'same-origin' })
            if (res.ok) setDevices(((await res.json()).devices) || [])
          } catch (error) {
            if (alive) setError(error.message)
          }
        }
        load()
        return function () { alive = false }
      }, [])

      async function revoke(id) {
        try {
          const resolved = await resolveGateway()
          await postJson(resolved.gateway + '/lan/revoke', { id })
          setDevices(function (list) { return list.filter(function (item) { return item.id !== id }) })
        } catch (error) {
          setError(error.message)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
        h('div', { style: { opacity: 0.7, lineHeight: 1.6 } },
          '在侧边栏 + 菜单里打开「口袋鲸」使用接力与设备管理；这里的开关只影响右下角的浮动入口。'),
        h(Switch, {
          checked: entryVisible,
          onChange: function (value) {
            setEntryVisible(value)
            writePref(PREF.entryVisible, value)
          },
          label: '显示浮动入口',
        }),
        h('div', { style: { fontWeight: 600 } }, '已配对设备'),
        devices.length === 0
          ? h('div', { style: { opacity: 0.55 } }, '还没有配对设备。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            devices.map(function (device) {
              return h('div', { key: device.id, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  (device.name || '未知设备') + (device.model ? ' · ' + device.model : '')),
                h('button', {
                  onClick: function () { revoke(device.id) },
                  style: Object.assign({}, buttonBase, { padding: '2px 8px', border: COLORS.subtleBorder, background: 'transparent', color: COLORS.danger }),
                }, '断开'))
            })),
        status ? h('div', { style: { opacity: 0.5, fontSize: 11 } }, '插件 ' + status.version + (status.lanPort ? ' · 网关 ' + status.lanPort : '')) : null,
        h(ErrorBox, null, error))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        function resolveCurrentSessionId() {
          try {
            const uiSession = ctx.get('uiSession')
            const current = uiSession && uiSession.adapter && uiSession.adapter.current
            const value = current && current.getSnapshot ? current.getSnapshot() : null
            return (value && value.key) || null
          } catch (error) {
            return null
          }
        }

        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'pocket-entry',
            order: 100,
          }, function PocketEntry() {
            return h(FloatingEntry, { getCurrentSessionId: resolveCurrentSessionId })
          })
        })

        // better-sidebar 是可选依赖：装了就把同一页注册成侧边栏标签
        ctx.inject(['betterSidebar'], function (scope) {
          markSidebarAvailable()
          const service = scope.betterSidebar || (scope.get && scope.get('betterSidebar'))
          if (!service) return
          scope.effect(function () {
            return service.registerTab({
              id: 'pocketwhale:handoff',
              title: '口袋鲸',
              description: '电脑 ↔ 手机接力、配对的手机设备',
              order: 60,
              single: true,
              component: SidebarTab,
              settings: {
                render: function (props) {
                  return h(SidebarSettings, { service: props.service })
                },
              },
            })
          }, 'pocket: sidebar tab')
        })
      },
    }
  },
})
