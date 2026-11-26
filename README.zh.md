# dsh-pocket-whale（口袋鲸 DSH 插件）

English: [README.md](README.md)

口袋鲸是 DeepSeek Harness 的电脑端插件，用来把 DSH 接到 iPhone / Apple Watch。

它在 DSH 里提供一个窄的 `/pocket/*` HTTP + SSE 接口，以及一个面板：接力、设备配对、
审批和提问都在这里完成；工具和文件默认留在电脑上，只有你主动打包的文件才会去手机。

## 功能

- **手机 / 手表桥接**：列会话、发消息、回答审批和单题单选。
- **电脑 → 手机接力**：把没做完的文件和交接说明打包成 `.pockethandoff`；不限扩展名，
  单文件 ≤25MB、总计 ≤60MB（只扫会话目录顶层，不含子目录）。手机接收后放进 workspace 继续做。
- **手机 → 电脑计划**：手机把目标/步骤/验收标准发过来，电脑新建会话执行。
- **局域网配对**：同一个 Wi-Fi 下用短码配对，手机自动发现电脑。
- **DSH 入口**：底部栏、右侧栏「+」菜单（需要 `dsh-better-sidebar`），以及可拖动的
  右下角浮动入口。

## 安装

### 在 DSH 里直接装（推荐）

和其他 DSH 插件一样，在 GUI 里：

**Plugins → Add plugin → 填 `github:fatman24/pocket-whale`（或完整
`https://github.com/fatman24/pocket-whale`）→ Install → 启用「口袋鲸 / Pocket Whale」**。

也可以在终端：

```bash
# 把 <profile> 换成你的 profile：web、desktop…
dsh plugin --profile <profile> add github:fatman24/pocket-whale
```

如果之后发布了 npm 包，可以缩短成：

```bash
dsh plugin --profile <profile> add dsh-pocket-whale@latest
```

不写 `--profile` 就使用默认 profile。只有插件行提示需要重启时才重启。

### 本地开发

```bash
git clone https://github.com/fatman24/pocket-whale.git
```

然后 **Plugins → Add plugin → 选择克隆目录**，或：

```bash
dsh plugin --profile <profile> add /absolute/path/to/pocket-whale
```

这是 DSH bundle，不需要 Xcode，也不是 App Store 应用。

## 怎么用

1. 打开 DSH，在**底部栏**、**右侧栏 + 菜单**或**右下角浮动入口**找到「口袋鲸」。
2. 打开面板 → **设备 / Devices**，确认**插件版本**（应与 `package.json` 的 `version` 一致，
   例如 `1.0.1`）和局域网端口。`/pocket/status` 里的 `protocolVersion` 是接力/HTTP
   字段约定版本，只有字段语义变化时才会动它。
3. iPhone 上打开口袋鲸 App → **连接你的电脑** → 找到电脑并配对。
4. **接力**：电脑上选会话 → 勾选要带的文件 → 生成接力包；手机「接力」里接收。
5. **计划**：手机聊清楚计划 → 发到电脑；电脑上 agent 按计划开工。
6. **审批/提问**：电脑 agent 需要确认时，手机/手表弹卡片，直接批/答。

如果只看到侧边栏、没有右下角浮动入口：面板 → **设置 / Settings** → 打开
**显示右下角浮动入口**。侧边栏和浮动入口是同一页的两个入口，互不影响；
**复位面板位置**可以把拖出屏幕的入口拉回来。

## 安全与数据

- 手机连的是电脑上的本地 DSH；API Key 在哪边配置就留在哪边。
- 配对走局域网短码；已配对设备可以在面板的 **设备** 页断开。
- 没有云中转、没有账号、没有遥测。
- `/pocket/*` 精确路由只对 DSH owner 开放；局域网网关是显式配对入口。

## 开发

```bash
node --test test/*.test.mjs
```

纯 ESM，无构建步骤。包结构：

```
index.js          Host：路由、SSE、审批、接力
client.js         DSH Web：底部栏/侧边栏/浮动面板
lib/              handoff、LAN gateway、协议辅助
locale/           插件管理器元数据（en / zh）
icon.svg          插件图标
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
