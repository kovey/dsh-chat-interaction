# dsh-chat-interaction

一个**抽象的交互层**：一边接入 DSH (DeepSeek Harness)，一边接入飞书、企业微信这类 IM 平台。它把 `dsh-feishu` 插件里经过验证的交互模式（去重、即时回执、wait-reply 阻塞问答、followup 唤醒、重试守卫、审批门）**平台无关化**：接飞书、接企业微信、接任何新平台，都只是"实现一个适配器 + 一段配置"，不再是为每个 IM 重写一遍插件。

> 变更历史见 [CHANGELOG.md](CHANGELOG.md)。
>
> **依赖基线：DSH v0.1.5-rc.1**（最新稳定版）。devDependencies 精确锁定
> `@deepseek-ai/{dsh-agent,dsh-llm,dsh-tools}@0.1.5-rc.1` + `cordis@4.0.2`，
> peerDependencies 声明 `^0.1.5-rc.1` 家族（宿主直接复用已装版本）。
> 已针对 0.1.5-rc.1 的破坏性变化完成适配（见「v0.1.5-rc.1 兼容性」）。

```
┌─────────────────────────────┐          ┌──────────────────────────────────┐
│  DSH (harness)              │          │  IM 平台                          │
│  agent.followup()           │          │  飞书 (WS 长连接)                 │
│  ctx.tools.register()       │          │  企业微信 (回调服务器 / feed())   │
│  ctx.systemPrompt.section() │          │  钉钉 / Telegram / ... (自定义)   │
└──────────────┬──────────────┘          └───────────────┬──────────────────┘
               │                                         │
   harness.ts (DshBridge) + harnessFromCordis()   adapters/ (ChannelAdapter)
   model-selection.ts (打分模型切换)                     │
               │                                         │
               └────────────►  hub.ts  ◄─────────────────┘
                去重 · spool · 状态 · wait_reply · 即时回执
                router.ts 插件自治 · scoring.ts 消息打分
                followup · 重试 · tools.ts(按渠道生成) · approval.ts(审批门)
```

## 设计原则

1. **DSH 侧用官方接口，核心侧保持平台无关**。本包就是 dsh 插件，凡是触碰 agent runtime 的地方都直接静态引入官方包——`createUserMessage`(@deepseek-ai/dsh-llm)、`defineTool`(@deepseek-ai/dsh-tools)、`installModelSelection`(@deepseek-ai/dsh-agent)，与 dsh-feishu 的做法一致。面向平台的是 `ChannelAdapter` 接口；hub 管线（去重/spool/waiters/打分/回执/重投）不触碰 runtime，保持在主入口（`dsh-chat-interaction`）无依赖可用。
2. **一个 hub 管所有渠道**。入站管线对所有渠道共用；工具按渠道命名空间自动生成：`feishu_send_message`、`wecom_send_card`、`ding_wait_reply`…… agent 在每个渠道上体验到完全一致的交互语义。
3. **默认不连接（opt-in）**。与 dsh-feishu 一致：插件绝不自行建立连接，仅当用户明确要求（agent 调 `<渠道>_listener action=start`）或部署方显式配置 `role: 'listener'` 才连接。
4. **绝不炸掉宿主**。adapter 的 send 只通过 `SendResult` 报错、connect 只通过 `ListenerStatus` 报错；teardown 释放所有 socket/定时器/waiters，保证 Node 事件循环可退出。

## 使用

### 1. 安装（挂进 DSH）

前置：Node ≥ 18、pnpm、DSH 宿主 **v0.1.5-rc.1**；飞书/企业微信应用凭证（按需）。

**依赖对齐**：本包 `peerDependencies` 是 `@deepseek-ai/{dsh-agent,dsh-llm,dsh-tools}@^0.1.5-rc.1`
+ `cordis@^4.0.2` —— 与 dsh 0.1.5-rc.1 官方宿主提供的版本一致（`dsh --version` 可确认），
pnpm 会直接复用、不会装第二份。

**平台 SDK 会自动安装**：飞书 `@larksuiteoapi/node-sdk` 与企微 `@wecom/crypto` 声明在
`optionalDependencies`（不是 optional peer）—— 上面那条 `dsh plugin add` 会把它们一起装上，
**不需要再手动补依赖**。若你的环境跳过了可选依赖（离线/裁剪安装），按报错提示补装：
`dsh plugin --profile <profile> add @larksuiteoapi/node-sdk`。

```sh
# ① 从 GitHub 安装（推荐；构建产物已入库，装完即用，无需本地构建）
dsh plugin --profile tui add github:kovey/dsh-chat-interaction

#    需要可复现的固定版本时，pin 到 tag（当前最新 v0.1.4）：
#    dsh plugin --profile tui add github:kovey/dsh-chat-interaction#v0.1.4
```

② 启用 bundle —— 编辑 `~/.dsh/profiles/tui/package.json`，把包名加进 `dsh.profile.bundles`：

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "dsh-nvim-tui",                // 原有 bundle 保留
      "dsh-chat-interaction"         // ← 新增本插件
    ]
  }
}
```

③ 重启 TUI 会话。加载后插件自带 `cordis.patch.yml` 会 insert 一行
`id: chatInteraction / name: dsh-chat-interaction/plugin`，即完成挂载。

确认装上了（重启后应能看到这些日志）：

```sh
grep -E "chat-interaction (applying|ready)|channel registered|_\* tools registered" ~/.dsh/chat-interaction.log | tail
```

> `dsh plugin --profile <name> ...` 就是在该 profile 目录内执行 pnpm；
> `bundles` 列表决定 loader 是否加载该包。**只 add 不加 bundles = 装了但不加载。**

<details>
<summary>开发模式：用本地源码（改动即时生效，需自行构建）</summary>

```sh
cd /path/to/dsh-chat-interaction
pnpm install && pnpm build            # 改完 TS 必须重新 build（profile 加载的是 dist/）
ln -sfn "$PWD" ~/.dsh/plugins/dsh-chat-interaction
dsh plugin --profile tui add link:$HOME/.dsh/plugins/dsh-chat-interaction
```

link 安装同样要在 profile 的 `bundles` 里加 `dsh-chat-interaction`，然后重启会话。
开发期改代码 → `pnpm build` → 重启（或重新 install）即可看到效果。
</details>

**卸载**：`dsh plugin --profile tui remove dsh-chat-interaction` → 从 `bundles` 删掉该行
→（若是 link 安装）`rm ~/.dsh/plugins/dsh-chat-interaction` → 重启。

> 为什么是 `/plugin` 子路径：包根 `dsh-chat-interaction` 是 harness-free 的核心
> （hub/渠道/打分/路由），不导出 `apply`；`/plugin` 入口才带 DSH 运行时绑定
> （官方 `createUserMessage` / `defineTool` / `installModelSelection`）。
> `apply()` 同时接受**真实 cordis ctx**（`ctx.agents.roots()` / `ctx.tools.register()`
> / `ctx.systemPrompt.section()` / `ctx.effect()`，自动经 `harnessFromCordis()` 适配）
> 与已扁平化的 `HarnessContext`（测试/自定义宿主）。

### 2. 配置

**a) 插件配置**（profile 覆盖，注意是 **id 覆盖**而非 insert —— bundle 层已经 insert 过，
重复 insert 同 id 会抛 `duplicate loader entry id`）：

```yaml
# ~/.dsh/profiles/tui/cordis.patch.yml
- id: chatInteraction
  config:
    channels:
      feishu:
        role: off                # 默认不连；用户说「连接飞书」才连
      wecom:
        corpId: 'ww********'
        corpSecret: '********'
        agentId: '1000002'
        token: '回调Token'        # 内置回调服务器需要
        aesKey: '43位EncodingAESKey'
        callback: { port: 8787, path: '/wecom' }
    scoring:
      evaluator: auto            # auto | rule | model
      # 模型 id 必须是 provider 目录里声明过的（见 ~/.dsh/settings.yaml 的
      # llm-* → models 列表；本机为 v4 系列）。配错会被守卫丢弃并回退默认模型。
      models: { low: 'deepseek-v4-flash', high: 'deepseek-v4-pro' }
    router:
      evaluator: auto            # 命令/确认/闲聊自治；rule = 不花模型调用
```

**b) 渠道凭证（飞书 App ID/Secret、企微 CorpID/Secret/Token/AESKey）**

两个渠道都是**同一条解析链**（逐字段、前者优先）：

```
① 插件 config  →  ② credsFile  →  ③ <项目>/.dsh/<渠道>-app.json
               →  ④ ~/.dsh/<渠道>-app.json  →  ⑤ 环境变量
```

仓库里给了模板：`examples/feishu-app.json.example`、`examples/wecom-app.json.example`
（`.gitignore` 已挡住真实的 `*-app.json`）。

**飞书**（`feishu-app.json`）

```jsonc
// <项目>/.dsh/feishu-app.json   或   ~/.dsh/feishu-app.json
{ "app_id": "cli_xxxxxxxx", "app_secret": "xxxxxxxx" }
```

怎么拿：
1. [飞书开放平台](https://open.feishu.cn) → 开发者后台 → **创建企业自建应用**；
2. 「凭证与基础信息」→ 复制 **App ID**（`cli_` 开头）与 **App Secret**；
3. 「权限管理」至少开：`im:message`（读取消息）、`im:message:send_as_bot`（以应用身份发消息）、
   `im:resource`（下载图片/文件）；卡片按钮回调需要卡片交互权限；
4. 「事件与回调」→ **订阅方式选「使用长连接接收事件」**（本适配器走 WSClient，
   **不需要公网 IP**）→ 订阅 `接收消息 v1.0 (im.message.receive_v1)` 与卡片回调 `card.action.trigger`；
5. 「机器人」→ 启用机器人能力；发布版本并由管理员通过后，把机器人拉进群或直接私聊。

**企业微信**（`wecom-app.json`）

```jsonc
// <项目>/.dsh/wecom-app.json   或   ~/.dsh/wecom-app.json
{
  "corp_id":     "wwxxxxxxxx",      // 我的企业 → 企业ID
  "corp_secret": "xxxxxxxx",        // 应用管理 → 自建应用 → Secret
  "agent_id":    "1000002",         // 同上，应用 AgentId（可选，发送消息带上更稳）
  "token":       "回调Token",        // 接收消息 → API 接收 → Token
  "aes_key":     "43位EncodingAESKey" // 同上 → EncodingAESKey
}
```

怎么拿：
1. [企业微信管理后台](https://work.weixin.qq.com) → 「我的企业」→ 复制**企业ID**；
2. 「应用管理」→ 自建 → 创建应用 → 复制 **Secret** 与 **AgentId**；
3. 该应用 → **接收消息** → 设置 API 接收：生成 **Token** 与 **EncodingAESKey**，
   URL 填 `http://<公网可达地址>:8787/wecom`（对应 `callback: { port: 8787, path: '/wecom' }`）；
4. 「企业可信 IP」里加上服务器出口 IP（否则发送消息报 `60020 not allow to access from your ip`）。

> 只想**发**不想收（不要回调）：`token`/`aes_key` 可以完全不配，
> `wecom_listener` 会返回「未配置回调服务；通过 feed() 接入外部中间件」；
> 用自己的网关解密后调 `WeComChannel.feed(xml)` 即可。

**企业微信智能机器人**（`wecom-bot.json`，免公网回调）

```jsonc
// <项目>/.dsh/wecom-bot.json   或   ~/.dsh/wecom-bot.json
{ "bot_id": "your-bot-id", "bot_secret": "your-bot-secret" }
```

怎么拿：企业微信管理后台 → **智能机器人**（AI 机器人）→ 创建/进入机器人 → 复制
**机器人 ID** 与 **Secret**。长连接默认 `wss://openws.work.weixin.qq.com`
（私有部署的使用管理端给出的地址，配 `wsUrl`）——**不需要回调 URL、不需要公网 IP**，
也不需要企业可信 IP。

**环境变量方式**（不落盘密钥，适合 CI / 多机）：

| 渠道 | 变量 |
|---|---|
| 飞书 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET` |
| 企业微信（自建应用） | `WECOM_CORP_ID`、`WECOM_CORP_SECRET`、`WECOM_AGENT_ID`、`WECOM_TOKEN`、`WECOM_AES_KEY` |
| 企业微信（智能机器人） | `WECOM_BOT_ID`、`WECOM_BOT_SECRET` |

profile 的 patch 支持 `!!js` 表达式，也可以从环境变量注入而不写明文：

```yaml
- id: chatInteraction
  config:
    channels:
      feishu:
        appId: !!js process.env.FEISHU_APP_ID
        appSecret: !!js process.env.FEISHU_APP_SECRET
      wecom:
        corpId: !!js process.env.WECOM_CORP_ID
        corpSecret: !!js process.env.WECOM_CORP_SECRET
```

**安全**：凭证文件 `chmod 600`；不要提交（`.gitignore` 已含 `*-app.json`）；
项目级文件适合"该应用只服务这个项目"，`~/.dsh/` 级适合多项目共用。

**验证配好了**：

```sh
# 飞书：连接后应看到 bot open_id discovered / feishu ws listener started
# 企微：应看到 wecom access token refreshed / callback server listening
grep -E "bot open_id discovered|ws listener started|access token refreshed|callback server listening" ~/.dsh/chat-interaction.log | tail
```
让 agent 跑一次 `<渠道>_listener(action=start)` 与 `<渠道>_auth_state()` 也能立刻看到连接与凭证状态。

**常见凭证错误**：

| 报错 | 原因 |
|---|---|
| `no Feishu credentials found (feishu-app.json chain / env ...)` | 四个来源都没有 `app_id`+`app_secret` |
| `app_id or app_secret invalid` / WS 连不上 | Secret 复制错、应用未发布、或权限未通过审核 |
| `40013 invalid corpid` | 企微 `corp_id` 不对（注意不是 AgentId） |
| `60020 not allow to access from your ip` | 企微未配置企业可信 IP |
| 回调 `signature mismatch` | `token` / `aes_key` 与后台不一致，或 URL 路径与 `callback.path` 不一致 |
| `feishu: 缺少可选依赖 @larksuiteoapi/node-sdk ...` | 可选依赖被跳过：按提示 `dsh plugin --profile <p> add @larksuiteoapi/node-sdk`，或重装插件（新版本会带上） |
| 智能机器人 `missing bot credentials (...)` | `botId`/`secret` 四类来源都没配（注意它不是 corpId/corpSecret） |
| 智能机器人连不上 / 反复重连 | 机器人 ID 或 Secret 错、机器人未启用；日志里有 `[aibot]` 前缀的重连记录 |

**c) 模型 key**（打分/路由分类/闲聊直答要用模型时）：

```sh
export DEEPSEEK_API_KEY=sk-...        # 或 OPENAI_API_KEY
export DEEPSEEK_BASE_URL=https://...  # 或兼容 OpenAI 的 baseURL；不配则回落纯规则
```

### 3. 首次使用

1. 重启 TUI 会话（插件加载，但**默认不建立任何连接**）。
2. 在会话里对 agent 说 **「连接飞书」**（agent 调 `feishu_listener` 的 `action=start`）；
   企业微信同理（启动回调服务）。也可让 agent 用 `feishu_auth_state` 查看当前状态。
3. 在飞书里给机器人发一条消息：
   - 会先收到**即时回执**（"收到，正在处理～"）；
   - 然后 agent 用 `feishu_send_message` 回复结果；
   - 需要确认时 agent 会发 `feishu_send_card` 卡片，你点按钮后它会收到
     `[飞书卡片点击]` 继续处理。
4. 企业微信还需在**管理后台 → 应用 → 接收消息**里把回调 URL 填成
   `http://<公网可达地址>:8787/wecom`（URL 校验、签名、AES 解密都由适配器完成）；
   也可以用你自己的中间件解密后调 `WeComChannel.feed(xml)`。

### 4. 日常使用

**工具**（每个渠道自动生成一套，前缀 = 渠道名）：

| 工具 | 用途 |
|---|---|
| `feishu_send_message` / `wecom_send_message` | 回文本；带 `title` 时发富文本 |
| `feishu_send_card` / `wecom_send_card` | 交互卡片（按钮值 A/B/yes/…），点击以 `[渠道卡片点击]` 回来 |
| `feishu_wait_reply` / `wecom_wait_reply` | 阻塞等该 chat 的下一条消息（**被本次调用消费**，不产生新回合） |
| `feishu_listener` / `wecom_listener` | `start` / `stop` / `status`，连接控制 |
| `feishu_auth_state` / `wecom_auth_state` | 权限模式、allowlist、active chat、待确认问题 |

**你可以直接对它说的话**：「连接飞书」「断开飞书」「git status」（插件直接执行并回结果）、
「最近提交」「新增一个活动功能」（转交 agent 开发）、「今天天气不错」（闲聊直答）、
卡片上的 A/B/C/D 点击（确认类）。

**权限与审批**（`manual` 模式）：

```sh
echo manual > <项目>/.dsh/feishu-permission-mode.txt   # 或让 agent 发权限模式卡切换
```
之后来自渠道的任务执行 `bash` 时，会先给飞书/企微推「同意 / 拒绝 / 始终同意」卡片；
超时按 fail-closed 拒绝；「始终同意」把该命令追加到 `<项目>/.dsh/<渠道>-permission-allowlist.txt`。

**任务连续性 + 收尾卡**：需求/修复类任务开始时，插件**自动**写
`<项目>/.dsh/<渠道>-task-active/<chat_id>.json`（含任务名 + started_at/updated_at）并进入任务模式：

- 任务期间该 chat 的**每一条**消息都作为**本轮任务的补充或回答**转交 agent（补充细节、
  回答 agent 的提问、提供日志…），不会被命令自治 / 闲聊直答 / 消歧卡截走；
- 每条消息都会**自动续期**标记（长任务不会中途掉出任务模式）；
- agent 用 `wait_reply` 提问时，用户的**普通文本回复优先喂给该等待调用**（即使插件自己也
  有卡片问题悬着）；卡片点击则优先解决插件的卡片问题；
- 退出任务模式：agent 收尾时删除标记（提示词已要求），或空闲超 `taskActiveTtlMs`（默认 8h）、
  或超过绝对上限 `maxTaskMs`（默认 12h）自动失效；
- 任务收尾按提示词策略发「收尾提交方式」四按钮卡
  （A 提交+推送+部署 / B 提交并推送 / C 仅本地提交 / D 暂不提交）。

**打分与模型路由**：每条转交 agent 的消息会先打分，回合里能看到
`消息评分: 0.90 (high) → 执行模型: deepseek-v4-pro`；覆盖只作用于该回合，
回合结束自动恢复会话默认模型。关闭：`scoring: { enabled: false }`。

### 5. 验证与排障

```sh
tail -f ~/.dsh/chat-interaction.log              # 插件日志（TUI 内绝不写 stdout）
tail -f ~/.dsh/chat-interaction-spool.jsonl      # 每条入站消息的 JSONL
```

| 症状 | 排查 |
|---|---|
| agent 没有 `feishu_*` 工具 | `bundles` 未加包名；会话未重启；（本地 link 安装时）忘了 `pnpm build` |
| 安装时报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 装的是带构建脚本的 fork/旧版本：按提示把该包加进 profile 的 `pnpm-workspace.yaml` → `onlyBuiltDependencies`，或改用 link 安装 |
| **宿主启动崩溃，报 `cannot get property "xxx" without inject`** | v0.1.0 的缺陷已修：cordis 的 ctx 只允许访问 `inject` 声明过的服务，旧版探测未知属性会抛错并带走整个 plugin tree。升级到 **≥ v0.1.1**（最新 v0.1.3）：`dsh plugin --profile <p> add github:kovey/dsh-chat-interaction#v0.1.4` |
| 插件装好了但什么都不做 | 日志里的 `channels: (none)`：还没配渠道。按上面「配置」一节给 `channels` 加 feishu / wecom / wecom_bot |
| 说「连接飞书」后仍收不到消息 | 凭证缺失（`feishu_auth_state` 看 `listener_connected`）；日志里的 WS 报错；机器人未被拉进群 |
| 企业微信回调校验失败 | `token`/`aesKey` 与后台不一致；URL 路径与 `callback.path` 不一致；签名报错在日志里 |
| 插件"没反应" | 这是预期：**默认不连接**。要么明确让 agent 连接，要么把 config 里 `role` 设为 `listener`（部署决策） |
| 命令没被执行 | 命中 router 安全层（如 `git push`）→ 已转交 agent 走审批；日志有 `安全层未直接执行` |
| 打分/闲聊没有模型参与 | 未配置 `DEEPSEEK_API_KEY`/`BASE_URL` → 自动回落纯规则（功能不受影响） |
| 日志出现 `model routing: ignoring override — model "xxx" is not in ...` | 配置里的模型 id 不存在：按提示的 available 列表改成真实 id（或用 `dsh` 的 /model 查看目录） |

### 6. 本地自检（排查挂载问题）

不改任何 profile，直接在插件目录里验证「模块可加载 + apply 在真实 ctx 形状下不抛」：

```sh
cd ~/.dsh/profiles/<profile>/node_modules/dsh-chat-interaction
node scripts/selfcheck.mjs        # ✓ 真实 cordis ctx / 敌意 ctx 两条路径都不应抛
```

它会打印每一步的结果与自检日志（含 `apply` 走到了哪一行），是排查
「宿主启动崩溃」「插件没反应」最快的手段。仓库源码目录下同样可用。

### 7. 独立使用核心（不依赖 cordis / 不触 agent runtime）

```ts
import { InteractionHub, createFeishuChannel, createWeComChannel } from 'dsh-chat-interaction'

const hub = new InteractionHub({
  spoolFile: '~/.dsh/chat-spool.jsonl',
  onFollowup: (msg, ctx) => myAgent.followup(msg),   // 你自己接 agent
})

hub.addChannel(createFeishuChannel({ appId: 'cli_...', appSecret: '...' }))
hub.addChannel(createWeComChannel({ corpId: 'ww...', corpSecret: '...' }))

await hub.connect('feishu')                        // 开始收飞书消息
await hub.sendText('feishu', chatId, '你好')
const answer = await hub.waitReply('feishu', chatId, 120_000)
```

## 交互契约（与 dsh-feishu 一一对应）

| dsh-feishu 里的能力 | 本层的对应物 | 说明 |
|---|---|---|
| WS 入站 `im.message.receive_v1` | `FeishuChannel.connect()` | 卡片点击重建卡片并合成 `[飞书卡片点击]` 消息 |
| 企微智能机器人长连接 | `WeComBotChannel.connect()` | 官方 `@wecom/aibot-node-sdk`；免公网回调 |
| `agent.followup(createUserMessage(...))` | `DshBridge.followup()` — 官方 `createUserMessage` | 用户回合同款格式，`[渠道消息] chat_id: ...` |
| `feishu_send_message / _send_card / _wait_reply / _listener / _auth_state` | `buildChannelTools()` 按渠道前缀生成，经官方 `defineTool` 编译注册 | 工具 schema/render/超时与原版一致；`wait_reply` 消费消息、不产生新回合 |
| 消息去重 + spool tee + active-chat 状态 | `InteractionHub.dispatch()` 管线 | 按渠道+message_id 去重；状态文件按项目且按渠道隔离（`feishu-*` / `wecom-*`） |
| 即时回执 ack | hub `ack` 配置 | 唤醒 agent 前先秒回一行，避免用户干等 |
| 命令自治 / 确认解析 / 闲聊直答 / 任务连续性 | `router.ts`（内置，默认开启） | 见「插件自治路由」一节 |
| 模型失败重试守卫 | `RetryGuard` | 回合以可重试错误结束时按指数退避重投；agent 任何发送=成功证据清零 |
| 消息打分 → 模型路由 | `scoring.ts` + 官方 `installModelSelection` | 见下节 |
| manual 模式审批门 (`tools/pre-execute`) | `setupAuthorization()` | 飞书/企微同款 yes/no/always 卡片，超时 fail-closed；`always` 写按渠道允许列表 |
| harness 审批桥 (`approval/request`) | 同左，`permission.bridgeHarnessApproval` | headless 24×7 场景 |
| `ctx.effect(() => teardown)` | `bridge.onDispose()` | 释放 WS/回调服务器/waiters/重试定时器，事件循环可排空 |
| `ctx.provide('feishu', core)` | `ctx.provide('chatInteraction', layer)` | 调试/桥接模式入口 |

## 渠道适配器

### 飞书（`adapters/feishu.ts`，移植自 dsh-feishu 的已验证代码）

- **入站**：Lark WSClient 长连接；`im.message.receive_v1` + `card.action.trigger`；卡片点击重建卡片并合成消息事件。
- **图片**：下载到 `<项目>/.dsh/feishu-media/`，路径随消息交给 agent（`read_image` 直接读）；失败只记 `image_errors`，不阻断消息。
- **出站**：text / post（富文本）/ interactive 卡片；卡片按 message_id 存档供点击重建。
- 凭证链（逐字段）：config → `credsFile` → `<项目>/.dsh/feishu-app.json` → `~/.dsh/feishu-app.json` → `FEISHU_APP_ID`/`FEISHU_APP_SECRET`。详见「使用 → 渠道凭证」。
- **依赖**：`@larksuiteoapi/node-sdk >= 1.60.0` 随插件自动安装（optionalDependencies）；
  若被跳过，`feishu_listener start` 会给出补装命令，也可用 `config.sdk` 注入自定义客户端。

### 企业微信：两条接入路径

企业微信有**两种**机器人形态，本层两条都支持（对应两个渠道名）：

| | `wecom` — 自建应用 | `wecom_bot` — 智能机器人（WS 长连接） |
|---|---|---|
| 凭证 | `corpId` + `corpSecret`（+ `agentId`） | `botId` + `secret` |
| 入站 | **HTTP 回调**（平台 POST 加密 XML）或 `feed()` | **WebSocket 长连接** `wss://openws.work.weixin.qq.com`，SDK 自带认证/心跳/重连 |
| 需要公网 IP | 是（回调 URL 必须公网可达） | **否** |
| 出站 | `message/send`（text / markdown / template_card，2048 字节分片） | `sendMessage`（text / markdown / template_card，支持流式回复） |
| 卡片点击 | `template_card_event`（无 ChatId，靠 `task_id` 映射回查） | `event.template_card_event`（帧内自带 chatid/userid，无需映射） |
| 图片 | `media/get` 下载 | 帧内 URL + 每消息独立 `aeskey`（SDK `downloadFile` 解密） |
| 官方 SDK | 无（HTTP + 内置算法） | `@wecom/aibot-node-sdk`（可选 peer，惰性加载） |

> 之前版本 README 写的「企业微信没有 WS 推送」只对**自建应用**成立；
> 智能机器人（AI 机器人）自 2026 年起提供官方长连接通道，
> 见 [智能机器人长连接文档](https://developer.work.weixin.qq.com/document/path/101463)。

#### `wecom` — 自建应用（回调 / feed）

适配器提供两种入站传输，归一化成同一种 `InboundMessage`：

1. **内置 node:http 回调服务器**（配 `callback.port` + `token` + `aesKey`）——自带 URL 校验、签名校验、AES 解密；
2. **`feed(payload)` 推入接口**——把解密后的事件 XML（或已解析对象）喂进来即可，方便挂 Express/Nest/网关中间件。

- **出站**：text（自动按 2048 字节上限分片）、markdown 富文本（不支持时优雅降级为 text）、`template_card` button_interaction 卡片。
- **卡片点击**：企业微信点击事件**不带 ChatId**，只有 TaskId+EventKey——适配器发送卡片时持久化 `task_id → {chatId, buttons}` 映射，点击时还原出正确的 chat 和按钮值。
- 解密优先用官方 `@wecom/crypto`（若已安装），否则用内置的文档算法实现（AES-256-CBC + PKCS7 + 16 字节随机前缀 + 4 字节长度），零依赖可用。
- 凭证链（与飞书一致，逐字段）：config → `credsFile` → `<项目>/.dsh/wecom-app.json` → `~/.dsh/wecom-app.json` → `WECOM_CORP_ID`/`WECOM_CORP_SECRET`/`WECOM_AGENT_ID`/`WECOM_TOKEN`/`WECOM_AES_KEY`。只发不收时可省 `token`/`aes_key`。

#### `wecom_bot` — 智能机器人（WS 长连接，免公网）

- **入站**：官方长连接通道，帧结构 `{ headers: { req_id }, body: { msgid, chattype, chatid?, from.userid, msgtype, ... } }`；
  群聊取 `chatid`、单聊取 `from.userid` 作为会话 id（正好也是回复用的 `chatid`）。
- **事件**：`message.text/image/mixed/voice/file/video` 归一化成消息；`event.template_card_event` 归一化成卡片点击
  （`text = event_key`）；`event.enter_chat` / `event.feedback_event` 不作为回合。
- **图片**：帧内 URL + 每消息独立 `aeskey`，由 SDK `downloadFile()` 解密后落到 `<项目>/.dsh/wecom_bot-media/`。
- **出站**：`sendMessage(chatid, body)`；`sendText` 先试 `text` 帧、失败自动回落 `markdown`；卡片用 `template_card.button_interaction`。
- **凭证链**：config(`botId`/`secret`) → `credsFile` → `<项目>/.dsh/wecom-bot.json` → `~/.dsh/wecom-bot.json`
  → `<项目>/.dsh/wecom-app.json` → `~/.dsh/wecom-app.json` → `WECOM_BOT_ID`/`WECOM_BOT_SECRET`
  （文件键 `bot_id`/`bot_secret`，兼容 `aibot_id`）。
- **依赖**：`pnpm add @wecom/aibot-node-sdk`（可选 peer；未装时只有该渠道不可用，其余功能不受影响）。

### 自定义渠道（钉钉 / Telegram / Slack / ...）

实现 `ChannelAdapter` 接口（约 40 行），然后：

```ts
import { BaseChannel } from 'dsh-chat-interaction'

class DingChannel extends BaseChannel {
  readonly name = 'ding'
  readonly label = '钉钉'
  override readonly capabilities = { cards: false, richText: false, images: false, inbound: true }
  async connect() { /* 建轮询/长连接 */ this.setConnected(true); return { ok: true, connected: true } }
  async disconnect() { this.setConnected(false); return { ok: true, connected: false } }
  async sendText(chatId: string, text: string) { /* 调钉钉 API */ return { ok: true } }
}

// apply 配置里挂上:
// channelFactories: { ding: (cfg) => new DingChannel() }
```

工具族（`ding_send_message` / `ding_wait_reply` / `ding_listener` / `ding_auth_state`）、系统提示词段落、审批门全部自动生成；`capabilities.cards: false` 的平台不会生成 `send_card` 工具。

## 消息打分与模型路由 (scoring)

每条要交给 agent 的入站消息都会**先被打分（复杂度 0-1）**，分数经阈值映射到档位（low / medium / high），档位再映射到**执行模型**——低复杂度（卡片点击、`git status` 这类只读查询）走便宜模型，报错排查 / 需求开发走最强模型。

```
入站消息 → 去重 → 路由 → 即时回执 → 打分 ─┬─ low    → deepseek-v4-flash
                                         ├─ medium → (配置或会话默认)
                                         └─ high   → deepseek-v4-pro
                                         打分结果随回合标注:
                                         「消息评分: 0.90 (high) → 执行模型: deepseek-v4-pro」
```

- **两个打分器，自动降级**：`ModelScorer`（LLM 评估，沿用飞书插件路由的 evaluateWithModel 模式，JSON 输出）失败/未配置时回落到 `RuleScorer`（确定性启发式：代码堆栈、报错关键词、需求关键词、文档链接、紧急度、消息长度……），打分器抛错**绝不阻断消息投递**（未打分照常唤醒 agent）。
- **模型切换 = 官方 `installModelSelection`**：在 agent 的 cordis `Context` 上安装官方选择引用（`@deepseek-ai/dsh-agent` 的公开 API，宿主自己的入口点也用它），通过 `system-prompt/assemble` 快照 + `agent/request` 注入完成切换；0.1.5-rc.1 新增的 `agent/pre-step` 模型切换提示由官方实现自动获得——没有自造轮子。
- **临时覆盖，自动恢复**：模型覆盖只作用于被打分的那一个回合；回合结束（`turn/end` 事件）后自动恢复会话默认模型，本地后续回合不受影响（也有闲置安全兜底恢复）。
- **重投复用评分**：模型失败重投同一消息时不重复打分，复用缓存结论。
- 关闭：`scoring: { enabled: false }`。

## 插件自治路由 (router)

`router.ts` 把 dsh-feishu 的"插件自治"行为内置进来（默认开启，可用 `router: { enabled: false }` 关闭）：不是每条消息都惊动 agent。

| 分类 | 处理 | 说明 |
|---|---|---|
| `task` | 转交 agent（任务补充/回答） | 该会话有进行中的任务 → **所有**消息都作为本轮任务的补充或回答交给 agent（不被命令自治/闲聊/消歧截走），并**自动续期**任务标记；任务名会写进回合上下文 |
| `confirmation` | 插件内闭环 | 有 pending 问题时解析答案（选项字母 / 是/否/同意 / 全自动/需审批 / 取消）；权限模式选择写入 `<项目>/.dsh/<渠道>-permission-mode.txt`（并重置 allowlist）后**继续推进任务**；**看起来像新指令**的消息绝不吞掉——保持问题打开并转交 agent |
| `command` | 插件内执行 | 安全层：白名单前缀 + 禁止规则；危险命令（`git push`、`rm -rf`、`cat .env`、`deploy`…）**不执行**，转交 agent 走审批流程；输出截断后回执 |
| `requirement` / `bugfix` | 转交 agent **+ 自动发权限模式卡** | 插件发「[需要确认] 权限模式」卡（A 全自动 / B 需审批）+「[收到] 需求已接收」回执，记为 pending；agent 同时开始分析（收到卡片前不重复询问权限模式） |
| `chat` | 插件内直答 / 消歧 | 有模型 key 时用每 chat 会话记忆直答；**无 key 时发「[消歧] 未识别消息」卡**（1 新指令 / 2 闲聊忽略 / 3 其它）——选 1 会把**原文**重放给 agent（不是按钮值），选 2 直接忽略 |

- **分类器**：`evaluator: 'auto'`（默认）= 有 key 用模型评估、失败回落规则；`'rule'` = 永不花模型调用；`'model'` = 只用模型。
- **自动发起**：`autoPermissionCard`（默认 true，任务类消息发权限模式卡）、`autoDisambiguation`（默认 true，无法分类且无模型时发消歧卡）；都可用 `false` 关闭。
- 关闭自动发起后行为回落到"全部转交 agent"，管线依然完整。
- **命令安全层**：`securityCheck()` 是纯函数，白名单 + 禁止规则双重校验；shell 元字符只放行自己生成的固定管线（如 `ps aux | head -20`）。
- **每 chat 记忆**：`chatDir`（默认 `~/.dsh/chat-history/<渠道>/<chat_id>.json`），保留 `chatHistoryTurns` 轮。
- 没有模型 key、没有命令、甚至 router 整个关掉：管线仍然完整（全部转交 agent）。

## 24×7 与心跳接管（lease）

同一层可以同时部署在**两个地方**：launchd/systemd 常驻的 headless 服务，和你在用的 TUI 会话。
两个进程都连同一个机器人会**双投递**每条消息，所以渠道连接由**租约**仲裁：

```
~/.dsh/chat-interaction-lease-<渠道>.json
{ owner, role: 'service' | 'interactive', pid, host, heartbeatAt, acquiredAt }
```

| 角色 | 谁 | 行为 |
|---|---|---|
| `service` | 配了 `channels.<渠道>.role: 'listener'` 的实例（launchd 常驻） | 只在租约空闲时获取；被抢占后**让位并持续等待**，对方离开后**自动重连** |
| `interactive` | 交互式 TUI 会话（默认） | **抢占** service 持有者（人在键盘前优先）；对其它 interactive 实例则是先到先得 |

- **心跳**：持有者每 `heartbeatMs`（默认 30s）续约，同时每 ≤2s 检查一次归属——被抢占后约 2s 内让位，不会长时间双投递。
- **过期接管**：心跳超过 `ttlMs`（默认 90s）视为死进程，任何实例都可以接管（进程崩溃也能自愈）。
- **请求被拒时的提示**：另一个实例正在服务该渠道时会返回明确错误（含持有者角色与心跳时间）。
- **逃生阀**：`lease: { enabled: false }` 完全关闭仲裁（回到旧行为，两个实例都会连）。

```yaml
- id: chatInteraction
  config:
    lease:
      enabled: true          # 默认 true
      role: service          # 不配则按 channels.*.role 推断: 有 listener = service, 否则 interactive
      ttlMs: 90000           # 心跳过期阈值
      heartbeatMs: 30000     # 续约间隔（检查间隔上限 2s）
      dir: ~/.dsh            # 租约文件目录
```

**launchd 部署示例**（headless profile）：

```xml
<!-- ~/Library/LaunchAgents/com.example.dsh-chat.plist -->
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/dsh</string>
  <string>--profile</string><string>headless</string>
</array>
<key>KeepAlive</key><true/>
```
headless profile 的 `channels.<渠道>.role` 设为 `listener`（启动即连、角色=service），
你的 TUI 会话用默认 `interactive`——打开 TUI 说「连接飞书」即接管，关掉 TUI 服务自动收回。

## v0.1.5-rc.1 兼容性

针对最新稳定版逐项核对与适配：

| 接口 | 0.1.5-rc.1 状态 | 本层处理 |
|---|---|---|
| `installModelSelection` / `ModelSelection` / `ModelSelectionRef` | 签名不变；实现新增 `agent/pre-step` 监听（注入模型切换提示） | 直接使用官方函数，新行为自动获得 |
| `defineTool` / `createUserMessage` | 签名不变 | 直接静态引入 |
| `agent.followup` / `agent.ctx` / `Agent.session` | 不变 | 不变 |
| `systemPrompt.section({name, order, text})` | 不变（text 可为函数） | 不变 |
| `tools/pre-execute` | `ToolExecution {name, arguments, agent?, signal}`；`PreToolDecision` = allow / deny / ask | 兼容（审批门返回 allow/deny） |
| `approval/request`（dsh-user-approval 新包） | `{agent, toolName, callId?, reason?, signal?}` → `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` | 兼容（L3 桥返回 allowed-once/rejected） |
| `turn/end` 事件 | 信封不变（`{turn, reason}`），`reason.kind==='error'` 时 `error.code` 仍在（`LlmFailure` 新增 status/requestId 等字段） | 重试码分类照常工作 |
| **`session.events` 数组 → `snapshotEvents()` / `eventAt()`** | **破坏性变化**（旧 dsh-feishu 的 `s.events` 读法失效） | 已适配：`session-events.ts` 优先官方 `snapshotEvents()`，回退旧 `events` 数组；重试探针与模型恢复 poller 均走该适配层 |

```ts
scoring: {
  enabled: true,
  evaluator: 'auto',            // 'rule' | 'model' | 'auto'(模型优先, 规则兜底)
  model: 'deepseek-v4-flash',   // 打分用的评估模型（须在 provider 目录中声明）
  baseURL: '', apiKey: '',      // 留空走 DEEPSEEK_BASE_URL / OPENAI_BASE_URL 环境变量
  thresholds: { medium: 0.4, high: 0.75 },
  models: {                     // 各档位执行模型; 未配置的档位用会话默认
    low: 'deepseek-v4-flash',   // ← 必须是真实存在的模型 id
    high: 'deepseek-v4-pro',
  },
  providers: { high: 'deepseek-official' },   // 与宿主 agent-default-model.provider 一致
  reasoningEfforts: { high: 'high' },         // 合法值: off | low | high | max
  annotateTurn: true,           // 回合内标注评分与模型
  restoreOnTurnEnd: true,       // 回合结束恢复默认模型
}
```

> **模型 id 从哪来**：宿主用它声明的目录解析模型（`~/.dsh/settings.yaml` 的
> `llm-*: models: - id:` 列表，或适配器内置目录；例如 DeepSeek 官方适配器目前是
> `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`）。
> 本层会读取该目录做**守卫**：
> - 打分档位配了不存在的模型 → 丢弃该覆盖（回合用宿主默认模型），日志 warn 一次
> - 评估/分类模型不存在 → 直接走规则路径，不做无效模型调用
> - reasoning effort 非 `off|low|high|max` → 丢弃该字段
> 也就是说：**配置写错只会降级，不会把回合打挂**。

## 完整配置（apply / cordis.patch.yml 的 config）

```ts
{
  enabled: true,                       // 总开关
  logFile: '~/.dsh/chat-interaction.log',
  spoolFile: '~/.dsh/chat-interaction-spool.jsonl', // 每条入站消息 JSONL tee
  pendingDir: '~/.dsh/chat-pending',   // 插件待确认问题存储（按渠道分目录）
  retry: {                             // 模型失败重投守卫; false 关闭
    maxAttempts: 10, baseDelayMs: 30_000, capDelayMs: 600_000, pollMs: 5_000,
  },
  scoring: { /* 见「消息打分与模型路由」一节 */ },
  lease: {                             // 渠道租约（24×7 服务 ⇄ TUI 心跳接管）
    enabled: true,
    role: 'interactive',               // interactive | service (默认按 channels.*.role 推断)
    ttlMs: 90_000,                     // 心跳过期阈值
    heartbeatMs: 30_000,               // 续约间隔（检查间隔上限 2s）
    dir: '~/.dsh',                     // 租约文件目录
  },
  router: {                            // 插件自治（命令/确认/闲聊/任务连续性）
    enabled: true,
    evaluator: 'auto',                 // auto | rule | model
    autoPermissionCard: true,          // 任务类消息自动发权限模式卡
    autoDisambiguation: true,          // 无法分类且无模型时自动发消歧卡
    autoTaskMarker: true,              // 任务开始时自动进入任务模式（写 task-active 标记）
    taskActiveTtlMs: 28_800_000,       // 任务模式空闲 TTL（8h，期间每条消息自动续期）
    maxTaskMs: 43_200_000,             // 任务模式绝对上限（12h，0=不限）
    model: 'deepseek-v4-flash',        // 分类与闲聊用的模型
    autoReply: true,                   // 闲聊是否插件内直答
    chatHistoryTurns: 10,
    chatDir: '~/.dsh/chat-history',
    commandTimeoutMs: 30_000,
    commandMaxOutputChars: 2000,
    taskActiveTtlMs: 28_800_000,       // 任务标记 8h
  },
  permission: {
    mode: 'auto',                      // 权限模式文件缺省值 (auto/manual)
    activeWindowMs: 600_000,           // followup 后 bash 视为渠道来源的窗口
    answerTimeoutMs: 300_000,          // 审批卡超时 → fail closed
    bridgeHarnessApproval: false,      // L3: 把所有 harness 审批转渠道卡片 (headless)
  },
  channels: {
    feishu: {
      enabled: true,
      role: 'off',                     // 'listener' = 启动即连 (部署决策)
      appId: '', appSecret: '',        // 留空走 feishu-app.json 凭证链 / FEISHU_* 环境变量
      credsFile: '',                   // 可选: 显式凭证文件路径
      mediaRetentionDays: 7,
    },
    wecom: {
      enabled: true,
      role: 'off',
      corpId: '', corpSecret: '',       // 留空走 wecom-app.json 链 / WECOM_* 环境变量
      agentId: '',                      // 可选
      token: '', aesKey: '',            // 只用内置回调服务器时需要; 否则可留空 (feed() 模式)
      credsFile: '',                    // 可选: 显式凭证文件路径
      callback: { host: '0.0.0.0', port: 8787, path: '/wecom' },
      mediaRetentionDays: 7,
    },
    // 智能机器人（WS 长连接，与上面的自建应用二选一或并存）
    wecom_bot: {
      enabled: true,
      role: 'off',
      botId: '', secret: '',            // 留空走 wecom-bot.json 链 / WECOM_BOT_* 环境变量
      wsUrl: '',                        // 私有部署的长连接地址（默认官方 wss://openws.work.weixin.qq.com）
      credsFile: '',
      mediaRetentionDays: 7,
    },
  },
  channelFactories: { /* 自定义渠道: { ding: (cfg) => new DingChannel(cfg) } */ },
}
```

## 目录结构

```
src/
  types.ts            规范契约: InboundMessage / CardSpec / SendResult / ...
  channel.ts          ChannelAdapter 接口 + BaseChannel 基类（平台侧的一半）
  hub.ts              InteractionHub: 去重/spool/状态/waiter/回执/打分/followup/重试
  router.ts           插件自治: 命令执行/确认解析/闲聊直答/任务连续性 + 自动发卡 + 安全层
  lease.ts            渠道租约: 心跳接管（service ⇄ interactive 抢占/让位/自动重连）
  scoring.ts          消息打分: RuleScorer + ModelScorer + 档位→模型映射
  session-events.ts   会话事件适配: 0.1.5+ snapshotEvents() / 旧 events 数组
  retry.ts            模型失败重投守卫（指数退避 + 成功证据清零）
  approval.ts         审批门: evaluateGate/parseAnswer + tools/pre-execute 瀑布
  pending.ts          插件待确认问题存储（TTL，按渠道分目录）
  tools.ts            按渠道生成工具族（defineTool 输入形态）
  prompt.ts           系统提示词段落 + 入站消息格式化（按渠道参数化）
  state.ts            项目状态解析（git-common-dir 锚定，按渠道隔离）
  log.ts              文件日志（宿主 TUI 内绝不写 stdout）
  adapters/
    feishu.ts         飞书适配器（WS + API + 卡片重建 + 图片落地）
    wecom.ts          企业微信适配器（回调服务器/feed + API + 任务卡映射）

  # —— DSH 绑定半边（dsh-chat-interaction/plugin, 官方运行时 API @0.1.5-rc.1）——
  plugin.ts           apply() 插件入口：把以上全部组装起来
  plugin-entry.ts     /plugin 入口 (re-export apply/DshBridge/ModelSelectionManager)
  harness.ts          DshBridge: 官方 createUserMessage/defineTool + agent.followup
  model-selection.ts  打分回合的临时模型覆盖：官方 installModelSelection + 回合结束恢复
```

## 开发

```sh
pnpm install      # 与 DSH 宿主同款包管理器; dsh 0.1.5-rc.1 官方包为 devDeps(编译+真实测试), 平台 SDK 为可选 peer
npm test          # build + 160 项测试 (hub 管线 / 路由自治与安全层 / 打分与官方模型切换 / 0.1.5 会话事件适配 / cordis 宿主集成 / 审批门 / 飞书解析 / 企微加解密与解析 / 整层集成)
npm run build     # 产物在 dist/
```

测试离线运行：模型切换测试直接用**真实的** `installModelSelection` + 真实 cordis `Context` 驱动瀑布；飞书 SDK 用 mock 注入，不触网。

## Roadmap

- 钉钉适配器；
- 企微智能机器人的**流式回复**（`replyStream`：把 agent 的中间输出实时推到 IM，需要 hub 侧暴露"回合中间输出"接缝）；
- 多实例共享一条渠道的**负载分担**（当前租约是独占语义，不做分片）。
