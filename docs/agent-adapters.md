# 桌面适配器接入设计验证：Codex / Claude Code / OpenCode / Gemini CLI

**日期：2026-11-26** · **状态：设计验证阶段，未实现代码** · 对应 issue #7 · 仓库快照 `2c0b216`（pocket-whale 1.0.1）

> 本文只回答「能不能接、怎么接、第一版验收到什么程度」，**不包含任何实现代码**，不改动现有代码、测试与依赖。文中每条关键结论都标注证据来源：
>
> - **[官方文档]**：厂商官方文档或官方仓库文档，附链接与核实日期。
> - **[本地实测]**：2026-11-26 在本机（macOS 27.2.1，arm64）实际执行并记录原始输出。
> - **[未本地验证]**：有文档依据或第三方线索，但本次未在本机跑通；后续实现前必须补测。

---

## 0. 结论摘要

1. **第一阶段（P0）接 Codex**，走本机 app-server 的 stdio JSON-RPC。理由：本机能直接跑通握手与 `model/list`（CLI `0.171.0-alpha.13.2`，`initialize → initialized → model/list` 全部成功，见附录 A），且协议里同时具备会话新建/恢复、流式增量、中断、三类原生审批请求与 `request_user_input` 提问请求，能力覆盖首版验收的全部硬需求。
2. **第二阶段（P1）接 OpenCode 与 Claude Code**：OpenCode 是 HTTP+SSE，和现有 `/pocket/*` 的手机侧形态最接近；Claude Agent SDK 的 `canUseTool` 与 `AskUserQuestion` 语义最接近 DSH 的审批/提问，但 SDK 是进程内库、需要自带 Node/CLI 运行时，审批回调可无限挂起，必须配 `defer` 方案。
3. **Gemini CLI 放 P2**：ACP 协议本身规范（权限选项、会话载入都有），但（a）模型切换是 `unstable_*`；（b）ACP 的文件系统与终端是「客户端代理」，适配器必须自己实现 `fs/read_text_file`、`write_text_file`、`terminal/*` 等客户端能力，工作量大；（c）官方文档页顶部横幅写明 2026-06-18 起 Gemini CLI 已被 Antigravity CLI 取代（未付费/Google One 用户），上游存在被替换风险。
4. **架构上一刀切**：独立进程适配器**不能复用** Cordis 的 `sessionQuery` / `sessionController` / `approval/request` / `user-questions/request`，只能复用手机协议、局域网配对、接力包、决定记录这四层「纯逻辑」。配对确认入口、pending 重放、审批归属、版本上报必须由适配器自己实现。
5. **第一版只桥接「适配器创建或明确恢复」的会话**。既有 GUI/终端会话的可见性、实时订阅、审批归属是独立的验证课题，见 §1.5 的待验证清单，不进入首版验收。
6. **三条硬约束**（贯穿全文）：① 一次决定只作用原请求；② 同名会话绝不作为路由键；③ 宿主未提供的能力必须在 UI 明确降级，不静默假装支持。

---

## 1. 背景与目标

### 1.1 1.0.1 现状

1.0.1 是 **Cordis 宿主内插件**，通过 `package.json` 的 `dsh.bundle.patch`（`./cordis.patch.yml`）与 `dsh.client` 被 DSH 加载，在 DSH Web UI 内注册面板，同时向手机暴露一个窄 HTTP + SSE 面。

| 层 | 现状载体 | 关键事实 |
| --- | --- | --- |
| DSH 加载契约 | `package.json` → `dsh.bundle.patch` = `./cordis.patch.yml` | issue 引用的「DSH 加载契约」即此；插件不是独立 App |
| 手机协议 | `index.js` 顶部注释与路由表 | `GET /pocket/status`、`GET /pocket/sessions`、`GET /pocket/events`（SSE）、`POST /pocket/answer`（幂等）、`POST /pocket/say`、`POST /pocket/stop`、`POST /pocket/new`、`POST /pocket/models`、`POST /pocket/model`、`POST /pocket/question`、`POST /pocket/presence`、`/pocket/handoff/*` 等 |
| SSE 事件 | `/pocket/events` | `hello`、`approval/requested`、`approval/settled`、`question/requested`、`question/settled` |
| 会话服务 | `ctx.get('sessionQuery')` / `ctx.get('sessionController')` | Cordis 服务缺失时插件仍可激活，接口返回 503（插件刻意这样设计） |
| 审批 | `ctx.on('approval/request', answer, { prepend: true })` | 逻辑在 `lib/pocket-core.js` 的 `makeApprovalAnswerer` / `DecisionBook` |
| 提问 | `ctx.on('user-questions/request', answerQuestions, { prepend: true })` | issue 引用的「提问事件」即 `index.js` 约 L219 附近；手机前台才接管 `ask_user_question` |
| 局域网配对 | `lib/lan-gateway.js`（`PairingGateway`） | `/lan/pair`、`/lan/pair-status`，短码 + 桌面弹窗确认 |
| 接力包 | `lib/handoff.js` | `.pockethandoff`，单文件 25 MB / 总量 60 MB / 最多 40 个，`PROTOCOL_VERSION = '1.0.0'` |
| 决定记录 | `lib/pocket-core.js` → `DecisionBook` | 待决表 + 已决表 + TTL，`decide()` 幂等，重复决定返回已决结果 |

### 1.2 可复用与不可复用

| 能力 | 现状载体 | 独立进程适配器 | 说明 |
| --- | --- | --- | --- |
| 手机端 HTTP/SSE 协议 | `index.js` 路由 + `client.js` | **复用（需移植为独立 server）** | 手机端最好完全不需要改协议；适配器自己起一个小 HTTP server |
| 局域网配对发现 | `lib/lan-gateway.js` | **复用逻辑** | 组播发现 + 短码本来就不依赖 Cordis；可原样搬 |
| 配对**确认**入口 | 依赖 DSH Web UI 弹窗 | **必须新建** | 独立进程没有 DSH Web UI，需要菜单栏窗口/独立窗口/终端确认 |
| 接力包格式 | `lib/handoff.js` | **复用** | 纯逻辑 + 文件读写，无 Cordis 依赖（文件头注释已写明） |
| 决定记录 / 幂等 | `lib/pocket-core.js` `DecisionBook` | **复用** | 与「一次决定只作用原请求」直接对应 |
| 会话列表/发送/中断/审批/提问 | `sessionQuery` / `sessionController` / Cordis 事件 | **不可复用** | 这些服务活在 DSH 进程内，适配器只能用各宿主的原生协议重新实现 |
| DSH 面板 UI | `client.js` | 不适用于独立进程 | 独立进程需要自己的最小 UI（菜单栏/窗口） |

### 1.3 独立进程必须自备的东西

1. **设备配对确认入口**：手机输入短码后，桌面必须有一个「人可见的确认动作」（窗口/菜单栏通知/终端提示），且确认前拒绝一切会话与审批请求。这是安全边界，也是 iOS 审核时能解释「远程控制」的关键交互。
2. **宿主连接管理**：启动/发现/重启 Codex app-server、OpenCode server、Claude SDK 子进程、Gemini ACP 子进程；每个连接一个 `hostInstanceId`。
3. **决定执行器**：把手机决定翻译成宿主原生响应（Codex JSON-RPC response、OpenCode `POST .../reply`、Claude 的 `canUseTool` 返回值、Gemini 的 `session/request_permission` response）。
4. **pending 重放与断线重连**：手机断线期间的待决审批/提问/流式片段要能补齐；不能只靠内存事件流。
5. **版本与能力上报**：`/pocket/status` 需要扩展宿主类型、实例、版本、能力，供手机降级展示。

### 1.4 第一阶段范围

- **只桥接两类会话**：① 适配器通过宿主原生接口**新建**的会话；② 适配器**明确恢复**的会话（用户或手机显式选择一个会话 ID 让适配器附着）。
- 不做：自动镜像宿主里所有会话、自动接管已有 GUI 会话、跨宿主会话迁移。
- 手机协议以「新增字段为主、不改旧语义」的方式扩展；“既有 GUI 会话”相关字段先留空并在 UI 标注「未验证」。

### 1.5 待验证：既有 GUI / 终端会话（不进入首版验收）

| 宿主 | 可见性 | 实时订阅 | 审批归属 | 验证方法 / 当前判断 |
| --- | --- | --- | --- | --- |
| Codex | 理论可：`thread/list` 列举，`thread/read` 读历史 **[官方文档/本地 schema]** | 待验证：同一 thread 被 GUI 与适配器同时 `thread/resume` 时通知如何扇出、是否重复 `item/agentMessage/delta` | 待验证：GUI 正在等待的审批请求，适配器是否也会收到、谁先应答；`serverRequest/resolved` 能否让两端一致清表 | 本机开 Codex GUI + 另起 app-server 连接同一 thread，观察通知与审批归属 |
| Claude Code | 终端会话落盘在 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`，SDK 可用 `resume`/`listSessions` **[官方文档]** | 未验证：SDK 进程与运行中的终端 CLI 是否可同时写同一 session | 未验证：终端里已弹出的权限提示与 SDK `canUseTool` 是否冲突 | 文档明确「session 文件是本机文件」「跨主机恢复需 sessionStore 或搬 jsonl」；并发写入行为未写，必须实测 |
| OpenCode | 若适配器连的是同一个 server 进程，理论上 `GET /api/session` 能看到 TUI 创建的会话 **[官方文档]** | 待验证：多客户端订阅同一会话的事件广播语义；`/api/event` 是 volatile 的 | 待验证：权限请求按 location 列出（`GET /api/permission/request`），由哪个客户端应答、是否会重复弹出 | 起 `opencode serve` + TUI + 适配器三端，同一 session 并发操作 |
| Gemini CLI | ACP `loadSession` 可载入历史会话 **[官方文档]** | 未验证：终端正在跑的会话能否 load、load 后是否为同一会话 | 未验证：终端自身的权限确认与 ACP `session/request_permission` 是否互斥 | 终端开会话 → `gemini --acp` 另起 → `loadSession` 观察 |

---

## 2. 适配器架构

### 2.1 边界：Cordis 宿主内插件 vs 独立进程适配器

```
                 ┌───────────────────────────── 手机 / Watch ─────────────────────────────┐
                 │   Pocket Whale App：宿主列表 → 会话 → 消息/审批/提问/接力                │
                 └───────────────┬───────────────────────────────┬────────────────────────┘
                                 │ 同一套 /pocket/* HTTP+SSE     │
        ┌────────────────────────▼──────────────┐   ┌────────────▼─────────────────────────┐
        │ 形态 A：Cordis 宿主内插件（1.0.1）      │   │ 形态 B：独立进程适配器（本文）        │
        │ 进程：DSH 内                            │   │ 进程：独立（菜单栏/后台服务）          │
        │ 数据源：sessionQuery / sessionController│   │ 数据源：宿主原生协议                  │
        │ 审批：ctx.on('approval/request')        │   │ 审批：宿主原生 request → 自己应答      │
        │ 配对：DSH Web UI 弹窗                   │   │ 配对：自建确认入口                    │
        │ 生命周期：跟随 DSH                      │   │ 生命周期：自己管理宿主子进程          │
        └─────────────────────────────────────────┘   └──────────────────────────────────────┘
```

| 维度 | Cordis 宿主内插件 | 独立进程适配器 |
| --- | --- | --- |
| 能拿到什么 | DSH 的会话/审批/提问服务与事件 | 只能拿到宿主自己的协议；DSH 能力拿不到 |
| 权限边界 | 受 DSH 权限/审批流约束 | 必须自己实现「人确认」环节，且**不能绕过宿主的权限裁决** |
| UI | DSH Web UI 面板/底栏/悬浮入口 | 菜单栏、独立窗口、首次启动向导 |
| 会话 id | DSH session id | 宿主原生 id + 适配器映射表 |
| 升级方式 | `dsh plugin add` / 包管理器 | 自带更新或用户手动安装 |
| 与手机协议 | 直接实现 | 复用同一套协议（建议抽公共包） |

**共同点**：手机端只认 `/pocket/*` 协议与统一事件模型，**不感知**背后是 DSH 还是 Codex。适配器类型通过 `hostType` 字段区分。

### 2.2 统一会话模型与 id 映射

```jsonc
// 统一会话引用（所有手机请求都必须带完整三元组）
{
  "hostType": "codex",                  // codex | claude | opencode | gemini | dsh
  "hostInstanceId": "cx-7f3a9c",        // 适配器/宿主实例，启动时生成并持久化
  "nativeSessionId": "thr_0199...",     // 宿主原生 id（Codex threadId / Claude session_id / OpenCode Session.ID / ACP sessionId）
  "adapterSessionId": "ps_01J...",      // 适配器对外 id（wire id），由三元组确定性派生
  "title": "pocket-whale 重构",          // 仅展示，绝不用于路由
  "cwd": "/Users/.../pocket-whale",
  "createdAt": 1795677900000,
  "updatedAt": 1795677920000,
  "capabilities": ["send", "stream", "interrupt", "approval", "question"],
  "status": "idle"                      // idle | running | waiting_approval | waiting_input | error
}
```

规则：

1. **路由键 = (hostType, hostInstanceId, nativeSessionId)**，`adapterSessionId` 只是它的 URL 安全编码（例如 `base64url(JSON)` 或 HMAC 后的短 id + 服务端映射表）。禁止用 title、序号、数组下标路由。
2. **映射表持久化**：适配器重启后 `adapterSessionId` 必须仍能解析回同一个原生会话，否则手机上的会话卡片会全部失效。
3. **同名不同源**：Codex 的 threadId、OpenCode 的 `Session.ID`、Claude 的 `session_id`、ACP 的 `sessionId` 取值空间完全不同，**跨宿主即使字符串相同也视为不同会话**；三元组天然隔离。
4. **实例隔离**：同一台机器可能同时有两个 Codex app-server（例如 Codex GUI 自带的 + 用户另起的），`hostInstanceId` 必须不同，手机展示为「Codex · 实例 A / 实例 B」。

### 2.3 事件归一化

所有宿主事件统一成同一种信封（SSE `data:` 一行一条）：

```jsonc
{ "seq": 1042,                  // 适配器单调序号，用于重连补洞
  "ts": 1795677923386,
  "session": { "hostType": "codex", "hostInstanceId": "cx-7f3a9c", "nativeSessionId": "thr_0199..." },
  "type": "message.delta",      // 见下表
  "payload": { } }
```

| 统一事件 | 语义 | Codex | Claude Agent SDK | OpenCode | Gemini ACP |
| --- | --- | --- | --- | --- | --- |
| `message.delta` | 助手流式文本增量 | `item/agentMessage/delta` `{threadId,turnId,itemId,delta}` | SDK 流式消息/`stream_event`（未本地验证） | `session.text.delta` | `session/update` → `agent_message_chunk` |
| `message.completed` | 一条助手消息完成 | `item/completed`（agentMessage item） | `result`/assistant 消息结束 | `session.message.*` + `session.execution.succeeded` | `session/update` → 完成态 / `prompt` 响应 |
| `reasoning.delta` | 推理/思考流（可选） | `item/reasoning/textDelta`、`summaryTextDelta` | 未验证 | `session.reasoning.delta` | 未验证（ACP `think` 工具类） |
| `tool.started` / `tool.updated` / `tool.completed` | 工具调用 | `item/started` / `item/completed`、`item/commandExecution/outputDelta` | SDK tool_use / tool_result 消息 | `session.tool.started/success/failed` | `session/update` → `tool_call` / `tool_call_update` |
| `approval.requested` | 需要人批准 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`（旧版 `execCommandApproval`/`applyPatchApproval`） | `canUseTool` 回调（toolName!=AskUserQuestion） | `permission.asked` + `GET /api/permission/request` | `session/request_permission` |
| `approval.settled` | 决定已生效 | `serverRequest/resolved` 通知 | 回调返回后即结算（无独立事件） | `permission.replied` | 响应返回即结算（无独立事件） |
| `question.requested` | 需要人选答案 | `item/tool/requestUserInput`（EXPERIMENTAL） | `canUseTool` 且 `toolName == "AskUserQuestion"` | `session.form.*`（是否等价待验证） | 无标准 ACP 提问（elicitation 草案，未验证） |
| `question.settled` | 回答已提交 | 响应返回 + `serverRequest/resolved` | 回调返回后即结算 | 未验证 | 不适用 |
| `turn.interrupted` | 中断完成 | `turn/completed`（status=interrupted，以 schema 为准） | 未验证（AbortSignal） | `session.execution.interrupted` | `cancel` 后 `prompt` 以 cancelled 结束 |
| `error` | 宿主错误 | `error` 通知 | SDK error result | `session.execution.failed` / `session.step.failed` | ACP `error` |
| `session.status` | 忙闲/等待态 | `thread/status/changed`、`turn/started`、`turn/completed` | SDK 消息阶段推断 | `session.status`、`session.idle`、`session.execution.*` | `session/update` 阶段推断 |

**归一化原则**：

- 流式增量必须带 `itemId`/消息 id，避免手机把两次不同回复的增量拼在一起。
- 审批/提问的 `requestId` 用 `(hostInstanceId, adapterSessionId, hostRequestId)` 派生，**全链路唯一**。
- 宿主没有的事件类型不要伪造；不认识的事件进 `unknown` 类型并**只记日志、不展示**，避免误渲染。
- 中断就是「宿主确认后的结果」，不是「点了按钮」；UI 必须等宿主的 `turn.interrupted`。

### 2.4 能力声明与 UI 降级

```jsonc
// 每个 hostInstance 上报一次，手机端缓存
{
  "hostType": "codex",
  "hostInstanceId": "cx-7f3a9c",
  "hostName": "Codex CLI",
  "hostVersion": "0.171.0-alpha.13.2",
  "adapterVersion": "0.1.0",
  "transport": "stdio-jsonrpc",
  "capabilities": {
    "sessions.list": true,
    "sessions.create": true,
    "sessions.resume": true,
    "send": true,
    "stream": true,
    "interrupt": true,
    "approval":  { "supported": true, "options": ["accept", "acceptForSession", "decline", "cancel"] },
    "question":  { "supported": true, "experimental": true },
    "modelSwitch": { "supported": true, "experimental": false, "modes": ["per-turn", "settings"] },
    "usage": true
  }
}
```

UI 规则（手机 + Watch 一致）：

- **三态**：`native`（宿主原生支持）/ `emulated`（适配器模拟，需标注）/ `unsupported`（明确置灰 + 文案「该宿主未提供此能力」，绝不空白或转圈）。
- 实验性能力打「实验性」角标（如 Codex `request_user_input`、Gemini `unstable_setSessionModel`）。
- 回答审批时，**选项语义必须原样保留**：宿主的 `acceptForSession` 不能折叠成 `accept`；`decline` 与 `cancel` 的区别（是否中断本轮）必须显式展示。
- 能力缺失时不要提供「重试」按钮（无意义），提供「切换宿主」或「回到桌面处理」。

### 2.5 版本与能力协商

三层，从粗到细：

1. **传输握手**：Codex `initialize`（`clientInfo` + `capabilities`）、Gemini ACP `initialize`（client capabilities）、OpenCode `GET /api/info`、Claude 读 `@anthropic-ai/claude-agent-sdk` 版本与底层 CLI 版本。
2. **能力探测**：用「方法/端点白名单」而不是版本号判断。Codex 例：`thread/resume` 存在不代表 `thread/read` 存在；本地实测未知方法返回 `-32600 unknown variant` 并**枚举全部可选方法**（附录 A.4），可据此运行期探测并缓存。
3. **schema 指纹**：构建期或首发连接时记录协议指纹（Codex：`codex app-server generate-json-schema --out` 的产物哈希；OpenCode：`/docs/openapi.json` 哈希；ACP：初始化返回的 `protocolVersion`/能力；Claude：SDK 版本 + `listSessions` 可用性），版本变化时告警并降级未知字段。

**明确反模式**：不要把 `0.171.0-alpha.13.2` 这样的版本号直接当能力用——同版本不同构建、`--experimental` 开关、账号/gateway 配置都会改变可用方法（本地实测：非实验 schema 的 v2 文件 292 个，加 `--experimental` 后 438 个，`remoteControl/*` 仅在后者出现）。

### 2.6 同名会话与多宿主路由防串线

1. 手机端任何操作都必须携带 `(hostType, hostInstanceId, nativeSessionId)` 三元组，服务端校验该三元组属于当前已配对设备可见范围，否则 403。
2. 「当前目标宿主」是手机端显式状态；切换宿主时清空草稿与待决列表，防止把 A 的审批答到 B。
3. 会话列表按 `hostInstanceId` 分组；同名会话展示 `标题 · 宿主实例 · 目录名` 作为区分信息，但**不参与路由**。
4. 审批/提问的 `requestId` 必须包含 `hostInstanceId`；收到非当前上下文的 `requestId` 直接拒绝（409/410）。
5. 适配器内部对 `nativeSessionId` 做归属校验：Codex 用 `threadId` 校验 request 的 `threadId` 字段（审批/提问请求里都带）；OpenCode 校验 path 里的 `sessionID`；ACP 校验 `sessionId`。
6. 多适配器同机：组播发现包携带 `adapterInstanceId`；手机端配对记录里保存该 id，重连时校验，防止两台机器同名。

---

## 3. 四个候选逐项对比

### 3.0 能力矩阵

| 能力 | Codex app-server | Claude Code Agent SDK | OpenCode server API | Gemini CLI ACP |
| --- | --- | --- | --- | --- |
| 传输 | stdio JSON-RPC 2.0（换行分隔；亦支持 unix/ws、daemon/proxy）**[本地实测]** | 进程内 SDK（Node/Python），底层管理 Claude Code CLI 子进程 **[官方文档]** | HTTP REST + SSE `GET /api/event` **[官方文档]** | stdio JSON-RPC 2.0（`gemini --acp`）**[官方文档]** |
| 会话新建 | `thread/start`（`ephemeral` 可建临时会话） | `query()` 新会话 | `POST /api/session` | `newSession` |
| 会话恢复 | `thread/resume`（重新附着+订阅）、`thread/read`（只读历史）、`thread/list` | `resume: <sessionId>`、`continue: true`、`forkSession`、`listSessions()` | `GET /api/session`、`GET /api/session/{id}`、`prompt` 续聊 | `loadSession` |
| 发送消息 | `turn/start {threadId, input[]}` | `query()` / `ClaudeSDKClient.query()` | `POST /api/session/{id}/prompt`（返回**已入队**而非已完成） | `prompt` |
| 流式 | `item/agentMessage/delta` 等通知 | SDK 消息流（`stream_event` 等） | `session.text.delta` 等 SSE 事件 | `session/update` 通知 |
| 中断 | `turn/interrupt {threadId,turnId}` | AbortSignal/取消（具体 API 未验证） | `POST /api/session/{id}/interrupt` | `cancel` |
| 审批 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`；decision `accept`/`acceptForSession`/`decline`/`cancel`（另有 execpolicy/网络策略变体）**[本地实测 schema]** | `canUseTool(toolName,input,{signal,suggestions})` → allow（可带 `updatedInput`/`updatedPermissions`）/ deny（带 message，可中断）**[官方文档]** | `GET /api/permission/request`、`POST /api/session/{id}/permission/{requestID}/reply`，`decision: once\|always\|reject`，事件 `permission.asked/replied` **[官方文档]** | `session/request_permission`，选项 `allow_once`/`allow_always`/`reject_once`/`reject_always`，结果 `selected{optionId}`/`cancelled` **[官方文档]** |
| 用户提问 | `item/tool/requestUserInput`（EXPERIMENTAL）：`questions[{id,header,question,options[{label,description}],isOther,isSecret}]`，响应 `{answers}` **[本地实测 schema]** | `AskUserQuestion` 走同一 `canUseTool`；须把 `AskUserQuestion` 放进 `tools`；答案经 `updatedInput.answers` 回传 **[官方文档]** | `session.form.*`（是否等价 ask-user 未验证） | 无标准 ACP 提问方法；elicitation 为草案（未验证） |
| 模型切换 | `turn/start.model`（按轮）、`thread/settings/update`、`model/list` | `query({ options.model })`；会话中切换未验证 | `POST /api/session/{id}/model`（下一轮生效） | `unstable_setSessionModel`（unstable） |
| 既有终端/GUI 会话 | 理论可（`thread/list` + `resume`），并发订阅待验证 | 文件级可（`~/.claude/projects/...jsonl`）+ `resume`，并发写待验证 | 同一 server 进程内可见，多客户端事件语义待验证 | `loadSession`，运行中会话待验证 |
| 能力/版本协商 | `initialize.clientInfo + capabilities(experimentalApi, requiredHumanApproval…)`；响应**无协议版本字段** → 需指纹/探测 | SDK 语义化版本；V2 会话 API 已在 0.3.142 移除（漂移先例） | `GET /api/info`；OpenAPI info.version = `0.0.1`（HttpApi 版本，非构建版本） | ACP `initialize` 能力 + `protocolVersion`；Gemini 侧另有 `unstable_*` 方法 |
| 本次证据 | **本地实测**（握手/model/list/schema）+ 官方仓库文档；官方文档页 403 未直接读取 | 官方文档（两家 URL 同源）已读取；**本机未安装** → 未本地验证 | 官方文档 + OpenAPI 已读取；**本机未安装** → 未本地验证 | 官方文档 + ACP 规范已读取；**本机未安装** → 未本地验证 |
| 实测版本 | CLI `0.171.0-alpha.13.2`（GitHub 最新 `0.172.0`） | Agent SDK `0.3.332` / CLI `2.1.332` | `opencode-ai` `1.19.6` | `@google/gemini-cli` `0.71.1` |

> 版本来源：Codex 为本地可执行文件实测；其余为 2026-11-26 从 npm registry 查询到的 latest。**「latest」不等于「已验证」**——本机没装 Claude/OpenCode/Gemini，所以矩阵里它们的能力全部是文档依据，必须在实现前按 §5.3 补契约测试。

### 3.1 Codex app-server

#### 3.1.1 证据与版本

- 官方文档（issue 引用）：<https://developers.openai.com/codex/app-server/>。**本次抓取返回 HTTP 403（被拦截），未直接读取页面内容**，因此协议要点以本机生成的 schema、本机实测报文、以及官方仓库的协议说明为准。
- 官方仓库协议说明（已读取）：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>。该文件记录了大量协议演进与实验开关（如 `humanCommand` 需要 `experimentalApi: true` + `requiredHumanApproval: true`；无 capable client 时审批直接拒绝；支持的 client 重连后会重放 pending 审批）。
- 本机可执行文件：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`（**PATH 里没有 `codex`**，`~/.codex` 存在但那是 GUI 的状态目录）。`codex --version` → `codex-cli 0.171.0-alpha.13.2`。
- 版本差：npm registry 上 `@openai/codex` latest = `0.172.0`，与本机 `0.171.0-alpha.13.2` 相差一个版本，**说明 schema 随时会动**（见 §5.2 风险 R1）。

#### 3.1.2 握手与能力协商（本地实测）

```jsonc
// 1) 客户端 → 服务端（stdin，每行一条 JSON）
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "clientInfo":{"name":"pocket-whale-probe","title":"Pocket Whale probe","version":"0.0.1"},
  "capabilities":{"experimentalApi":false}
}}

// 2) 服务端 → 客户端（实测返回；注意没有 protocolVersion 字段）
{"jsonrpc":"2.0","id":1,"result":{
  "userAgent":"pocket-whale-probe/0.171.0-alpha.13.2 (Mac OS 27.2.1; arm64) dumb (pocket-whale-probe; 0.0.1)",
  "codexHome":"/Users/zhangyizhao/.codex",
  "platformFamily":"unix",
  "platformOs":"macos"
}}

// 3) 客户端 → 服务端（通知，无 id、无响应）
{"jsonrpc":"2.0","method":"initialized"}
```

要点：

- `initialize` 的 `params.clientInfo` 必填（`name`、`version`），`capabilities` 可选。`capabilities.experimentalApi` 默认 `false`；`requiredHumanApproval` 用于「必须真人批准」的 `humanCommand` 审批，且要求 `experimentalApi: true`。
- **响应里没有协议版本号**。版本只能从 `userAgent`、本地可执行文件版本或后续探测推导。这意味着：不要假设「握手成功 = 版本兼容」。
- `initialize` 之后必须发 `initialized` 通知，否则后续请求行为不确定。
- 实测还观察到服务端会主动推送通知（如 `remoteControl/status/changed`），适配器必须始终读 stdout，不能只在请求后读。
- **能力探测技巧（实测）**：请求一个不存在的方法，返回的是 `-32600` 且消息里枚举全部合法方法名，而不是 `-32601`：

  ```jsonc
  {"id":3,"error":{"code":-32600,"message":"Invalid request: unknown variant `nonexistent/method`, expected one of `initialize`, `server/diagnostics`, ... `fuzzyFileSearch/sessionStop`"}}
  ```

  该版本运行时共枚举出 **188 个**客户端方法（附录 A.4）。这可以作为「方法是否存在」的运行期探测，但**错误码语义不是标准 JSON-RPC `-32601`**，适配器要按 `-32600 + message` 判断。

#### 3.1.3 协议方法表（本地 schema 实测）

| 方法 | 入参要点（schema） | 用途 | 备注 |
| --- | --- | --- | --- |
| `initialize` | `clientInfo{name,version,title?}`、`capabilities{experimentalApi?,requiredHumanApproval?,extensions?,optOutNotificationMethods?,requestAttestation?,explicitGatewayOauth?}` | 握手 | 响应无协议版本 |
| `initialized` | 无 | 握手完成通知 | 无响应 |
| `model/list` | `{cursor?,includeHidden?,limit?,modelProvider?}` | 模型列表 | 响应 `{data[], nextCursor?}`；每项含 `id/displayName/description/supportedReasoningEfforts/defaultReasoningEffort/inputModalities/serviceTiers/isDefault` 等 |
| `thread/start` | `{cwd?,model?,approvalPolicy?,sandbox?,ephemeral?,baseInstructions?,developerInstructions?,personality?,serviceTier?,threadSource?}` | 新建会话 | `ephemeral:true` = 临时会话（首版验收用） |
| `thread/resume` | `{threadId, excludeTurns, cwd?,model?,approvalPolicy?,sandbox?…}` | 恢复/附着会话 | 重新订阅该 thread 的通知 |
| `thread/read` | `{threadId, includeTurns}` | 只读读取历史 | 用于手机端补齐/可见性 |
| `thread/list` | 见 schema | 列举会话 | 既有 GUI 会话可见性的入口；`currentAccountOnly` 等字段存在（官方 README 记录） |
| `thread/unsubscribe` / `thread/loaded/list` | — | 退订 / 查询已加载 thread | 多客户端场景需要 |
| `turn/start` | `{threadId, input[], model?, effort?, approvalPolicy?, sandboxPolicy?, clientUserMessageId?…}` | 发起一轮 | `input` 是数组（内容块） |
| `turn/interrupt` | `{threadId, turnId}` | 中断当前轮 | 验收停止按钮 |
| `turn/steer` | 见 schema | 轮中追加指令 | 可选 |
| `thread/settings/update` | 见 schema | 改后续轮设置 | 模型切换路径之一 |
| `server/diagnostics`、`config/read`、`account/read` | — | 诊断/配置/账号 | 版本与能力上报可用 |
| `remoteControl/pairing/start` 等 | 仅 `--experimental` schema 出现 | Codex 自带的远程配对 | 见 §3.1.7 战略提示 |

#### 3.1.4 事件与流式（服务端 → 客户端通知）

| 通知 | 关键字段 | 用途 |
| --- | --- | --- |
| `turn/started` / `turn/completed` | `threadId`、`turn` | 轮次生命周期；中断后以 completed 收尾（以 schema 的 `Turn.status` 为准） |
| `item/agentMessage/delta` | `threadId`、`turnId`、`itemId`、`delta` | **流式文本**（实测 schema：`item/agentMessage/delta`） |
| `item/started` / `item/completed` | item | 工具/消息条目生命周期 |
| `item/reasoning/textDelta` / `summaryTextDelta` / `summaryPartAdded` | item | 推理流（可选展示） |
| `item/commandExecution/outputDelta`、`item/fileChange/outputDelta` | item | 命令/改动输出 |
| `turn/plan/updated`、`turn/diff/updated`、`thread/tokenUsage/updated` | — | 计划/差异/用量；手机端可选择性展示 |
| `thread/status/changed`、`thread/started`、`thread/name/updated` | — | 状态与元数据 |
| `serverRequest/resolved` | `requestId`、`threadId` | **审批/提问结算的关键信号**：据此清 pending，保证「一次决定只作用原请求」 |
| `error` | error | 传 `error` 事件给手机 |

#### 3.1.5 审批与提问（协议要点 + 决策映射）

**审批请求是「服务端 → 客户端」的 JSON-RPC request，必须回一个同 id 的 response**（不是通知）。本地 schema 实测存在这些请求：

| 请求方法 | 参数（必填加粗） | 决策/响应 |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | **`threadId` `turnId` `itemId` `startedAtMs` `kind`**；`approvalId?` `command?` `commandActions?` `cwd?` `reason?` `environmentId?` `networkApprovalContext?` `proposedExecpolicyAmendment?` `proposedNetworkPolicyAmendments?` | `decision`: `accept` / `acceptForSession` / `acceptWithExecpolicyAmendment{execpolicy_amendment[]}` / `applyNetworkPolicyAmendment{…}` / `decline` / `cancel`。`kind` 取 `command` / `writeStdin` / `humanCommand`（后者要求 `experimentalApi + requiredHumanApproval`，只接受 `accept`/`decline`/`cancel`） |
| `item/fileChange/requestApproval` | **`threadId` `turnId` `itemId` `startedAtMs`**；`grantRoot?` `reason?` | `decision`: `accept` / `acceptForSession` / `decline` / `cancel` |
| `item/permissions/requestApproval` | **`cwd` `itemId` `permissions` `startedAtMs` `threadId` `turnId`**；`environmentId?` `reason?` | `{permissions, scope?, strictAutoReview?}` |
| （旧版兼容）`execCommandApproval` / `applyPatchApproval` | 见 schema | 老客户端路径；新适配器不需要，但要能识别并降级 |
| `item/tool/requestUserInput` | **`isBlocking` `itemId` `questions` `threadId` `turnId`**；`autoResolutionMs?` | `{answers}` |

`questions[]`（本地 schema 实测，标注 EXPERIMENTAL）：

```jsonc
{ "id":"q1", "header":"选择方案", "question":"要改哪一层？",
  "options":[ {"label":"适配器层","description":"..."}, {"label":"协议层","description":"..."} ],
  "isOther": true,        // 允许自由输入
  "isSecret": false }      // 敏感输入（手机端需要遮挡）
```

**手机审批 UI 的映射规则**：

| 宿主语义 | 手机展示 | 回传 |
| --- | --- | --- |
| `accept` | 「允许一次」 | `"accept"` |
| `acceptForSession` | 「本会话内都允许」（必须说明范围） | `"acceptForSession"` |
| `decline` | 「拒绝」 | `"decline"` |
| `cancel` | 「拒绝并停止本轮」（与拒绝区分） | `"cancel"` |
| 带 execpolicy 变体的允许 | 「允许，并记住此类命令」（仅当宿主提供该选项） | 原样回传对象 |
| 提问 | 选项/自由输入；`isSecret` 遮挡 | `{answers:{q1:[...]}}` |

**归属与重放（官方 README + 实测）**：

- `humanCommand` 审批若在请求时**没有 capable 连接**，命令会被直接拒绝；capable 客户端重连后 pending 会重放。→ 手机断线时「桌面还在等人批」这个状态必须如实显示，不能假设它会一直等。
- 结算后服务端发 `serverRequest/resolved{requestId, threadId}`；适配器据此关闭手机端卡片并拒绝重复提交（幂等）。

#### 3.1.6 本地实测记录

见附录 A（含原始报文与命令）。摘要：

- `initialize` → `initialized` → `model/list`（`{limit:5}`）**成功**，返回模型列表（`gpt-6.2-sol`、`gpt-6.2-astra`、`gpt-6.1-terra` 等）。
- `model/list` 首次约 **5.0 s**；stderr 有 `failed to refresh available models: request timed out`，说明在线模型目录刷新超时后回退本地缓存。→ 适配器启动时要把 `model/list` 放进后台任务，不能阻塞首屏。
- 未创建任何 thread、未发起 `turn/start`（避免写入用户 `~/.codex` 状态），因此 **`thread/start`、`turn/start`、流式 delta、审批/提问的端到端交互属于「未本地验证」，需要实现前补测**。
- 生成 schema：非实验 37 个顶层 + v1 2 + v2 292 个文件（4.8 MB）；`--experimental` 后 v2 变 438 个文件（6.3 MB），`remoteControl/*` 只在实验集合出现。

#### 3.1.7 风险与战略提示

- **协议标注 experimental**：`codex app-server` 的 help 首行就是 `[experimental]`；不能承诺跨版本稳定。
- **Codex 自带的远程配对**（`remoteControl/pairing/start` → `{pairingCode, manualPairingCode, expiresAt}`、`remoteControl/pairing/status` → `{claimed}`、`remoteControl/client/list|revoke`）说明 Codex 生态自己在做「手机/其它终端控制桌面 Codex」。pocket-whale 的差异化应放在**多宿主统一、审批/提问归一化、接力包**，而不是重造配对。若 Codex 的 remote control 正式开放，需要评估「共存/借用」而不是对抗。

### 3.2 Claude Code Agent SDK

**证据**：官方文档已读取（2026-11-26）：

- 用户输入与审批：<https://code.claude.com/docs/en/agent-sdk/user-input>（`platform.claude.com` 版本会 302 到 `code.claude.com`）
- 会话：<https://code.claude.com/docs/en/agent-sdk/sessions>
- 版本：`@anthropic-ai/claude-agent-sdk` = `0.3.332`、`@anthropic-ai/claude-code` = `2.1.332`（npm registry latest）。**本机未安装 → 全部未本地验证。**

**接入形态**：SDK 是**进程内库**（TypeScript/Python），由它管理底层 Claude Code CLI 子进程。对独立进程适配器意味着：适配器要内嵌 Node/Python 运行时并把 SDK 拉进来，而不是「连一个已经在跑的 server」。这比 Codex 的 stdio 连接重。

**会话**：

- 新建：`query()`；会话 id 从 result message 的 `session_id` 拿（TS 更早在 init `SystemMessage` 就有）。
- 继续最近会话：`continue: true`；恢复指定会话：`resume: <sessionId>`；分叉：fork。
- 枚举/管理：TS `listSessions()`、`getSessionMessages()`、`getSessionInfo()`、`renameSession()`、`tagSession()`。
- 落盘：`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`；文档明确「session 文件是本机文件」，跨主机恢复要么接 `sessionStore` 适配器，要么搬 jsonl。
- **版本敏感**：文档写明 v2.1.223 之前 resume 查找范围只限当前项目目录及其 git worktree；V2 会话 API（`createSession()` 的 `send`/`stream`）在 TypeScript Agent SDK `0.3.142` 已被移除。→ 强证据：Claude 侧 API 漂移是真实发生的，必须锁版本 + 契约测试。

**审批**：

- `canUseTool(toolName, input, options)`，`options` 含 `signal`（AbortSignal）和 `suggestions`（建议的 `PermissionUpdate`）。
- 返回 `PermissionResultAllow`（可带 `updatedInput`、`updatedPermissions`）/ `PermissionResultDeny`（可带 `message`，可中断）。
- 注意：**权限流可能在回调之前就 allow/deny**（deny 规则、permission mode、allow 规则先跑）；某些模式（如 `dontAsk`）根本不会调用回调。→ 适配器不能假设「没收到回调 = 没有审批」。
- **回调可以无限期挂起**，用户不答，执行一直暂停。文档给出的正解是：对可能超时的场景用 `PreToolUse` hook 返回 `defer`，让进程退出、稍后从持久化会话恢复。这直接对应手机断线/长时间不看的场景——**首版必须实现 defer 或明确限制「手机断开超过 N 分钟则桌面接管」**。
- `PermissionRequest` hook 可用于发通知（文档原话：Slack/email/push），可用来给手机推送「有人在等审批」。

**提问**：`AskUserQuestion` 工具走同一个 `canUseTool`（`toolName == "AskUserQuestion"`）；必须在 `tools` 数组里包含该工具才生效；问题与选项由 Claude 生成，客户端只能呈现和回传，答案通过 `updatedInput.answers` 回传。

**流式**：SDK 消息流（`stream_event`/assistant 消息）；官方另有「Stream responses in real-time」文档。本次未验证具体事件字段。

**风险**：进程内库 → 适配器崩溃即会话进程状态受影响；版本漂移；无限挂起需要 defer；本机无 Claude 无法实测。

### 3.3 OpenCode server API

**证据**：官方文档已读取（2026-11-26）：

- API 文档：<https://opencode.ai/docs/api>（文档称 190 operations / 542 schemas，OpenAPI 3.1）
- OpenAPI：<https://opencode.ai/docs/openapi.json>（已下载解析：**154 条路径**，`info.version = 0.0.1`，描述为 "Experimental HttpApi surface for selected instance routes"）
- 版本：`opencode-ai` = `1.19.6`（npm registry latest）。**本机未安装 → 全部未本地验证。**

**接入形态**：HTTP REST + SSE，和 pocket-whale 现有的 `/pocket/*` 形态最接近；适配器只需当 HTTP 客户端，不必内嵌 SDK。

**关键端点**：

| 能力 | 端点 | 要点 |
| --- | --- | --- |
| 会话列表/详情 | `GET /api/session`、`GET /api/session/{sessionID}` | 支持 `limit/order/search/parentID/archived/directory/project/cursor` |
| 新建 | `POST /api/session` | 可带 `parentID` 建子会话 |
| 删除/分叉/移动/归档 | `DELETE /api/session/{id}`、`POST /api/session/{id}/fork`、`POST /api/session/{id}/move` | |
| 发送消息 | `POST /api/session/{id}/prompt` | **返回「已入队」而非完成**；body `{text, files?, agents?, skills?, delivery?, resume?, id?}`；`id` 相同重复发送幂等（重试安全） |
| 等完成 | `POST /api/experimental/session/{id}/wait` 或事件 `session.execution.succeeded/failed/interrupted` | 首版用事件；`wait` 是实验接口 |
| 中断 | `POST /api/session/{id}/interrupt` | 响应 `interrupted=false` 表示当前没在跑 |
| 模型切换 | `POST /api/session/{id}/model`（还有 `/agent`） | 「从下一次模型调用起生效」 |
| 审批列表 | `GET /api/permission/request`（按 location）、`GET /api/session/{id}/permission`、`GET /api/session/{id}/permission/{requestID}` | |
| 审批答复 | `POST /api/session/{id}/permission/{requestID}/reply` | body `{decision: "once" \| "always" \| "reject", message?}` |
| 事件流 | `GET /api/event`（SSE） | **volatile 契约**：慢消费者会把流撑断，断线期间事件直接丢 |
| 补偿读取 | `GET /api/experimental/session/{id}/log?after=&follow=`、`GET /api/session/{id}/message` | 断线重连后必须先补历史再订阅 |
| 配对 | `POST /api/pair`、`GET /auth/connect/{code}` | OpenCode 自带配对码；适配器应复用自己的配对，不要混用 |
| 服务信息 | `GET /api/info` | server 身份/连接 URL/就绪状态 → 版本与能力探测入口 |

**事件名（OpenAPI 实测）**：`session.text.delta`、`session.reasoning.delta`、`session.tool.started/success/failed/progress`、`session.step.started/ended/failed`、`session.execution.started/succeeded/failed/interrupted`、`session.idle`、`session.status`、`permission.asked`、`permission.replied`、`session.inbox.*` 等。

**风险**：

- API 明确标注 Experimental（`/api/*` 是 "Experimental HttpApi surface"）；变更不保证。
- 事件 volatile → **断线重连必须用 log/message 补偿**，这是首版验收 AC-05 的必测点。
- 「提问」能力：存在 `session.form.*`（create/get/list/reply/cancel）与 `session.permission.*`，但**是否等价于「agent 主动问用户问题」未验证**，不能先声明支持。
- 本机未安装，未能验证 prompt→event 的完整时序。

### 3.4 Gemini CLI ACP

**证据**：官方文档已读取（2026-11-26）：

- Gemini CLI ACP 模式：<https://geminicli.com/docs/cli/acp-mode/>
- ACP 规范：<https://agentclientprotocol.com/protocol/v1/overview>（站点同时有 v1 Stable 与 v2 Preview）
- 相关页：<https://agentclientprotocol.com/protocol/v1/tool-calls>（权限）、<https://agentclientprotocol.com/protocol/v1/session-setup>
- 版本：`@google/gemini-cli` = `0.71.1`（npm registry latest）。**本机未安装 → 全部未本地验证。**
- **上游风险（文档横幅）**：官方文档页顶部写明「Unpaid tier and Google One users: Gemini CLI was replaced by Antigravity CLI on June 18th, 2026」「Gemini CLI has not been optimized for Gemini 4 Argon」。→ 产品上应视为「可能被替换的宿主」，放 P2。

**接入形态**：`gemini --acp`，stdio 上的 JSON-RPC 2.0；Gemini CLI 是 server，适配器是 client。

**方法（官方文档列出）**：

| 方法 | 方向 | 用途 |
| --- | --- | --- |
| `initialize` | client→agent | 建连、交换能力、注册客户端 MCP server |
| `authenticate` | client→agent | 认证 |
| `newSession` | client→agent | 新建会话 |
| `loadSession` | client→agent | 载入历史会话 |
| `prompt` | client→agent | 发送提示 |
| `cancel` | client→agent | 取消进行中的 prompt |
| `setSessionMode` | client→agent | 切换审批级别（如自动批准） |
| `unstable_setSessionModel` | client→agent | **切换模型（unstable）** |
| `session/update` | agent→client（通知） | 流式更新：`agent_message_chunk`、`tool_call`、`tool_call_update`、`plan` 等 |
| `session/request_permission` | agent→client（request） | 权限请求 |

**权限选项（ACP 规范）**：`options[]` 每项 `{optionId, name, kind}`，`kind ∈ {allow_once, allow_always, reject_once, reject_always}`；响应 `{outcome:{outcome:"selected", optionId}}`，若 prompt turn 被取消则必须回 `{outcome:{outcome:"cancelled"}}`。→ 与手机 UI 的四态可以一一映射（允许一次/总是允许/拒绝/拒绝并停止）。

**必须实现的客户端能力（容易被忽略）**：

- **文件系统代理**：官方文档明确「ACP includes a proxied file system service. This means that when the agent needs to read or write files, it does so through the ACP client.」→ 适配器必须实现 `fs/read_text_file`、`fs/write_text_file` 等客户端方法，否则 agent 无法读写文件。
- **终端**：ACP 的 `terminal/*`（create/output/wait/release 等）同样由 client 提供；不实现则涉及命令执行的工具不可用。
- **MCP**：ACP 允许客户端通过 MCP 暴露工具给 agent（initialize 时提供连接信息）；这与 pocket-whale 的「MCP 只用于显式工具」边界相关（§4 AC-10）。

**提问**：Gemini CLI 文档的方法表里**没有** ask-user 类方法；ACP 有独立的 `elicitation` 协议页（草案/较新），未验证 Gemini CLI 是否实现。→ 首版按「不支持提问」降级。

**风险**：客户端能力实现量大（fs/terminal）；模型切换 unstable；协议有 v1/v2 双版本在演进；上游被 Antigravity 取代；本机未安装。

### 3.5 选型结论

| 优先级 | 宿主 | 理由 | 前置条件 |
| --- | --- | --- | --- |
| **P0** | Codex app-server | 本地已跑通握手；能力覆盖最全（会话/流式/中断/审批/提问）；stdio 直连，独立进程最容易接 | 补测 `thread/start → turn/start → delta → interrupt` 与三类审批/提问的端到端 |
| **P1** | OpenCode server API | HTTP+SSE 与现有手机协议同构；权限端点齐全；接入成本最低 | 补测 prompt 入队→完成时序、`permission.asked/replied`、断线用 log 补偿 |
| **P1** | Claude Code Agent SDK | 审批/提问语义最接近 DSH；会话恢复文档最完整 | 内嵌 Node 运行时；defer 方案；锁 SDK+CLI 版本；补测并发写 session |
| **P2** | Gemini CLI ACP | ACP 规范好，但客户端 fs/terminal 工作量大、模型切换 unstable、上游被替换 | 先做「只读会话/发消息」的最小 ACP client 验证再投入 |

---

## 4. 首版验收用例（桌面 + iOS）

约定：每条用例都要产出「证据」（截图/屏幕录像/桌面日志/宿主侧日志），并在 §4.11 模板里登记实际通过的宿主机版本。**通过标准必须可观察、可复现，不能以「HTTP 200」代替「宿主真实状态」。**

### AC-01 桌面明确配对，手机区分宿主类型/实例/能力

- **前置**：桌面启动适配器（首次启动）；手机上已有 Pocket Whale App。
- **桌面**：首次启动出现**可见的配对确认入口**（窗口/菜单栏），显示 6 位短码与适配器实例名；手机未确认前，任何会话/审批 API 均返回 403。手机提交短码后桌面弹确认，点「允许」才完成配对。
- **手机**：首页出现宿主卡片，显示 `宿主类型（Codex/Claude/OpenCode/Gemini/DSH）`、实例名、版本、能力徽章（发送/流式/审批/提问/模型切换 的可用状态）。
- **通过标准**：① 未确认时手机无法读到任何会话；② 拒绝配对后手机侧无残留；③ 卡片上的能力与适配器上报一致；④ 杀进程重启后配对关系仍在，且实例 id 不变。
- **证据**：桌面确认截图 + 手机卡片截图 + 未确认时 403 的日志。

### AC-02 多 agent 共存，选择目标，同名会话不串线

- **前置**：同一台 Mac 同时运行 DSH 插件（1.0.1）+ Codex 适配器 + OpenCode 适配器；三个宿主各有一个标题都叫 `pocket-whale` 的会话。
- **桌面**：三个宿主均在线。
- **手机**：宿主列表显示 3 个宿主；分别进入三个宿主，会话列表互不混入；给 Codex 的 `pocket-whale` 发消息，OpenCode 的同名会话无任何变化；在 Codex 会话里打开审批，切到 OpenCode 再回来，审批卡片仍在且归属正确。
- **通过标准**：① 三个同名会话在列表中以「宿主实例 + 目录」可区分；② 消息/审批/中断只作用目标会话；③ 切换宿主不清空另一宿主的执行中状态。
- **证据**：三宿主并列截图 + 双会话消息对照 + 事件日志中的三元组。

### AC-03 Codex 临时会话：发消息、流式显示、可停止

- **前置**：AC-01 完成；Codex 适配器在线；旧版 `~/.codex` 状态不被污染（使用 `thread/start{ephemeral:true}`）。
- **桌面**：适配器日志显示 `thread/start` 返回 threadId；不打开 Codex GUI。
- **手机**：新建临时会话 → 发送「用一句话说明这个仓库是做什么的」→ 文本**逐字流式出现**（不是一次性整段）→ 点「停止」。
- **通过标准**：① 流式至少可见多次增量（`item/agentMessage/delta`）；② 点停止后手机在 ≤3 s 内显示「已中断」，且桌面 `turn/interrupt` 调用返回成功；③ 中断后会话仍可继续发下一条消息；④ 桌面 Codex 侧确认该轮已结束。
- **证据**：手机录屏（流式+停止）+ 适配器日志（threadId/turnId/interrupt）。

### AC-04 手机关闭计划交付回执显示真实执行状态

- **前置**：手机准备好一份「测试计划」；桌面适配器在线。
- **桌面**：接收计划并交给宿主执行。
- **手机**：点「发送到桌面」后**立刻切后台并杀掉 App**；约 30 s 后重新打开，进入该计划详情。
- **通过标准**：① 回执状态是宿主真实状态（`queued → running → succeeded/failed/interrupted` 之一），不是「已发送=成功」；② 若中途失败，显示失败原因与错误来源（宿主错误码），不显示成功；③ 若执行被中断，显示「已中断」而非「成功」；④ 状态与桌面宿主侧最终状态一致。
- **证据**：手机前后台切换录屏 + 回执状态截图 + 桌面宿主执行记录。

### AC-05 原生审批：拒绝 / 单次允许 / 取消 / 断线重连

- **前置**：Codex 适配器在线，`approvalPolicy` 设置为需要审批；构造一次命令执行审批（`item/commandExecution/requestApproval`）。
- **桌面 + 手机**：
  1. 手机收到审批卡片（含命令/原因/选项）→ 点「拒绝」→ 宿主 `decision=decline`，本轮继续执行但不执行该命令。
  2. 再触发一次 → 点「允许一次」→ 宿主 `decision=accept`，命令执行，**之后再触发仍需再次审批**。
  3. 再触发一次 → 点「拒绝并停止」→ 宿主 `decision=cancel`，本轮立即中断。
  4. 再触发一次 → 收到卡片后**杀手机连接/关 Wi-Fi** → 等 60 s 恢复 → 卡片仍在 → 答复。
- **通过标准**：① 三种决策分别对应宿主原生三种结果；② 「允许一次」不产生持久放行；③ 断线重连后待决请求可重放并能答复（Codex 官方 README 说明 capable client 重连会重放 pending）；④ 若宿主因无人应答已拒绝（humanCommand 场景），手机显示真实结果而非「仍在等待」。
- **证据**：四组决策的宿主侧日志 + 手机录屏 + 断线重连时间线。

### AC-06 一次决定只作用原请求

- **前置**：构造两个并发审批请求（同一会话两个工具调用，或两个会话各一个）。
- **手机**：对请求 A 点「允许」；然后重复点击 A 的「允许」（模拟网络重试）；再尝试用 A 的旧卡片答复 B。
- **通过标准**：① A 的决定只使 A 结算，B 仍为待决；② 重复点击返回幂等结果（已决定），不产生第二次宿主响应；③ 用已结算的 requestId 答复新请求被拒绝（409/410）；④ 宿主侧 `serverRequest/resolved` / `permission.replied` 与适配器 pending 表一致，无残留。
- **证据**：pending 表快照 + 宿主日志 + 手机重复点击录屏。

### AC-07 宿主未提供能力时 UI 清晰提示

- **前置**：准备一个能力受限的组合，例如：Codex 适配器关闭 `experimentalApi`（`request_user_input` 不可用）；或 Gemini 宿主（无提问、模型切换 unstable）。
- **手机**：进入该宿主会话 → 尝试使用「提问」/「切换模型」。
- **通过标准**：① 入口置灰或隐藏，并显示明确文案（「该宿主未提供此能力」/「实验性能力」）；② 不出现无限转圈、不发生静默失败、不把 unsupported 当 error 弹红；③ 文案区分「宿主不支持」与「适配器未实现」。
- **证据**：三种状态（native/experimental/unsupported）的 UI 截图。

### AC-08 各宿主已验证版本与能力记录

- **前置**：每个宿主至少跑通 AC-03/AC-05 的对应子集。
- **桌面**：`/pocket/status`（或新增 `/pocket/hosts`）返回 `hostType`、`hostInstanceId`、`hostVersion`、`adapterVersion`、`capabilities`、协议指纹。
- **手机**：设置页/宿主详情展示上述字段。
- **通过标准**：① 字段齐全且与真实环境一致（例如 Codex 必须显示 `0.171.0-alpha.13.2`）；② 能力矩阵中每个「已支持」项都有对应验收用例编号；③ 未验证项明确标「未验证」而不是默认勾选。
- **证据**：`/pocket/hosts` 响应 + 手机详情截图 + 验收登记表。

### AC-09 DSH 协议回归（宿主内插件不受影响）

- **前置**：安装 1.0.1 插件的 DSH 环境；手机已配对桌面 DSH。
- **桌面 + 手机**：走一遍原有流程：`/pocket/status` → `/pocket/sessions` → 发消息 → 审批 → 提问 → 接力包生成/接收。
- **通过标准**：① 现有 `test/*.mjs`（handoff、handoff-routes、lan-gateway、pocket-core、question-routes）全部通过；② `/pocket/status.protocolVersion` 语义不变（接力/HTTP 字段约定 `1.0.0`）；③ 手机端不需要因适配器上线而升级协议；④ 旧版手机 App 连 1.0.1 仍正常。
- **证据**：测试输出 + 协议版本抓包 + 手机旧版本回归录屏。

### AC-10 MCP 边界：只用于显式发包/收包工具

- **前置**：适配器提供一个 MCP server（仅暴露「把文件/接力包发到手机」「从手机收包」这类显式工具）。
- **桌面 + 手机**：关闭该 MCP server，重复 AC-03/AC-05。
- **通过标准**：① 会话控制（新建/发送/中断/审批/提问）在 MCP 关闭时**仍然工作**（证明没走 MCP）；② MCP 只出现在「显式调用发包/收包工具」路径；③ 文档与实现一致：不再用 MCP 模拟会话控制。
- **证据**：MCP 关闭时的完整流程录屏 + 配置截图。

### 4.11 验收登记模板

| 用例 | 宿主 | 宿主版本 | 适配器版本 | 结果 | 证据链接 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | Codex | 0.171.0-alpha.13.2 | 0.1.0 | 待执行 | | |
| AC-03 | Codex | 0.171.0-alpha.13.2 | 0.1.0 | 待执行 | | |
| AC-05 | Codex | 0.171.0-alpha.13.2 | 0.1.0 | 待执行 | | |
| … | | | | | | |

---

## 5. 实施顺序、风险与测试

### 5.1 实施顺序

**P0（首个可用版本，Codex only）**

1. 适配器骨架：进程生命周期、配置、日志、`hostInstanceId` 持久化、配对确认入口、`/pocket/*` server（移植现有协议 + `hosts` 扩展）。
2. Codex 传输层：spawn `codex app-server --listen stdio://`，握手、stdout 常驻读取、请求/响应/通知分发、重连。
3. Codex 会话：`thread/start{ephemeral}`、`thread/resume`、`thread/read`、`turn/start`、`turn/interrupt`、`model/list`。
4. 事件归一化 + 流式 `item/agentMessage/delta` → `message.delta`。
5. 审批闭环：三类 approval request → 手机四态决策 → 原生 response；`serverRequest/resolved` 清表；断线重连 pending 重放。
6. 提问闭环：`item/tool/requestUserInput` → 手机问答 → `{answers}`（标注实验性）。
7. 决定簿/幂等/归属校验；能力降级 UI；`/pocket/hosts` 版本能力上报。

**P1**

8. OpenCode：HTTP 客户端 + SSE 订阅 + 权限 reply + log 补偿；事件归一化复用 P0 的映射层。
9. Claude：内嵌 SDK、`canUseTool` 映射、`AskUserQuestion`、`defer`（长挂起）方案、session 映射。
10. 多宿主管理 UI（手机端宿主切换、实例管理）、配对设备管理。

**P2**

11. Gemini ACP：最小 client（initialize/newSession/loadSession/prompt/cancel）+ 客户端 fs/terminal 能力 + `session/request_permission`。
12. 既有 GUI/终端会话桥接（§1.5 全部待验证项逐个落地）。
13. MCP 显式工具（发包/收包）与体验打磨。

### 5.2 风险清单

| # | 风险 | 证据 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | **schema 漂移** | Codex 本机 `0.171.0-alpha.13.2` vs npm latest `0.172.0`；非实验/实验 schema 292 vs 438 文件；Claude V2 会话 API 在 `0.3.142` 移除；ACP 有 v1/v2；OpenCode API 自称 Experimental | 升级宿主后解析失败/功能消失 | schema 快照进 CI；未知字段容忍；未知方法探测 + 能力缓存；锁已验证版本并在 UI 标注 |
| R2 | **审批归属** | Codex：请求发给「capable client」，无 capable 连接时 `humanCommand` 直接拒绝、重连才重放；Claude：回调可无限挂起；OpenCode：多客户端谁答复未验证 | 手机与桌面争抢/漏批/卡死 | `requestId` 三元组 + pending 持久化 + 单应答者仲裁（桌面优先或手机优先要显式配置）；超时策略写进 UI |
| R3 | **终端已有会话恢复** | Claude session 是 `~/.claude/projects/...jsonl`，并发写未验证；Codex GUI 与适配器同 thread 订阅未验证；Gemini loadSession 对运行中会话未验证 | resume 后丢消息/双写/上下文错乱 | 首版不桥接既有会话；P2 单独验证；必要时只读 `thread/read` / `listSessions` 展示，不接管 |
| R4 | **同名会话串线** | 各宿主 id 空间独立；title 不唯一；多实例 | 审批/消息发错会话 | 三元组路由 + 服务端归属校验 + 手机端显式目标；同名仅展示 |
| R5 | **iOS 审核边界** | 远程控制桌面 agent、局域网配对、审批执行 | 审核被拒/上架延迟 | 配对必须人工确认且桌面可见；权限裁决始终由宿主执行（App 不自行放行）；说明用途与数据不出局域网；不提供远程 shell 任意执行入口；后台/推送策略需产品确认 |
| R6 | **上游存续** | Gemini CLI 文档横幅：2026-06-18 起被 Antigravity CLI 取代（未付费/Google One）；Codex app-server `[experimental]` | 投入打水漂 | Gemini 放 P2；能力层抽象，宿主可替换 |
| R7 | **事件流不可靠** | OpenCode `/api/event` volatile（慢消费者断流、断线丢事件）；Codex 通知无序突发 | 手机状态与实际不一致 | 适配器维护 `seq` + 重连补洞；OpenCode 用 log/message 补偿；手机端以「最终状态查询」兜底 |
| R8 | **本机无 Claude/OpenCode/Gemini** | 本次只实测 Codex | 文档依据 ≠ 可用 | 实现前按 §5.3 补契约/集成测试；第一条验收前先跑「hello world」连通性 |

### 5.3 需要补的测试

**单元测试**

- `sessionRef` 编解码、三元组解析、归属校验、跨宿主同 id 不冲突。
- `DecisionBook` 复用回归：幂等、TTL、settled 后拒绝、重复答复。
- 事件归一化映射表：每个宿主一组 fixture（原始事件 JSON → 统一事件），含未知事件降级。
- 能力矩阵渲染：native/emulated/experimental/unsupported 四态。

**契约测试（防 schema 漂移，R1 的主要缓解）**

- Codex：CI 跑 `codex app-server generate-json-schema --out <dir>`（含 `--experimental`），对产物做哈希/关键字段快照；变化时失败并人工确认。
- OpenCode：抓 `/docs/openapi.json`，对 `/api/session/*prompt*`、`/api/permission/*`、`/api/event` 的路径与 schema 做快照。
- ACP：对 `initialize`/`newSession`/`prompt`/`request_permission` 的字段做快照；跟踪 v1/v2。
- Claude：锁 `@anthropic-ai/claude-agent-sdk` 与底层 CLI 版本；对 `canUseTool` 返回类型做类型级测试。

**集成测试**

- mock app-server（录制/回放）：模拟 initialize/model/list/thread/start/turn/审批/提问/断线，验证适配器状态机。
- 断线重连：杀 SSE/stdio 连接 → 重连 → 校验 pending 审批/提问/未完成流式被补齐（对应 AC-05/AC-06）。
- 多客户端竞争审批：模拟 GUI 与手机同时应答，验证仲裁与幂等。
- 慢消费者：OpenCode `/api/event` 被拖慢时适配器不丢关键事件（走 log 补偿）。
- 多实例：两个适配器同机 + 同名会话，验证路由（AC-02）。

**回归测试**

- 现有 `test/handoff-routes.test.mjs`、`test/handoff.test.mjs`、`test/lan-gateway.test.mjs`、`test/pocket-core.test.mjs`、`test/question-routes.test.mjs` 全绿（AC-09）。
- `/pocket/status` 的 `protocolVersion` 兼容性；旧版手机 App 连接新桌面。
- 接力包 `PROTOCOL_VERSION` 不变时新旧互通。

**iOS 侧**

- 能力降级 UI 快照测试（native/experimental/unsupported）。
- 配对确认流程 UI 测试（未确认不可用）。
- 重连状态机测试（断网/后台/回前台）。

### 5.4 未验证假设清单（实现前必须逐条消掉）

1. Codex `thread/start`→`turn/start`→`item/agentMessage/delta`→`turn/interrupt` 的完整时序（本次只验证到 `model/list`）。
2. Codex 三类审批请求与 `request_user_input` 的真实交互报文（schema 已确认，**未跑过真实请求**）。
3. Codex 多客户端（GUI + 适配器）同 thread 的通知扇出与审批归属。
4. Claude SDK 的具体版本行为：中断 API、并发 session 写、`defer` 后恢复的用户体验。
5. OpenCode `prompt` 入队→`session.execution.succeeded` 的时序，以及 `permission.asked` 与 `/api/permission/request` 的关系。
6. OpenCode `session.form.*` 是否能满足「提问」语义。
7. Gemini ACP 客户端 fs/terminal 的最小实现范围，以及 `elicitation` 是否可用。
8. 各宿主在**同一台 Mac 上同时运行**时的资源/端口/状态冲突（例如 Codex app-server 单例？OpenCode 端口？）。
9. iOS 后台保活与推送在「审批等待」场景的可用性。

---

## 附录 A 本地实测原始记录

环境：macOS 27.2.1（arm64），2026-11-26。Codex 可执行文件来自 ChatGPT.app 内置，PATH 中无 `codex`；`~/.codex` 为 GUI 状态目录。

### A.1 版本

```text
$ /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
codex-cli 0.171.0-alpha.13.2
```

### A.2 握手与 model/list（Python 子进程，newline-delimited JSON）

发送：

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"pocket-whale-probe","title":"Pocket Whale probe","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"initialized"}
{"jsonrpc":"2.0","id":2,"method":"model/list","params":{"limit":5}}
```

收到：

```jsonc
{"id":1,"result":{"userAgent":"pocket-whale-probe/0.171.0-alpha.13.2 (Mac OS 27.2.1; arm64) dumb (pocket-whale-probe; 0.0.1)","codexHome":"/Users/zhangyizhao/.codex","platformFamily":"unix","platformOs":"macos"}}
{"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"24MacBook-Pro.local","installationId":"…","environmentId":null},"emittedAtMs":1795677942513}
{"id":2,"result":{"data":[{"id":"gpt-6.2-sol", …}, {"id":"gpt-6.2-astra", …}, {"id":"gpt-6.1-terra", …}], …}}
```

观察：

- `model/list` 首次耗时 ≈ **5.0 s**；stderr：

  ```text
  ERROR codex_models_manager::manager: failed to refresh available models: request timed out
  ```

  即在线模型目录刷新超时后回退缓存。适配器首屏不应阻塞等待。
- 服务端会主动推送通知（`remoteControl/status/changed`），适配器必须常驻读取 stdout。

### A.3 参数校验错误

```jsonc
// 发送 turn/start 空参数
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{}}
// 收到
{"error":{"code":-32600,"message":"Invalid request: missing field `threadId`"},"id":3}
```

### A.4 未知方法错误（可作运行期方法枚举）

```jsonc
// 发送
{"jsonrpc":"2.0","id":9,"method":"zzz/probe","params":{}}
// 收到（message 被截断，完整枚举 188 个方法）
{"error":{"code":-32600,"message":"Invalid request: unknown variant `zzz/probe`, expected one of `initialize`, `server/diagnostics`, `userVerification/status`, …, `fuzzyFileSearch/sessionStop`"},"id":9}
```

注意：未知方法是 `-32600`（invalid request）而非标准 JSON-RPC `-32601`（method not found）。

### A.5 schema 生成

```text
$ codex app-server generate-json-schema --out /tmp/codex-schema
→ 顶层 37 个 .json + v1/ 2 个 + v2/ 292 个，共 4.8 MB

$ codex app-server generate-json-schema --experimental --out /tmp/codex-schema-exp
→ v2/ 438 个，共 6.3 MB；出现 RemoteControlPairingStartParams/Response 等 remoteControl/* 定义
```

本地 schema 确认存在的关键定义：`ClientRequest`（含 `thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/interrupt`、`model/list` 等）、`ServerRequest`（含 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、旧版 `execCommandApproval`/`applyPatchApproval`）、`ServerNotification`（含 `serverRequest/resolved`、`item/agentMessage/delta`、`turn/started/completed` 等）、`InitializeParams`/`InitializeResponse`。

### A.6 未做的实测（诚实边界）

- 未创建 thread、未发送 turn、未触发审批/提问 → 端到端交互未验证。
- 未安装/运行 Claude Code、OpenCode、Gemini CLI → 三家全部未本地验证。
- 官方文档页 `developers.openai.com/codex/app-server/` 本次抓取 **HTTP 403**，未读取页面正文；协议细节来自本地 schema/实测与官方仓库 README。

---

## 附录 B 版本与链接核实

| 项目 | 版本/结论 | 核实方式（2026-11-26） |
| --- | --- | --- |
| pocket-whale | `1.0.1`，HEAD `2c0b216`；接力协议 `PROTOCOL_VERSION = 1.0.0` | 本地仓库 |
| Codex CLI | `0.171.0-alpha.13.2` | 本地实测 `--version` |
| `@openai/codex` | latest `0.172.0` | npm registry |
| Claude Agent SDK | `0.3.332` | npm registry |
| Claude Code CLI | `2.1.332` | npm registry |
| OpenCode | `opencode-ai` `1.19.6`；HttpApi `info.version = 0.0.1`，154 路径 | npm registry + 下载 OpenAPI |
| Gemini CLI | `@google/gemini-cli` `0.71.1` | npm registry |
| ACP | v1 Stable + v2 Preview（站点导航） | agentclientprotocol.com |
| macOS | 27.2.1 arm64 | `sw_vers` / `uname` |

官方文档：

- Codex App Server：<https://developers.openai.com/codex/app-server/>（本次 403，未读取正文）
- Codex 仓库协议说明：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Claude Agent SDK · 用户输入/审批：<https://code.claude.com/docs/en/agent-sdk/user-input>
- Claude Agent SDK · 会话：<https://code.claude.com/docs/en/agent-sdk/sessions>
- OpenCode API：<https://opencode.ai/docs/api> ／ OpenAPI：<https://opencode.ai/docs/openapi.json>
- Gemini CLI ACP：<https://geminicli.com/docs/cli/acp-mode/>
- ACP 规范：<https://agentclientprotocol.com/protocol/v1/overview> ／ 工具与权限：<https://agentclientprotocol.com/protocol/v1/tool-calls> ／ 会话建立：<https://agentclientprotocol.com/protocol/v1/session-setup>

---

*本文为设计验证产出，不包含实现代码。所有「未本地验证」项需在对应宿主实现前补齐实测，并把结果回填到 §4.11 验收登记表与 §5.4 假设清单。*
