/**
 * 任务连续性（task-active）核实测试
 *
 * 期望语义（用户要求）：一轮任务开启后，任务期间收到的**所有**消息都应当是
 * 本轮任务的补充或回答 —— 既不能被当作新的无关对话（闲聊/消歧/命令自治），
 * 也不能让插件自己的待确认问题（pending）把它们吞掉。
 *
 * 这些用例同时把当前行为与目标行为的差距固化下来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRouter, resolveRouterConfig } from '../src/router.js'
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
    override async sendText(_c: string, text: string): Promise<SendResult> {
        this.sent.push(text)
        return { ok: true }
    }
    override async sendCard(_c: string, card: CardSpec): Promise<SendResult> {
        this.cards.push(card)
        return { ok: true, messageId: 'c1' }
    }
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
    return { channel: 'probe', chatId: 'chat-1', chatType: 'p2p', messageId: 'm1', messageType: 'text', text: '你好', ...over }
}

function setup(routerCfg: Record<string, unknown> = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-'))
    fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
    const ch = new ProbeChannel()
    const pendingStore = new PendingStore({ dir: path.join(tmp, 'pending') })
    const followups: Array<{ msg: InboundMessage; note?: string }> = []
    const hub = new InteractionHub({
        ack: false,
        // 与 plugin.ts 的真实接线一致：hub 知道插件是否有未回答问题
        hasPendingQuestion: (channel, chatId) => pendingStore.has(channel, chatId),
        onFollowup: (m, ctx) => {
            followups.push({ msg: m, note: ctx?.note })
            return true
        },
    })
    hub.addChannel(ch)
    const router = createRouter({
        hub,
        pendingStore,
        config: resolveRouterConfig({ cwdOf: () => tmp, chatDir: path.join(tmp, 'chat'), ...routerCfg }),
    })
    ;(hub as unknown as { options: { router?: unknown } }).options.router = router
    const markerDir = path.join(tmp, '.dsh', 'probe-task-active')
    const markerFile = path.join(markerDir, 'chat-1.json')
    const writeMarker = (task: string, updatedAt = new Date().toISOString()) => {
        fs.mkdirSync(markerDir, { recursive: true })
        fs.writeFileSync(markerFile, JSON.stringify({ chat_id: 'chat-1', task, updated_at: updatedAt }))
    }
    const readMarker = () => JSON.parse(fs.readFileSync(markerFile, 'utf8')) as { task?: string; updated_at?: string }
    const markerExists = () => fs.existsSync(markerFile)
    return { tmp, ch, hub, pendingStore, followups, markerFile, markerDir, writeMarker, readMarker, markerExists }
}

// ---------------------------------------------------------------------------
// 现状：任务期间的消息必须是"任务补充"
// ---------------------------------------------------------------------------

test('任务进行中：命令样式的消息不会被插件执行，而是转交 agent（带任务上下文）', async () => {
    const { hub, ch, followups, writeMarker } = setup()
    writeMarker('给结算页加导出按钮')
    await hub.dispatch(msg({ text: 'echo this-should-not-run' }))
    assert.equal(ch.sent.length, 0, '插件未自行执行命令')
    assert.equal(followups.length, 1, '消息作为任务补充转交 agent')
    assert.equal(followups[0].msg.text, 'echo this-should-not-run')
    assert.match(followups[0].note || '', /任务/, 'note 说明这是任务上下文')
})

test('任务进行中：闲聊样式消息不会被直答/消歧，而是转交 agent', async () => {
    const { hub, ch, followups, writeMarker } = setup({ autoReply: false })
    writeMarker('排查线上 500')
    await hub.dispatch(msg({ text: '嗯' }))
    assert.equal(ch.cards.length, 0, '不发消歧卡')
    assert.equal(followups.length, 1, '转交 agent 作为任务补充')
})

test('任务进行中：note 必须带上任务名，明确"当成本轮任务的补充/回答"', async () => {
    const { hub, followups, writeMarker } = setup()
    writeMarker('重构订单导出模块')
    await hub.dispatch(msg({ text: '导出字段要加上优惠金额' }))
    const note = followups[0].note || ''
    assert.match(note, /重构订单导出模块/, 'note 带上进行中的任务名')
    assert.match(note, /补充|回答|继续/, 'note 明确这是任务的补充/回答')
})

test('任务进行中：每条消息都给 task 标记续期（长任务不掉出任务模式）', async () => {
    const { hub, writeMarker, readMarker } = setup()
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() // 7 小时前
    writeMarker('长跑任务', old)
    await hub.dispatch(msg({ text: '继续' }))
    const after = readMarker().updated_at!
    assert.ok(Date.parse(after) > Date.parse(old), `marker 已续期（${old} → ${after}）`)
})

test('任务进行中：agent 的 wait_reply 能拿到用户回复（即使插件还有未回答的问题）', async () => {
    const { hub, pendingStore, writeMarker } = setup()
    writeMarker('端到端联调')
    pendingStore.set('probe', 'chat-1', { kind: 'permission-mode', question: '权限模式?' })
    const waiter = hub.waitReply('probe', 'chat-1', 2000)
    await hub.dispatch(msg({ messageId: 'm-answer', text: '日志在 /tmp/app.log' }))
    const r = await waiter
    assert.equal(r.timedOut, false, 'wait_reply 拿到了回答')
    assert.equal(r.text, '日志在 /tmp/app.log')
})

test('任务进行中：卡片点击仍然解决插件的待确认问题（权限模式卡不会永远悬空）', async () => {
    const { hub, pendingStore, writeMarker, tmp } = setup()
    writeMarker('新需求开发')
    pendingStore.set('probe', 'chat-1', {
        kind: 'permission-mode',
        question: '权限模式?',
        options: [{ value: 'A', label: '全自动' }, { value: 'B', label: '需审批' }],
    })
    await hub.dispatch(msg({ messageId: 'card-1', text: 'A', isCardAction: true }))
    assert.equal(pendingStore.has('probe', 'chat-1'), false, 'pending 已解决')
    assert.equal(fs.readFileSync(path.join(tmp, '.dsh', 'probe-permission-mode.txt'), 'utf8').trim(), 'auto')
})

// ---------------------------------------------------------------------------
// 任务开启：自动进入任务模式（不依赖 agent 记得写标记）
// ---------------------------------------------------------------------------

test('需求消息自动开启任务模式（写 task 标记），无需 agent 手动创建', async () => {
    const { hub, markerExists, readMarker } = setup()
    assert.equal(markerExists(), false, '起始无标记')
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    assert.equal(markerExists(), true, '插件自动创建了 task 标记')
    assert.match(readMarker().task || '', /新增一个活动功能/)
})

test('autoTaskMarker:false 时不自动创建标记', async () => {
    const { hub, markerExists } = setup({ autoTaskMarker: false })
    await hub.dispatch(msg({ text: '新增一个活动功能' }))
    assert.equal(markerExists(), false)
})

test('任务模式有绝对上限 maxTaskMs，避免永久占用（超限后回到普通路由）', async () => {
    const { hub, ch, followups, writeMarker } = setup({ maxTaskMs: 60_000 })
    const longAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 分钟前，超 1 分钟上限
    writeMarker('早已该结束的任务', longAgo)
    await hub.dispatch(msg({ text: 'echo normal-routing-again' }))
    assert.equal(followups.length, 0, '不再是任务补充')
    assert.equal(ch.sent.length, 1, '回到普通路由（命令被插件执行）')
})

test('空闲 TTL 过期后不再算任务进行中', async () => {
    const { hub, ch, followups, writeMarker } = setup({ taskActiveTtlMs: 1000 })
    writeMarker('过期的任务', new Date(Date.now() - 60_000).toISOString())
    await hub.dispatch(msg({ text: 'echo ttl-expired' }))
    assert.equal(followups.length, 0)
    assert.equal(ch.sent.length, 1, '普通路由生效')
})
