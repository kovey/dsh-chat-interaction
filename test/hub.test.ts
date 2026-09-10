/**
 * InteractionHub pipeline tests with a mock channel + mock harness.
 * Verifies the proven dsh-feishu behaviors: dedupe, spool, waiter
 * consumption, instant ack, followup wakeup, retry redelivery, teardown.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BaseChannel } from '../src/channel.js'
import { InteractionHub } from '../src/hub.js'
import type { CardSpec, InboundMessage, ListenerStatus, SendResult } from '../src/types.js'

class MockChannel extends BaseChannel {
    readonly name = 'mock'
    readonly label = '模拟'
    override readonly capabilities = { cards: true, richText: true, images: false, inbound: true }
    sent: Array<{ chatId: string; text: string }> = []
    cards: Array<{ chatId: string; card: CardSpec }> = []

    override async connect(): Promise<ListenerStatus> {
        this.setConnected(true)
        return { ok: true, connected: true }
    }

    override async disconnect(): Promise<ListenerStatus> {
        this.setConnected(false)
        return { ok: true, connected: false }
    }

    override async sendText(chatId: string, text: string): Promise<SendResult> {
        this.sent.push({ chatId, text })
        return { ok: true }
    }

    override async sendRichText(chatId: string, title: string, body: string): Promise<SendResult> {
        this.sent.push({ chatId, text: `[post:${title}] ${body}` })
        return { ok: true }
    }

    override async sendCard(chatId: string, card: CardSpec): Promise<SendResult> {
        this.cards.push({ chatId, card })
        return { ok: true, messageId: 'card-' + this.cards.length }
    }

    /** Simulate an inbound platform event. */
    push(msg: Omit<InboundMessage, 'channel'>): void {
        this.emit({ channel: this.name, ...msg })
    }
}

function makeMsg(over: Partial<InboundMessage> = {}): InboundMessage {
    return { channel: 'mock', chatId: 'chat-1', chatType: 'p2p', messageId: 'm-1', messageType: 'text', text: '你好', ...over }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('dispatch wakes the agent via onFollowup, with ack first', async () => {
    const ch = new MockChannel()
    const followups: string[] = []
    const hub = new InteractionHub({
        onFollowup: (msg, ctx) => {
            followups.push(msg.text + (ctx?.note ? ' | ' + ctx.note : ''))
            return true
        },
    })
    hub.addChannel(ch)

    await hub.dispatch(makeMsg({ text: '帮我查个日志' }))
    // ack goes out before the agent turn
    assert.equal(ch.sent.length, 1)
    assert.match(ch.sent[0].text, /收到/)
    assert.deepEqual(followups, ['帮我查个日志'])
})

test('dedupe: the same message_id is delivered once', async () => {
    const ch = new MockChannel()
    let count = 0
    const hub = new InteractionHub({ onFollowup: () => { count += 1; return true }, ack: false })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg())
    await hub.dispatch(makeMsg()) // redelivery
    assert.equal(count, 1)
})

test('router handles plugin-side; unhandled still wakes the agent', async () => {
    const ch = new MockChannel()
    let count = 0
    const hub = new InteractionHub({
        ack: false,
        router: (msg) => (msg.text === 'git status' ? { handled: true, followup: false, mode: 'command' } : { handled: false, followup: true, mode: 'followup' }),
        onFollowup: () => { count += 1; return true },
    })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg({ messageId: 'a', text: 'git status' }))
    await hub.dispatch(makeMsg({ messageId: 'b', text: '写个新功能' }))
    assert.equal(count, 1)
})

test('waitReply consumes the next message and does NOT wake the agent', async () => {
    const ch = new MockChannel()
    let count = 0
    const hub = new InteractionHub({ ack: false, onFollowup: () => { count += 1; return true } })
    hub.addChannel(ch)

    const waiter = hub.waitReply('mock', 'chat-1', 1000)
    await hub.dispatch(makeMsg({ messageId: 'x', text: 'A' }))
    const r = await waiter
    assert.equal(r.timedOut, false)
    assert.equal(r.text, 'A')
    assert.equal(count, 0)
})

test('waitReply times out cleanly', async () => {
    const hub = new InteractionHub({})
    const r = await hub.waitReply('mock', 'chat-9', 50)
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, true)
})

test('pending question blocks waiter consumption (message goes to agent)', async () => {
    const ch = new MockChannel()
    let count = 0
    const hub = new InteractionHub({
        ack: false,
        hasPendingQuestion: (channel, chatId) => channel === 'mock' && chatId === 'chat-1',
        onFollowup: () => { count += 1; return true },
    })
    hub.addChannel(ch)
    void hub.waitReply('mock', 'chat-1', 500)
    await hub.dispatch(makeMsg({ messageId: 'p', text: 'yes' }))
    await sleep(10)
    assert.equal(count, 1)
})

test('images bypass the waiter so the agent sees them as a new turn', async () => {
    const ch = new MockChannel()
    let count = 0
    const hub = new InteractionHub({ ack: false, onFollowup: () => { count += 1; return true } })
    hub.addChannel(ch)
    void hub.waitReply('mock', 'chat-1', 500)
    await hub.dispatch(makeMsg({ messageId: 'img', text: '[图片]', imagePaths: ['/tmp/a.png'] }))
    await sleep(10)
    assert.equal(count, 1)
})

test('spool tee writes JSON lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-'))
    const spool = path.join(dir, 'spool.jsonl')
    const hub = new InteractionHub({ ack: false, spoolFile: spool, onFollowup: () => true })
    await hub.dispatch(makeMsg())
    const lines = fs.readFileSync(spool, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).chatId, 'chat-1')
})

test('outbound sends are success evidence: they cancel pending redeliveries', async () => {
    const ch = new MockChannel()
    let redeliveries = 0
    const hub = new InteractionHub({
        ack: false,
        retry: { baseDelayMs: 1000, pollMs: 5, maxAttempts: 3, probe: () => 'retryable-error' },
        onFollowup: (msg) => {
            if ((msg as InboundMessage & { __retryRedelivery?: boolean }).__retryRedelivery) redeliveries += 1
            return true
        },
    })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg({ messageId: 'r1', text: '任务' }))
    await sleep(20) // poll fires → failures=1 → 1000ms redelivery scheduled
    await hub.sendText('mock', 'chat-1', '进行中') // success evidence → cancel
    await sleep(40)
    assert.equal(redeliveries, 0)
})

test('retry redelivers after a retryable failure', async () => {
    const ch = new MockChannel()
    // first call = arm-time baseline fix (null), then one retryable outcome
    const probeResults: Array<'retryable-error' | 'settled' | null> = [null, 'retryable-error']
    let redeliveries = 0
    const hub = new InteractionHub({
        ack: false,
        retry: {
            baseDelayMs: 10,
            pollMs: 5,
            maxAttempts: 3,
            probe: () => probeResults.shift() ?? null, // retryable once, then unknown → timer fires
        },
        onFollowup: (msg, ctx) => {
            if ((msg as InboundMessage & { __retryRedelivery?: boolean }).__retryRedelivery) {
                redeliveries += 1
                assert.match(ctx?.note || '', /自动重试/)
            }
            return true
        },
    })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg({ messageId: 'r2', text: '任务' }))
    await sleep(60)
    assert.equal(redeliveries, 1)
})

test('retry exhaustion notifies the user', async () => {
    const ch = new MockChannel()
    const hub = new InteractionHub({
        ack: false,
        retry: { baseDelayMs: 5, pollMs: 5, maxAttempts: 2, probe: () => 'retryable-error' },
        onFollowup: () => true,
    })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg({ messageId: 'r3', text: '任务' }))
    await sleep(60)
    assert.ok(ch.sent.some((s) => s.text.includes('自动重试')), 'exhaustion warning was sent')
})

test('teardown settles pending waiters and clears state', async () => {
    const ch = new MockChannel()
    const hub = new InteractionHub({})
    hub.addChannel(ch)
    const waiter = hub.waitReply('mock', 'chat-1', 5000).catch((e: Error) => 'rejected: ' + e.message)
    hub.teardown()
    assert.match((await waiter) as string, /rejected/)
})

test('cards go through the adapter with normalized button specs', async () => {
    const ch = new MockChannel()
    const hub = new InteractionHub({})
    hub.addChannel(ch)
    const r = await hub.sendCard('mock', 'chat-1', {
        title: '确认',
        body: '要推送吗?',
        buttons: ['A|提交+推送|primary', 'D|暂不提交'],
    })
    assert.equal(r.ok, true)
    assert.equal(ch.cards[0].card.buttons!.length, 2)
    const first = ch.cards[0].card.buttons![0] as { value: string; label: string }
    assert.equal(first.value, 'A')
    assert.equal(first.label, '提交+推送')
})

test('scoring: ack goes out first, then score, then followup with the verdict', async () => {
    const ch = new MockChannel()
    const order: string[] = []
    const hub = new InteractionHub({
        ack: () => {
            order.push('ack')
            return null // silence ack text for this test
        },
        score: async (msg) => {
            order.push('score')
            return { score: 0.9, level: 'high', model: 'deepseek-reasoner', reasoning: '需求', source: 'rule' }
        },
        onFollowup: (msg, ctx) => {
            order.push('followup')
            assert.equal(ctx?.score?.level, 'high')
            assert.equal(ctx?.score?.model, 'deepseek-reasoner')
            return true
        },
    })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg({ text: '写一个新功能' }))
    assert.deepEqual(order, ['ack', 'score', 'followup'])
    assert.equal(ch.sent.length, 0) // ack returned null → nothing sent
})

test('scoring verdict is cached: retry redelivery reuses it without re-scoring', async () => {
    const ch = new MockChannel()
    let scoreCalls = 0
    const scores: Array<string | undefined> = []
    const hub = new InteractionHub({
        ack: false,
        score: async () => {
            scoreCalls += 1
            return { score: 0.6, level: 'medium', source: 'rule' }
        },
        retry: { baseDelayMs: 5, pollMs: 5, maxAttempts: 3, probe: () => 'retryable-error' },
        onFollowup: (_msg, ctx) => {
            scores.push(ctx?.score?.level)
            return true
        },
    })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg({ messageId: 'sc1', text: '任务' }))
    await sleep(40)
    assert.ok(scoreCalls === 1, `scored once (was ${scoreCalls})`)
    assert.ok(scores.every((s) => s === 'medium'), 'every redelivery keeps the cached verdict')
})

test('a throwing scorer never blocks delivery (unscored followup)', async () => {
    const ch = new MockChannel()
    let followedUp = false
    const hub = new InteractionHub({
        ack: false,
        score: async () => {
            throw new Error('scorer exploded')
        },
        onFollowup: (_msg, ctx) => {
            followedUp = true
            assert.equal(ctx?.score, undefined)
            return true
        },
    })
    hub.addChannel(ch)
    await hub.dispatch(makeMsg({ messageId: 'sc2', text: '任务' }))
    assert.equal(followedUp, true)
})
