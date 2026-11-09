/**
 * 面向其他插件的公开交互 API（`layer.api`）的行为测试。
 *
 * 覆盖：能力降级、一次性 token（旧卡/异卡不生效）、超时与 fail-closed、
 * 按钮等待只消费匹配消息、Slash 命令优先于其它路由、观察者与生命周期释放。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InteractionHub } from '../src/hub.js'
import { BaseChannel } from '../src/channel.js'
import { createChatApi } from '../src/api.js'
import { createRouter, resolveRouterConfig } from '../src/router.js'
import { PendingStore } from '../src/pending.js'
import type { CardSpec, InboundMessage, ListenerStatus, SendResult } from '../src/types.js'
import type { ChatInteractionApi } from '../src/api.js'

/** 可配置能力与发送记录的探针渠道。 */
class Probe extends BaseChannel {
    readonly name = 'probe'
    readonly label = '探针'
    override readonly capabilities: import('../src/types.js').ChannelCapabilities
    texts: string[] = []
    cards: CardSpec[] = []
    files: Array<{ path: string; name?: string }> = []
    constructor(
        caps: import('../src/types.js').ChannelCapabilities = {
            cards: true,
            richText: true,
            images: false,
            inbound: true,
            files: true,
        }
    ) {
        super()
        this.capabilities = caps
    }
    override async connect(): Promise<ListenerStatus> {
        this.setConnected(true)
        return { ok: true, connected: true }
    }
    override async disconnect(): Promise<ListenerStatus> {
        this.setConnected(false)
        return { ok: true, connected: false }
    }
    override async sendText(_c: string, text: string): Promise<SendResult> {
        this.texts.push(text)
        return { ok: true, messageId: `om_${this.texts.length}` }
    }
    override async sendRichText(_c: string, title: string, body: string): Promise<SendResult> {
        this.texts.push(`${title}\n\n${body}`)
        return { ok: true, messageId: `om_rich` }
    }
    override async sendCard(_c: string, card: CardSpec): Promise<SendResult> {
        this.cards.push(card)
        return { ok: true, messageId: `om_card_${this.cards.length}` }
    }
    async sendFile(_c: string, file: { path: string; name?: string }): Promise<SendResult> {
        this.files.push(file)
        return { ok: true, messageId: 'om_file' }
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
    channel: 'probe',
    chatId: 'chat-1',
    chatType: 'p2p',
    messageId: `m_${Math.random().toString(36).slice(2, 9)}`,
    messageType: 'text',
    text: 'hi',
    ...over,
})

function setup(caps?: ConstructorParameters<typeof Probe>[0]) {
    const ch = new Probe(caps)
    const hub = new InteractionHub({ ack: false, log: () => undefined })
    hub.addChannel(ch)
    const logs: string[] = []
    const api: ChatInteractionApi = createChatApi({
        pluginVersion: '0.0.0-test',
        hub,
        log: (level: string, ...args: unknown[]) => void logs.push(`${level}:${args.map(String).join(' ')}`),
        adapters: new Map([['probe', ch]]),
        resolveActive: () => ({ channel: 'probe', chatId: 'chat-1' }),
        resolveForAgent: () => ({ channel: 'probe', chatId: 'chat-1' }),
        resolveChatKind: (channel, chatId) => hub.kindOf(channel, chatId),
        connect: (c) => hub.connect(c),
        disconnect: (c) => hub.disconnect(c),
        status: (c) => hub.status(c),
        authState: () => ({
            ok: true,
            mode: 'auto',
            allowlist: [],
            activeChat: 'chat-1',
            p2pChat: 'chat-1',
            listenerRole: 'off',
            listenerConnected: false,
            pendingQuestions: [],
        }),
    })
    return { ch, hub, api, logs }
}

/** 从最近一张卡片取按钮值（含 `ask:<nonce>:<value>`）。 */
function lastButtonValue(ch: Probe, index = 0): string {
    const card = ch.cards[ch.cards.length - 1]!
    const b = card.buttons![index]!
    return typeof b === 'string' ? b.split('|')[0]! : b.value
}

// ---------------------------------------------------------------------------
// 描述与能力
// ---------------------------------------------------------------------------

test('info/channels/capabilities：版本、渠道与未知渠道错误码', () => {
    const { api } = setup()
    const info = api.info()
    assert.equal(info.apiVersion, 1)
    assert.equal(info.pluginVersion, '0.0.0-test')
    assert.equal(info.channels.length, 1)
    assert.equal(info.channels[0]!.name, 'probe')
    assert.equal(api.capabilities('probe').ok, true)
    const missing = api.capabilities('nope')
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.code, 'channel-not-found')
})

test('sendRichText / sendCard 按能力降级（不支持的通道退化为文本）', async () => {
    const { ch, api } = setup({ cards: false, richText: false, images: false, inbound: true, files: false })
    const rich = await api.sendRichText({ channel: 'probe', chatId: 'c' }, '标题', '正文')
    assert.equal(rich.ok, true)
    assert.match(ch.texts.at(-1)!, /标题[\s\S]*正文/)

    const card = await api.sendCard({ channel: 'probe', chatId: 'c' }, {
        title: '选择',
        body: '请选',
        buttons: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    })
    assert.equal(card.ok, true)
    assert.equal(ch.cards.length, 0, '无卡片能力时不发卡片')
    assert.match(ch.texts.at(-1)!, /选择[\s\S]*1\) A[\s\S]*2\) B/)
})

test('sendFile：越界/缺失 → invalid-argument；通道不支持 → channel-unsupported', async () => {
    const { ch, api } = setup()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-'))
    const file = path.join(root, 'spec.md')
    fs.writeFileSync(file, 'x')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-out-'))
    const secret = path.join(outside, 's.json')
    fs.writeFileSync(secret, '{}')

    const okFile = await api.sendFile({ channel: 'probe', chatId: 'c', path: 'spec.md', root })
    assert.equal(okFile.ok, true)
    assert.equal(ch.files.length, 1)

    const escaped = await api.sendFile({ channel: 'probe', chatId: 'c', path: secret, root })
    assert.equal(escaped.ok, false)
    if (!escaped.ok) assert.equal(escaped.code, 'invalid-argument')

    const noFiles = setup({ cards: true, richText: true, images: false, inbound: true, files: false })
    const unsupported = await noFiles.api.sendFile({ channel: 'probe', chatId: 'c', path: 'spec.md', root })
    assert.equal(unsupported.ok, false)
    if (!unsupported.ok) assert.equal(unsupported.code, 'channel-unsupported')
})

// ---------------------------------------------------------------------------
// ask / confirm
// ---------------------------------------------------------------------------

test('ask：卡片按钮带一次性 token，点击命中并返回出处', async () => {
    const { ch, hub, api } = setup()
    const pending = api.ask({
        channel: 'probe',
        chatId: 'chat-1',
        title: '继续吗',
        options: [{ value: 'yes', label: '继续' }, { value: 'no', label: '停止' }],
        timeoutMs: 2000,
    })
    await sleep(10)
    assert.equal(ch.cards.length, 1)
    const button = lastButtonValue(ch)
    assert.match(button, /^ask:[A-Za-z0-9_-]{4,}:(yes|no)$/, '按钮值必须带一次性 token')
    await hub.dispatch(msg({ text: button, isCardAction: true, senderId: 'ou_1' }))
    const ans = await pending
    assert.equal(ans.ok, true)
    if (ans.ok) {
        assert.equal(ans.value.value, 'yes')
        assert.equal(ans.value.via, 'click')
        assert.equal(ans.value.by, 'ou_1')
        assert.equal(ans.value.chatId, 'chat-1')
        assert.equal(ans.value.chatKind, 'p2p', '答案出处必须带会话类型')
    }
})

test('ask：文本答案支持选项值/标签/序号；无关消息不打断等待', async () => {
    const { hub, api } = setup()
    const pending = api.ask({
        channel: 'probe',
        chatId: 'chat-1',
        options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }],
        timeoutMs: 2000,
    })
    await sleep(10)
    await hub.dispatch(msg({ text: '随便聊聊' })) // 无关消息：应继续等待
    await hub.dispatch(msg({ text: '2' })) // 序号
    const ans = await pending
    assert.equal(ans.ok, true)
    if (ans.ok) assert.equal(ans.value.value, 'b')
})

test('ask：旧卡/异卡的 token 被忽略，不会误判为新答案', async () => {
    const { hub, api } = setup()
    const pending = api.ask({
        channel: 'probe',
        chatId: 'chat-1',
        options: [{ value: 'yes', label: '继续' }],
        timeoutMs: 2000,
    })
    await sleep(10)
    await hub.dispatch(msg({ text: 'ask:deadbeefdeadbeef:yes', isCardAction: true }))
    await hub.dispatch(msg({ text: 'yes' }))
    const ans = await pending
    assert.equal(ans.ok, true)
    if (ans.ok) assert.equal(ans.value.via, 'text', '旧卡点击不生效，真正生效的是文本回答')
})

test('ask：超时返回 timeout；给了 defaultOption 则返回默认值', async () => {
    const { api } = setup()
    const timed = await api.ask({ channel: 'probe', chatId: 'chat-1', body: '在吗', timeoutMs: 1000 })
    assert.equal(timed.ok, false)
    if (!timed.ok) assert.equal(timed.code, 'timeout')

    const fallback = await api.ask({
        channel: 'probe',
        chatId: 'chat-1',
        options: [{ value: 'yes', label: '是' }],
        defaultOption: 'no',
        timeoutMs: 1000,
    })
    assert.equal(fallback.ok, true)
    if (fallback.ok) assert.equal(fallback.value.value, 'no')
})

test('confirm：超时 fail-closed（confirmed=false, timedOut=true）', async () => {
    const { api } = setup()
    const r = await api.confirm({ channel: 'probe', chatId: 'chat-1' }, { body: '要发布吗？' }, { timeoutMs: 1000 })
    assert.equal(r.ok, true)
    if (r.ok) {
        assert.equal(r.value.confirmed, false)
        assert.equal(r.value.timedOut, true)
    }
})

test('ask：白名单外的回答被忽略但可观测（事件 + 计数 + warn），不消费问题', async () => {
    const { hub, api, logs } = setup()
    const ignored: Array<{ reason: string; by?: string; chatId: string }> = []
    const sub = api.onAnswerIgnored((e) => void ignored.push({ reason: e.reason, ...(e.by === undefined ? {} : { by: e.by }), chatId: e.chatId }))
    const pending = api.ask({
        channel: 'probe',
        chatId: 'chat-1',
        options: [{ value: 'yes', label: '同意' }, { value: 'no', label: '拒绝' }],
        from: ['ou_allowed'],
        timeoutMs: 2000,
    })
    await sleep(10)
    await hub.dispatch(msg({ text: 'yes', senderId: 'ou_evil' })) // 白名单外：应被忽略
    await hub.dispatch(msg({ text: 'yes', senderId: 'ou_allowed' })) // 合法回答
    const ans = await pending
    sub.dispose()

    assert.equal(ans.ok, true)
    if (ans.ok) assert.equal(ans.value.by, 'ou_allowed')
    assert.deepEqual(ignored, [{ reason: 'sender-not-allowed', by: 'ou_evil', chatId: 'chat-1' }])
    const stats = api.stats()
    assert.equal(stats.ignoredAnswers, 1)
    assert.equal(stats.ignoredBySender, 1)
    assert.ok(stats.askedQuestions >= 1)
    assert.ok(logs.some((l) => l.startsWith('warn:') && l.includes('answer ignored (sender-not-allowed)')), logs.join(' | '))
})

test('ask：from 白名单按任一标识匹配（senderOpenId 也算）', async () => {
    const { hub, api } = setup()
    const pending = api.ask({
        channel: 'probe',
        chatId: 'chat-1',
        options: [{ value: 'yes', label: '同意' }],
        from: ['ou_boss'],
        timeoutMs: 2000,
    })
    await sleep(10)
    await hub.dispatch(msg({ text: 'yes', senderId: '', senderOpenId: 'ou_boss' }))
    const ans = await pending
    assert.equal(ans.ok, true)
    if (ans.ok) assert.equal(ans.value.by, 'ou_boss')
    assert.equal(api.stats().ignoredBySender, 0)
})

test('ask：不匹配选项的回答也计为 option-mismatch（不再静默）', async () => {
    const { hub, api } = setup()
    const pending = api.ask({ channel: 'probe', chatId: 'chat-1', options: [{ value: 'a', label: '甲' }], timeoutMs: 2000 })
    await sleep(10)
    await hub.dispatch(msg({ text: '随便说说' }))
    await hub.dispatch(msg({ text: 'a' }))
    const ans = await pending
    assert.equal(ans.ok, true)
    assert.equal(api.stats().ignoredByOptions, 1)
})

test('chatKind / resolveChat：已观测会话可查询，未知会话明确报 unknown-chat', async () => {
    const { hub, api } = setup()
    await hub.dispatch(msg({ text: 'hi' })) // hub 记录 chat-1 = p2p
    const kind = api.chatKind({ channel: 'probe', chatId: 'chat-1' })
    assert.equal(kind.ok, true)
    if (kind.ok) assert.equal(kind.value, 'p2p')

    const resolved = api.resolveChat({ channel: 'probe', chatId: 'chat-1' })
    assert.equal(resolved.ok, true)
    if (resolved.ok) {
        assert.equal(resolved.value.channel, 'probe')
        assert.equal(resolved.value.chatId, 'chat-1')
        assert.equal(resolved.value.kind, 'p2p')
    }

    const unknown = api.chatKind({ channel: 'probe', chatId: 'chat-never-seen' })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.equal(unknown.code, 'unknown-chat')
})

test('ask：消息未带 chatType 时 chatKind 省略（旧渠道兼容）', async () => {
    const { hub, api } = setup()
    const pending = api.ask({ channel: 'probe', chatId: 'chat-1', timeoutMs: 2000 })
    await sleep(10)
    await hub.dispatch({ channel: 'probe', chatId: 'chat-1', chatType: undefined as never, messageId: 'm-x', messageType: 'text', text: '自由回答' } as never)
    const ans = await pending
    assert.equal(ans.ok, true)
    if (ans.ok) {
        assert.equal(ans.value.chatId, 'chat-1')
        assert.equal(ans.value.chatKind, undefined)
    }
})

// ---------------------------------------------------------------------------
// notify / waitForAction
// ---------------------------------------------------------------------------

test('notify + waitForAction：token 绑定的按钮点击才能唤醒等待', async () => {
    const { ch, hub, api } = setup()
    const notice = await api.notify({
        channel: 'probe',
        chatId: 'chat-1',
        title: '构建完成',
        body: '要重试吗？',
        actions: [{ value: 'retry', label: '重试' }, { value: 'skip', label: '跳过' }],
    })
    assert.equal(notice.ok, true)
    if (!notice.ok) return
    const token = notice.value.actionToken!
    assert.ok(token, '带动作的通知必须返回 actionToken')

    const waiting = api.waitForAction({ channel: 'probe', chatId: 'chat-1', token, timeoutMs: 2000 })
    await sleep(10)
    // 无关卡片点击不消费等待
    await hub.dispatch(msg({ text: 'act:ffffffffffffffff:retry', isCardAction: true }))
    // 普通消息也不消费
    await hub.dispatch(msg({ text: '你好' }))
    await hub.dispatch(msg({ text: `act:${token}:retry`, isCardAction: true, senderId: 'ou_2' }))
    const action = await waiting
    assert.equal(action.ok, true)
    if (action.ok) {
        assert.equal(action.value.value, 'retry')
        assert.equal(action.value.by, 'ou_2')
    }
    void ch
})

test('waitForAction：无 token 且无 values → invalid-argument；超时 → timeout', async () => {
    const { api } = setup()
    const bad = await api.waitForAction({ channel: 'probe', chatId: 'chat-1' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.code, 'invalid-argument')

    const timed = await api.waitForAction({ channel: 'probe', chatId: 'chat-1', values: ['ok'], timeoutMs: 1000 })
    assert.equal(timed.ok, false)
    if (!timed.ok) assert.equal(timed.code, 'timeout')
})

// ---------------------------------------------------------------------------
// commands / observers / lifecycle
// ---------------------------------------------------------------------------

test('registerCommand：路由优先执行 slash 命令，不再唤醒 agent', async () => {
    const { ch, hub, api } = setup()
    const calls: Array<{ args: string[]; text: string }> = []
    api.registerCommand({
        name: 'deploy',
        description: '部署',
        handler: (ctx) => {
            calls.push({ args: ctx.args, text: ctx.text })
            return { text: `部署 ${ctx.args[0] ?? '?'}` }
        },
    })
    const router = createRouter({
        hub,
        pendingStore: new PendingStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-pending-')) }),
        config: resolveRouterConfig({ cwdOf: () => process.cwd() }),
        commands: (api as unknown as { commandRegistry: never }).commandRegistry,
    })
    const woke: unknown[] = []
    ;(hub as unknown as { options: Record<string, unknown> }).options.router = router
    ;(hub as unknown as { options: Record<string, unknown> }).options.onFollowup = (m: unknown) => {
        woke.push(m)
        return true
    }

    await hub.dispatch(msg({ text: '/deploy prod' }))
    assert.deepEqual(calls, [{ args: ['prod'], text: '/deploy prod' }])
    assert.match(ch.texts.at(-1)!, /部署 prod/)
    assert.equal(woke.length, 0, '命令被插件处理，不唤醒 agent')
})

test('registerCommand：非法名/重复注册抛错；commands() 可枚举', () => {
    const { api } = setup()
    assert.throws(() => api.registerCommand({ name: 'bad name', handler: () => undefined }), /invalid command name/)
    api.registerCommand({ name: 'status', description: '状态', handler: () => undefined })
    assert.throws(() => api.registerCommand({ name: 'status', handler: () => undefined }), /already registered/)
    assert.deepEqual(api.commands(), [{ name: 'status', description: '状态' }])
})

test('onInbound：观察者能看到每条入站消息；dispose 后不再收到', async () => {
    const { hub, api } = setup()
    const seen: string[] = []
    const sub = api.onInbound((m) => void seen.push(m.text))
    await hub.dispatch(msg({ text: 'one' }))
    sub.dispose()
    await hub.dispatch(msg({ text: 'two' }))
    assert.deepEqual(seen, ['one'])
})

test('dispose：注销命令与观察者（HMR/卸载安全）', async () => {
    const { hub, api } = setup()
    const seen: string[] = []
    api.onInbound((m) => void seen.push(m.text))
    api.registerCommand({ name: 'x', handler: () => undefined })
    api.dispose()
    assert.deepEqual(api.commands(), [])
    await hub.dispatch(msg({ text: 'after' }))
    assert.deepEqual(seen, [])
    const blocked = await api.sendText({ channel: 'probe', chatId: 'c' }, 'x')
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.equal(blocked.code, 'internal')
})
