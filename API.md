# 给其他插件用的交互 API

本包除了自己接 IM，还可以作为**其他插件的 IM 交互层**：任何插件都可以通过
`ctx.get('chatInteraction').api` 发消息、问问题、发带按钮的通知、注册 `/命令`，
不必再实现渠道连接、去重、卡片、等待回复、令牌防重放这些基础设施。

> 契约版本：`apiVersion = 1`（见文末「版本策略」）。类型定义随包导出，可直接 import。

## 快速开始

```ts
import type { ChatInteractionApi } from 'dsh-chat-interaction'

export const name = 'my-plugin'
export const inject = ['chatInteraction']

export function apply(ctx: any) {
    const layer = ctx.get('chatInteraction') as { api?: ChatInteractionApi } | undefined
    const chat = layer?.api
    if (!chat || chat.apiVersion < 1) return   // 宿主没装 / 版本太旧：安静降级

    // 发一条消息（渠道/会话可省略，省略时用该渠道记录的 active chat）
    void chat.sendText({ channel: 'feishu' }, '我的插件已启动')

    // 问一个问题（阻塞等回答；超时返回错误而不是抛异常）
    void chat.ask({
        channel: 'feishu',
        title: '要继续吗？',
        options: [
            { value: 'yes', label: '继续', type: 'primary' },
            { value: 'no', label: '停止', type: 'danger' },
        ],
        timeoutMs: 60_000,
    }).then((ans) => {
        if (ans.ok && ans.value.value === 'yes') { /* … */ }
    })
}
```

## 设计原则（为什么它能放心依赖）

1. **不抛异常**：所有可预期的失败（没会话、渠道不支持、超时、被取消）都返回
   `{ ok: false, code, message }`；`code` 是稳定字符串，可分支处理。
2. **一次性令牌**：本 API 发出的每个按钮都带 `ask:<nonce>:<value>` /
   `act:<nonce>:<value>`。转发来的旧卡、上一轮的卡、别人请求的卡点了也**不会**
   误命中当前等待（会继续等真正的回答）。
3. **能力协商**：支持卡片就发卡片；不支持就把按钮渲染成 `1) 2)` 编号文本；
   连文件都不支持时 `sendFile` 明确返回 `channel-unsupported`，不会静默丢内容。
4. **可释放**：每个注册（命令 / 观察者）都返回 `{ dispose() }`；插件卸载或 HMR
   重载时全部自动释放（`api.dispose()` 也会清空）。
5. **不抢 agent 的活**：问答/按钮等待只消费**匹配的**消息（`hub.waitFor` 过滤谓词），
   普通聊天照常交给 agent。

## 目标（target）解析

所有发送/问答方法都接受同一种 `ChatTarget`：

| 写法 | 含义 |
|---|---|
| `{ channel: 'feishu', chatId: 'oc_x' }` | 明确指定（最可控） |
| `{ agent: { id } }` | 该 agent 绑定的会话（多 agent 部署） |
| `{ channel: 'feishu' }` | 该渠道记录的 active chat |
| `{}` | 任一渠道的 active chat |

解析失败返回 `{ ok: false, code: 'no-target' }`。

> **`p2pChat` 的语义**：每个项目/渠道的 `<项目>/.dsh/chat-interaction/<channel>-last-p2p-chat.txt` 记录的是
> **最后一个私聊者**（最近一次 P2P 入站消息的会话 id），**不是"当前审批人"也不是通用目标**。
> 把它当作审批目标是一个坑：它可能已经换成别人。发问前若要断言"这确实是私聊"，用
> `api.resolveChat(target)` / `api.chatKind(target)` 查询，而不是只信配置。

## API 参考

### 元信息

| 方法 | 返回 |
|---|---|
| `api.info()` | `{ apiVersion, pluginVersion, channels }` |
| `api.channels()` | `Array<{ name, label, connected, capabilities }>` |
| `api.capabilities(channel)` | `ApiResult<{ cards, richText, images, files?, inbound }>` |
| `api.status(channel)` / `api.connect(channel)` / `api.disconnect(channel)` | 监听器状态与连接控制（受渠道租约约束） |
| `api.authState(channel)` | 权限模式 / allowlist / active chat / 待确认问题 |

### 发送

```ts
await chat.sendText(target, '纯文本')
await chat.sendRichText(target, '标题', '正文')          // 渠道不支持富文本时自动转纯文本
await chat.sendCard(target, { title, body, buttons })  // 不支持卡片时渲染成编号文本
await chat.sendFile({
    ...target,
    path: 'reports/out.md',   // 相对 root 或绝对路径
    root: '/path/to/project', // 默认 process.cwd()
    name: '报告.md',
})
```

`sendFile` 只允许**项目工作区内**的文件（realpath 包含校验，拒绝 `../` 逃逸与指向外部的
符号链接）——避免被诱导把 `~/.dsh/feishu-app.json` 这类文件发进聊天。

所有发送返回 `ApiResult<{ channel, chatId, messageId? }>`。

### 问答（阻塞）

```ts
const ans = await chat.ask({
    ...target,
    title: '部署到哪个环境？',
    options: [
        { value: 'staging', label: '预发' },
        { value: 'prod', label: '生产', type: 'danger' },
    ],
    timeoutMs: 120_000,
    from: ['ou_xxx'],            // 可选：只接受这些人的回答
    defaultOption: 'staging',    // 可选：超时返回该值而不是 timeout 错误
})
if (ans.ok) {
    ans.value.value    // 'staging' | 'prod'（或自由文本）
    ans.value.via      // 'click' | 'text'
    ans.value.by       // 回答者平台 id
    ans.value.messageId
}
```

返回的 `AskAnswer` 带**出处**：`chatId`（答案来自哪个会话）、`chatKind`（`p2p` / `group`，
平台报告时才存在）、`by`（谁答的）、`messageId`（哪条消息）——审批台账可以因此写清
"谁、从哪个会话、哪条消息"。

> **`by` 的取值**：飞书里优先是 `open_id`（回调中始终存在），缺失时回退 `user_id`。
> 白名单（`from` / 审批人名单）按**任一可用标识**匹配：写 `open_id` 或 `user_id` 都能命中；
> 两个标识都拿不到时按未授权处理（fail closed）。`open_id` 更稳定，推荐用它。

- 答案可以是：按钮点击、选项 `value`、选项 `label`、**1 起始的序号**。
- 无 `options` 时，下一条（匹配 `from` 的）消息就是答案。
- 等待期间无关消息不会打断，也不会被吞掉（它们继续按正常路由处理）。

**被忽略的回答是可观测的**（"有人试图代答"不能只表现为超时）：

```ts
const sub = chat.onAnswerIgnored((e) => {
    // e: { channel, chatId, by?, text, messageId, reason: 'sender-not-allowed' | 'option-mismatch', at }
    audit.write(e)               // 谁在哪个会话、用哪条消息试图回答
})
const stats = chat.stats()       // { askedQuestions, ignoredAnswers, ignoredBySender, ignoredByOptions }
sub.dispose()
```

忽略只影响那一条消息：`ask()` 会继续等待，后续合法回答仍然生效（不会吞掉问题）。

**会话类型查询**（发问前断言"这确实是私聊"）：

```ts
const kind = chat.chatKind({ channel: 'feishu', chatId: 'oc_x' })   // ok: 'p2p' | 'group'；未知 → unknown-chat
const chatInfo = chat.resolveChat({ channel: 'feishu', chatId: 'oc_x' }) // { channel, chatId, kind? }
```

类型来自**已观测到的入站消息**（平台报告的 `chatType`）或项目 p2p 标记；两者都没有时明确返回
`unknown-chat`，而不是猜。

`confirm()` 是问答的语法糖，**超时按拒绝处理**（fail-closed）：

```ts
const r = await chat.confirm(target, { body: '现在发布吗？' }, { timeoutMs: 60_000 })
if (r.ok && r.value.confirmed) { /* … */ }
```

### 通知 + 异步按钮

```ts
const n = await chat.notify({
    ...target,
    level: 'warn',                       // info | warn | error | success
    title: '构建失败',
    body: '第 3 步超时',
    actions: [{ value: 'retry', label: '重试' }, { value: 'skip', label: '跳过' }],
})
if (n.ok && n.value.actionToken) {
    const action = await chat.waitForAction({ ...target, token: n.value.actionToken, timeoutMs: 300_000 })
    if (action.ok) console.log('用户选择', action.value.value)
}
```

`waitForAction` 只消费**该 token** 的按钮点击；普通消息与别的卡片的点击都放行。
返回的 `ActionAnswer` 同样带出处：`chatId` / `chatKind` / `by` / `messageId`。

### Slash 命令

```ts
const sub = chat.registerCommand({
    name: 'deploy',                      // 用户输入 /deploy prod
    description: '部署到指定环境',
    usage: '/deploy <env>',
    async handler(ctx) {
        // ctx: { channel, chatId, args, text, message, reply, log }
        if (!ctx.args[0]) return { text: '用法: /deploy <env>' }
        await ctx.reply.text('开始部署…')
        return { text: `已部署到 ${ctx.args[0]}` }
    },
})
// sub.dispose() 取消注册
```

命令**优先于**待确认问题与任务模式（`/deploy` 是明确意图，不会被当成卡片答案或任务补充），
执行后不再唤醒 agent。命令名只允许 `[a-z0-9][a-z0-9_-]{0,31}`，重复注册会抛错。

### 观察入站消息

```ts
const sub = chat.onInbound((msg) => {
    // 每条去重后的入站消息（只读观察；想回复请用 sendX / ask）
})
sub.dispose()
```

观察者**不能消费**消息（消息仍会走正常路由/唤醒），抛错会被记录而不影响管线。

## 错误码

| code | 含义 | 常见处理 |
|---|---|---|
| `invalid-argument` | 参数不合法（如文件越界、命令名非法） | 修正调用 |
| `no-target` | 无法解析会话 | 显式传 `channel + chatId` |
| `channel-not-found` | 渠道不存在或未装配 | 用 `api.channels()` 检查 |
| `channel-unsupported` | 渠道不具备该能力（如文件） | 降级为文本 |
| `send-failed` | 平台发送失败（附平台错误） | 重试或换渠道 |
| `timeout` | 等待超时 | 用 `defaultOption` 或提示用户 |
| `aborted` | 调用方通过 `signal` 取消 | 正常终止 |
| `unknown-chat` | 该会话从未被观测到、也没有 p2p 标记 | 先发一条消息或显式传 channel+chatId，再用 resolveChat 确认 |
| `internal` | API 已释放或未预期错误 | 记录日志 |

## 生命周期与 HMR

- `layer.api.dispose()` 会清空**所有**命令与观察者；插件 teardown 时自动调用。
- 每次 `registerCommand` / `onInbound` 返回的 `dispose()` 可单独取消。
- 与 DSH 0.2.x 的 `dsh-hmr` 兼容：热重载 = 卸载旧实例 + 重新 apply，注册表随之重建。

## 版本策略

- `api.apiVersion` 是**契约版本**，与本包 semver 独立。
- **新增**方法或可选字段 → `apiVersion` 不变（向后兼容）。例如 `chatId` / `chatKind` /
  `onAnswerIgnored` / `stats` / `resolveChat` 都是本类新增（`AskAnswer.chatId` 属于**必填**字段，
  但只影响读取方对返回值的类型断言，不改变调用方式）。
- **删除/改变语义/修改必填参数** → `apiVersion` +1，并在 CHANGELOG 的「破坏性变更」中说明。
- 插件应以 `if (chat.apiVersion >= N)` 做能力判断，而不是比较包版本号。

## 完整示例

```ts
import type { ChatInteractionApi } from 'dsh-chat-interaction'

export const name = 'nightly-report'
export const inject = ['chatInteraction']

export function apply(ctx: any) {
    const chat = (ctx.get('chatInteraction') as { api?: ChatInteractionApi } | undefined)?.api
    if (!chat) return

    // 用户可在 IM 里手动触发 /report
    chat.registerCommand({
        name: 'report',
        description: '立即生成夜间报告',
        async handler(c) {
            await c.reply.text('正在生成…')
            return { text: '报告已生成并发送' }
        },
    })

    // 每天一次主动推送；失败时降级为普通文本
    setInterval(async () => {
        const sent = await chat.sendFile({ channel: 'feishu', path: 'reports/nightly.md', name: 'nightly.md' })
        if (!sent.ok) await chat.sendText({ channel: 'feishu' }, `夜间报告: ${sent.message}`)
    }, 24 * 3600 * 1000)
}
```
