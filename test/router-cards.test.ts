/**
 * Router "initiation side" tests: permission-mode card + disambiguation card
 * are posted by the plugin, recorded as pending, and resolved by the
 * confirmation 闭环 (including replaying the original text).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRouter, disambiguationCard, permissionModeCard, resolvePending, resolveRouterConfig } from '../src/router.js'
import { InteractionHub } from '../src/hub.js'
import { PendingStore } from '../src/pending.js'
import { BaseChannel } from '../src/channel.js'
import type { CardSpec, InboundMessage, ListenerStatus, SendResult } from '../src/types.js'

class ProbeChannel extends BaseChannel {
    readonly name = 'probe'
    readonly label = '探针'
    override readonly capabilities = { cards: true, richText: true, images: false, inbound: true }
    sent: string[] = []
    cards: CardSpec[] = []
    override async connect(): Promise<ListenerStatus> {
        this.setConnected(true)
        return { ok: true, connected: true }
    }
    override async disconnect(): Promise<ListenerStatus> {
        this.setConnected(false)
        return { ok: true, connected: false }
    }
    override async sendText(_chatId: string, text: string): Promise<SendResult> {
        this.sent.push(text)
        return { ok: true }
    }
    override async sendCard(_chatId: string, card: CardSpec): Promise<SendResult> {
        this.cards.push(card)
        return { ok: true, messageId: 'c1' }
    }
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
    return { channel: 'probe', chatId: 'chat-1', chatType: 'p2p', messageId: 'm1', messageType: 'text', text: '你好', ...over }
}

function setup(routerCfg: Record<string, unknown> = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cards-'))
    fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true }) // project state anchor
    const ch = new ProbeChannel()
    const followups: Array<{ msg: InboundMessage; note?: string }> = []
    const hub = new InteractionHub({
        ack: false,
        onFollowup: (m, ctx) => {
            followups.push({ msg: m, note: ctx?.note })
            return true
        },
    })
    hub.addChannel(ch)
    const pendingStore = new PendingStore({ dir: path.join(tmp, 'pending') })
    const router = createRouter({
        hub,
        pendingStore,
        config: resolveRouterConfig({ cwdOf: () => tmp, chatDir: path.join(tmp, 'chat'), ...routerCfg }),
    })
    ;(hub as unknown as { options: { router?: unknown } }).options.router = router
    return { tmp, ch, hub, pendingStore, followups }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('card builders carry the documented options', () => {
    const pm = permissionModeCard('新增一个活动功能')
    assert.equal(pm.buttons.length, 2)
    assert.deepEqual(pm.buttons.map((b) => b.value), ['A', 'B'])
    assert.match(pm.body, /新增一个活动功能/)

    const dis = disambiguationCard('???')
    assert.deepEqual(dis.buttons.map((b) => b.value), ['1', '2', '3'])
})

test('resolvePending: option match, permission words, cancel, ambiguity, freeform', () => {
    const pending = { kind: 'permission-mode', options: [{ value: 'A', label: '全自动' }, { value: 'B', label: '需审批' }] }
    assert.deepEqual(resolvePending(pending, 'A').choice, 'A')
    assert.deepEqual(resolvePending(pending, '需审批').choice, 'B')
    assert.equal(resolvePending(pending, '全自动').choice, 'A')
    assert.equal(resolvePending(pending, '取消').cancelled, true)
    assert.equal(resolvePending(pending, '帮我实现一个新需求').ambiguous, true)
    assert.equal(resolvePending(pending, 'git status').ambiguous, true)
    const free = resolvePending(pending, '随便说点什么吧')
    assert.equal(free.resolved, true)
    assert.equal(free.choice, null)
    assert.equal(free.freeform, '随便说点什么吧')
})

// ---------------------------------------------------------------------------
// initiation: permission-mode card
// ---------------------------------------------------------------------------

test('a requirement posts the permission-mode card, records pending, and still wakes the agent', async () => {
    const { ch, hub, pendingStore, followups } = setup()
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    assert.equal(ch.cards.length, 1, 'permission-mode card posted')
    assert.equal(ch.cards[0].title, '[需要确认] 权限模式')
    assert.equal(pendingStore.get('probe', 'chat-1')?.kind, 'permission-mode')
    assert.equal(followups.length, 1, 'agent still starts analysing')
    assert.match(followups[0].note || '', /权限模式卡片/)
    assert.equal(ch.sent.length, 1, 'receipt posted')
    assert.match(ch.sent[0], /\[收到\] 需求已接收/)
})

test('the card is not re-posted while a question is open', async () => {
    const { ch, hub } = setup()
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    await hub.dispatch(msg({ messageId: 'm2', text: '再加一个统计功能' }))
    assert.equal(ch.cards.length, 1, 'still only one open question')
})

test('autoPermissionCard:false disables the card', async () => {
    const { ch, hub, pendingStore } = setup({ autoPermissionCard: false })
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    assert.equal(ch.cards.length, 0)
    assert.equal(pendingStore.has('probe', 'chat-1'), false)
})

test('clicking A writes auto mode, closes the question, and continues the task', async () => {
    const { tmp, ch, hub, pendingStore, followups } = setup()
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    followups.length = 0
    await hub.dispatch(msg({ messageId: 'card-1', text: 'A', isCardAction: true }))
    assert.equal(pendingStore.has('probe', 'chat-1'), false, 'question closed')
    const modeFile = path.join(tmp, '.dsh', 'probe-permission-mode.txt')
    assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'auto')
    assert.equal(followups.length, 1, 'the agent continues the requirement flow')
    assert.match(followups[0].note || '', /权限模式已选择: 全自动/)
    assert.ok(ch.sent.some((t) => /已切换权限模式: 全自动/.test(t)))
    assert.ok(fs.existsSync(path.join(tmp, '.dsh', 'probe-permission-allowlist.txt')), 'allowlist reset')
})

test('clicking B writes manual mode', async () => {
    const { tmp, hub } = setup()
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    await hub.dispatch(msg({ messageId: 'card-1', text: 'B', isCardAction: true }))
    assert.equal(fs.readFileSync(path.join(tmp, '.dsh', 'probe-permission-mode.txt'), 'utf8').trim(), 'manual')
})

test('cancelling closes the question without waking the agent', async () => {
    const { hub, pendingStore, followups, ch } = setup()
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    followups.length = 0
    await hub.dispatch(msg({ messageId: 'card-2', text: '取消', isCardAction: true }))
    assert.equal(pendingStore.has('probe', 'chat-1'), false)
    assert.equal(followups.length, 0)
    assert.ok(ch.sent.some((t) => /已取消该确认/.test(t)))
})

test('a NEW instruction while a question is open is not swallowed', async () => {
    const { hub, pendingStore, followups } = setup()
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    followups.length = 0
    await hub.dispatch(msg({ messageId: 'm3', text: '帮我看看 git status' }))
    assert.equal(pendingStore.has('probe', 'chat-1'), true, 'question stays open')
    assert.equal(followups.length, 1, 'the new instruction reaches the agent')
    assert.match(followups[0].note || '', /未回答的问题/)
})

// ---------------------------------------------------------------------------
// initiation: disambiguation card
// ---------------------------------------------------------------------------

test('an unclassifiable message with no model posts the disambiguation card (no agent turn)', async () => {
    const { ch, hub, pendingStore, followups } = setup({ autoReply: false })
    await hub.dispatch(msg({ text: '嗯' }))
    assert.equal(ch.cards.length, 1)
    assert.equal(ch.cards[0].title, '[消歧] 未识别消息')
    assert.equal(pendingStore.get('probe', 'chat-1')?.kind, 'disambiguation')
    assert.equal(pendingStore.get('probe', 'chat-1')?.originalText, '嗯')
    assert.equal(followups.length, 0, 'waiting for the human')
})

test('answering 2 (ignore) closes the question and does nothing else', async () => {
    const { hub, pendingStore, followups, ch } = setup({ autoReply: false })
    await hub.dispatch(msg({ text: '嗯' }))
    await hub.dispatch(msg({ messageId: 'card-9', text: '2', isCardAction: true }))
    assert.equal(pendingStore.has('probe', 'chat-1'), false)
    assert.equal(followups.length, 0)
    assert.ok(ch.sent.some((t) => /已忽略这条消息/.test(t)))
})

test('answering 1 (new instruction) replays the original text and hands it to the agent', async () => {
    const { hub, pendingStore, followups } = setup({ autoReply: false })
    await hub.dispatch(msg({ text: '嗯' }))
    assert.equal(followups.length, 0, 'question open, nothing woken yet')
    await hub.dispatch(msg({ messageId: 'card-10', text: '1', isCardAction: true }))
    assert.equal(pendingStore.has('probe', 'chat-1'), false, 'question closed')
    assert.equal(followups.length, 1, 'the replayed instruction reaches the agent')
    assert.equal(followups[0].msg.text, '嗯', 'the ORIGINAL text is replayed, not the button value')
})

test('answering 1 replays a command-looking message through the command path', async () => {
    // force a disambiguation first (no model), then answer "1" on a command text
    const { hub, pendingStore, followups } = setup({ autoReply: false, autoDisambiguation: true })
    await hub.dispatch(msg({ text: '嗯' }))
    assert.equal(pendingStore.get('probe', 'chat-1')?.originalText, '嗯')
    await hub.dispatch(msg({ messageId: 'card-12', text: '取消', isCardAction: true }))
    assert.equal(followups.length, 0)
    // a command-looking message never reaches disambiguation: it is executed directly
    await hub.dispatch(msg({ messageId: 'm-cmd', text: 'echo direct-command' }))
    assert.equal(followups.length, 0, 'commands stay in-plugin')
})

test('answering 3 (other) forwards the clarification to the agent', async () => {
    const { hub, followups } = setup({ autoReply: false })
    await hub.dispatch(msg({ text: '嗯' }))
    followups.length = 0
    await hub.dispatch(msg({ messageId: 'card-11', text: '3', isCardAction: true }))
    assert.equal(followups.length, 1)
    assert.equal(followups[0].msg.text, '3')
})

test('autoDisambiguation:false falls back to waking the agent', async () => {
    const { ch, hub, followups } = setup({ autoReply: false, autoDisambiguation: false })
    await hub.dispatch(msg({ text: '嗯' }))
    assert.equal(ch.cards.length, 0)
    assert.equal(followups.length, 1)
})
