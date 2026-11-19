# dsh-pocket-whale

Pocket Whale（口袋鲸）is a DeepSeek Harness (DSH) desktop plugin that connects DSH to the
Pocket Whale iPhone / Apple Watch client.

It exposes a narrow HTTP + SSE surface for the phone, and adds a DSH panel for handoff,
device pairing and approvals. Tools and files stay on the computer unless you explicitly
hand a bundle to the phone.

## Features

- **Phone / Watch bridge**: list sessions, send messages, answer approvals and single-choice
  questions from iPhone or Apple Watch.
- **Handoff (computer → phone)**: package any unfinished files plus a short brief as a
  `.pockethandoff` bundle (any extension, up to 25 MB per file / 60 MB total). The phone
  receives it, puts files in the session workspace, and continues with its own local host.
- **Plan (phone → computer)**: send a goal/plan from the phone; the desktop starts a new
  session and the agent executes it.
- **Local pairing gateway**: pair over the LAN with a short code; the phone discovers the
  desktop automatically on the same Wi-Fi.
- **DSH UI entry**: bottom bar, right-sidebar `+` menu (when `dsh-better-sidebar` is
  installed), and an optional draggable floating entry.

By default the plugin binds a narrow `/pocket/*` surface on the owner's DSH host and an
optional LAN gateway for pairing. It does not upload files to a cloud service and has no
account system.

## Requirements

- DeepSeek Harness desktop with a profile that can install local bundles.
- The Pocket Whale iOS app (or any client implementing the `/pocket/*` protocol).
- Same local network for discovery/pairing; the desktop must be running `dsh web`.

## Install

### From this repository (local directory)

```bash
git clone https://github.com/fatman24/pocket-whale.git
```

In DSH: **Plugins → Add plugin → choose the cloned `pocket-whale` directory → enable
“Pocket Whale / 口袋鲸”**. Restart DSH if the row asks for it.

The package is a bundle with `dsh.bundle.patch`; it is not an App Store app and does not
need Xcode. DSH’s plugin manager performs the profile installation.

### Verify

1. Open DSH in the browser.
2. Look for **口袋鲸 / Pocket Whale** in the bottom bar, the right sidebar `+` menu, or the
   floating entry.
3. Open the panel → **设备 / Devices**; the plugin version and LAN port should appear.
4. In the iPhone app choose **Connect to your computer**, find the desktop, and pair.

If the entry is missing, open **Plugins** and check that the bundle is enabled and no
activation error is shown. If you only see the sidebar tab, enable **显示右下角浮动入口**
in the panel’s **设置 / Settings** tab; the floating entry and sidebar are independent.

## Use it

### Handoff: computer → phone

1. Open a session on the desktop.
2. Open **口袋鲸 → 接力 / Handoff**.
3. Pick the files the phone needs (the current session is preselected) and add a short
   note if needed.
4. Choose **生成接力包 / Create bundle**, then download the `.pockethandoff` file or scan
   the pairing/transfer route shown.
5. On the iPhone: **接力 → 接收**. Files land in the phone’s workspace and a draft session
   is prefilled.

### Plan: phone → computer

1. On the phone, create a session and describe the goal, steps and acceptance criteria.
2. Send it to the desktop from the session’s **Send to desktop** action.
3. The desktop creates a new session with the plan; the agent reads the handoff note before
   starting.

### Approvals and questions

When the desktop agent asks for approval or `ask_user_question`, the phone/watch shows a
card. Approve/deny or answer directly; the desktop continues. Approvals are scoped to the
request id and are idempotent.

### Show/hide the floating entry

Panel → **设置 / Settings** → **显示右下角浮动入口**. The sidebar tab and floating entry
use the same page; closing one does not unregister the other. **复位面板位置** restores
both the launcher and the panel if they were dragged off-screen.

## Security / data

- The phone talks to the desktop’s local DSH host; API keys stay on whichever side the user
  configured them.
- Pairing uses a short-lived code over the LAN; paired devices can be revoked in the panel’s
  **设备 / Devices** tab.
- No cloud relay, no account, no analytics from this plugin.
- Exact `/pocket/*` routes are owner-only on the DSH host; the LAN gateway is an explicit
  pairing surface.

## Development

The plugin is plain ESM JavaScript; no build step.

```bash
node --test packages/pocket-whale/test/*.test.mjs
```

Package layout:

```
index.js          Host plugin: routes, SSE, approvals, handoff
client.js         DSH web client: bottom bar / sidebar / floating panel
lib/              handoff, LAN gateway, shared protocol helpers
locale/           plugin manager metadata (en, zh)
icon.svg          plugin icon
```

## License

MIT. See [LICENSE](LICENSE).
