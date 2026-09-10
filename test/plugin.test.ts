/**
 * Full-layer integration test: apply() against a structural fake harness,
 * with built-in Feishu + WeCom channels and one custom channel via
 * channelFactories. Verifies tool registration, prompt sections, followup
 * wakeup, auth-state, and teardown — without any real SDKs or network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.js'
import type { DshChatLayer } from '../src/plugin.js'
import { BaseChannel } from '../src/channel.js'
import type { HarnessAgent, HarnessContext } from '../src/harness.js'
import type { InboundMessage, SendResult } from '../src/types.js'

class DingChannel extends BaseChannel {
    readonly name = 'ding'
    readonly label = '钉钉'
    override readonly capabilities = { cards: false, richText: false, images: false, inbound: true }
    override async connect() {
        this.setConnected(true)
        return { ok: true, connected: true, message: 'connected' }
    }
    override async disconnect() {
        this.setConnected(false)
        return { ok: true, connected: false, message: 'disconnected' }
    }
    override async sendText(_chatId: string, _text: string): Promise<SendResult> {
        return { ok: true }
    }
}

interface RegisteredTool {
    name: string
    parameters: unknown
    output: { schema: unknown }
    execute: (args: Record<string, unknown>, exec: { signal?: AbortSignal }) => Promise<unknown>
}

class FakeContext implements HarnessContext {
    tools: RegisteredTool[] = []
    prompts: Array<{ name: string; text: string }> = []
    disposals: Array<() => void> = []
    followups: string[] = []
    provided: Record<string, unknown> = {}
    /** REAL cordis Context — the official installModelSelection seam needs it. */
    readonly agentCtx = new Context()
    private readonly agent: HarnessAgent

    constructor(cwd: string) {
        this.agent = {
            id: 'a1',
            followup: (m) => {
                const content = ((m as { content: Array<{ text?: string }> }).content || [])
                    .map((c) => c.text || '').join('')
                this.followups.push(content)
            },
            ctx: this.agentCtx,
            session: { id: 's1', header: { cwd }, events: [] },
        }
    }

    roots(): HarnessAgent[] {
        return [this.agent]
    }

    registerTool(tool: RegisteredTool): void {
        this.tools.push(tool)
    }

    promptSection(spec: { name: string; text: string }): void {
        this.prompts.push(spec)
    }

    onDispose(fn: () => void): void {
        this.disposals.push(fn)
    }

    on(_event: string, _listener: (...args: any[]) => unknown): void { /* waterfall capture not needed here */ }

    provide(key: string, value: unknown): void {
        this.provided[key] = value
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function setup() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-'))
    const ctx = new FakeContext(tmp)
    const layer = apply(ctx, {
        logFile: path.join(tmp, 'layer.log'),
        spoolFile: path.join(tmp, 'spool.jsonl'),
        pendingDir: path.join(tmp, 'pending'),
        router: { enabled: false }, // raw pipeline behaviour (no plugin autonomy)
        channels: {
            feishu: { appId: 'cli_test', appSecret: 'sec_test' },
            wecom: { corpId: 'corp', corpSecret: 'secret' },
        },
        channelFactories: {
            ding: () => new DingChannel(),
        },
    } as never)
    assert.ok(layer, 'layer assembled')
    return { tmp, ctx, layer: layer as DshChatLayer }
}

test('apply() registers the per-channel tool families with compiled schemas', () => {
    const { ctx } = setup()
    const names = ctx.tools.map((t) => t.name)
    for (const p of ['feishu', 'wecom', 'ding']) {
        assert.ok(names.includes(`${p}_send_message`), `${p}_send_message registered`)
        assert.ok(names.includes(`${p}_wait_reply`), `${p}_wait_reply registered`)
        assert.ok(names.includes(`${p}_listener`), `${p}_listener registered`)
        assert.ok(names.includes(`${p}_auth_state`), `${p}_auth_state registered`)
    }
    // cards only where the platform supports them
    assert.ok(names.includes('feishu_send_card'))
    assert.ok(names.includes('wecom_send_card'))
    assert.ok(!names.includes('ding_send_card'), 'no card tool for a card-less platform')

    // parameters are compiled to JSON schema with required[]
    const send = ctx.tools.find((t) => t.name === 'feishu_send_message')!
    const schema = send.parameters as { type: string; properties: Record<string, unknown>; required: string[] }
    assert.equal(schema.type, 'object')
    assert.ok(schema.properties.chat_id)
    assert.deepEqual(schema.required, ['chat_id', 'text'])
})

test('apply() adds a parameterized prompt section per channel', () => {
    const { ctx } = setup()
    const feishuPrompt = ctx.prompts.find((p) => p.name === 'feishu-channel')!
    assert.match(feishuPrompt.text, /feishu_send_card/)
    assert.match(feishuPrompt.text, /feishu-task-active/)
    assert.match(feishuPrompt.text, /收尾提交方式/)
    const wecomPrompt = ctx.prompts.find((p) => p.name === 'wecom-channel')!
    assert.match(wecomPrompt.text, /wecom_send_message/)
    assert.match(wecomPrompt.text, /企业微信/)
    const dingPrompt = ctx.prompts.find((p) => p.name === 'ding-channel')!
    assert.match(dingPrompt.text, /ding_send_message/)
})

test('inbound dispatch wakes the agent with a [渠道消息] user turn', async () => {
    const { ctx, layer } = setup()
    await layer.hub.dispatch({
        channel: 'ding',
        chatId: 'ding-chat-1',
        chatType: 'p2p',
        messageId: 'd1',
        messageType: 'text',
        text: '写个新需求',
    } as InboundMessage)
    assert.equal(ctx.followups.length, 1)
    assert.match(ctx.followups[0], /^\[钉钉消息\] chat_id: ding-chat-1/)
    assert.match(ctx.followups[0], /写个新需求/)
    assert.match(ctx.followups[0], /ding_send_message/)
})

test('listener control is opt-in: status reports not connected, start works for a role listener channel', async () => {
    const { ctx, layer } = setup()
    const listenerTool = ctx.tools.find((t) => t.name === 'feishu_listener')!
    const st = (await listenerTool.execute({ action: 'status' }, {})) as { ok: boolean; connected: boolean }
    assert.equal(st.ok, true)
    assert.equal(st.connected, false)
    // wecom_listener start without callback config → feed() mode, ok
    const wecomTool = ctx.tools.find((t) => t.name === 'wecom_listener')!
    const wc = (await wecomTool.execute({ action: 'start' }, {})) as { ok: boolean; connected: boolean; message?: string }
    assert.equal(wc.ok, true)
    assert.match(wc.message || '', /feed\(\)/)
    void layer
})

test('role=listener connects at startup (deployment decision)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-'))
    const ctx = new FakeContext(tmp)
    // mock SDK: no real WS connection in unit tests, but the listener lifecycle runs
    const fakeSdk = {
        LoggerLevel: { error: 'error' },
        WSClient: class {
            start() { /* no-op */ }
            close() { /* no-op */ }
        },
        Client: class {
            request() {
                return Promise.reject(new Error('noop'))
            }
        },
        EventDispatcher: class {
            register() {
                return {}
            }
        },
    }
    const layer = apply(ctx, {
        logFile: path.join(tmp, 'layer.log'),
        channels: { feishu: { appId: 'x', appSecret: 'y', role: 'listener', sdk: fakeSdk } },
    } as never) as DshChatLayer
    await sleep(20)
    assert.equal(layer.status('feishu').connected, true, 'role=listener connects the channel at startup')
    layer.teardown()
    // hub drops its channel registry on teardown; the adapter itself is disconnected
    assert.equal(layer.adapters.get('feishu')!.status().connected, false, 'teardown disconnects')
})

test('authState reflects the permission mode file and listener state', () => {
    const { tmp, layer } = setup()
    const dshDir = path.join(tmp, '.dsh')
    fs.mkdirSync(dshDir, { recursive: true })
    fs.writeFileSync(path.join(dshDir, 'feishu-permission-mode.txt'), 'manual\n')
    const st = layer.authState('feishu')
    assert.equal(st.ok, true)
    assert.equal(st.mode, 'manual')
    assert.equal(st.listenerConnected, false)
})

test('teardown is registered and idempotent', async () => {
    const { ctx, layer } = setup()
    assert.equal(ctx.disposals.length, 1)
    ctx.disposals[0]()
    ctx.disposals[0]() // idempotent
    // dispatch after teardown is a no-op
    const before = ctx.followups.length
    await layer.hub.dispatch({ channel: 'ding', chatId: 'c', chatType: 'p2p', text: 'x' } as InboundMessage)
    assert.equal(ctx.followups.length, before)
})

test('service export: the layer is provided to the harness context', () => {
    const { ctx, layer } = setup()
    assert.equal(ctx.provided.chatInteraction, layer)
})

test('official builders: followup messages are real dsh-llm user messages (id + frozen)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-'))
    const ctx = new FakeContext(tmp)
    const layer = apply(ctx, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        channels: { feishu: { appId: 'x', appSecret: 'y' } },
    } as never) as DshChatLayer

    // capture the RAW message object (not just text) through the real agent path
    const rawMessages: unknown[] = []
    const original = ctx.roots()[0].followup
    ctx.roots()[0].followup = (m) => {
        rawMessages.push(m)
        return original(m)
    }
    await layer.hub.dispatch({
        channel: 'feishu',
        chatId: 'c1',
        chatType: 'p2p',
        messageId: 'm-raw',
        messageType: 'text',
        text: '你好',
    } as InboundMessage)
    assert.equal(rawMessages.length, 1)
    const msg = rawMessages[0] as { id: string; role: string; content: Array<{ type: string; text: string }>; source: { kind: string } }
    assert.equal(msg.role, 'user')
    assert.ok(msg.id, 'official createUserMessage assigns an id')
    assert.equal(msg.content[0].text.includes('[飞书消息] chat_id: c1'), true)
    assert.ok(Object.isFrozen(msg), 'official createUserMessage freezes the message')
    layer.teardown()
})

test('scoring: high-complexity messages route to the configured model and the turn is annotated', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-'))
    const ctx = new FakeContext(tmp)
    const layer = apply(ctx, {
        logFile: path.join(tmp, 'layer.log'),
        router: { enabled: false }, // this test covers scoring/model routing only
        scoring: {
            evaluator: 'rule',
            restoreOnTurnEnd: false,
            models: { high: 'deepseek-reasoner', low: 'deepseek-chat' },
            providers: { high: 'deepseek' },
        },
        channels: { feishu: { appId: 'x', appSecret: 'y' } },
    } as never) as DshChatLayer

    await layer.hub.dispatch({
        channel: 'feishu',
        chatId: 'c1',
        chatType: 'p2p',
        messageId: 'm1',
        messageType: 'text',
        text: '紧急: 线上服务报错 500, 堆栈 Error: boom',
        isBotMentioned: true,
    } as InboundMessage)

    const turn = ctx.followups[0]
    assert.match(turn, /消息评分: 0\.90 \(high\) → 执行模型: deepseek-reasoner/)
    assert.match(turn, /评分依据: 代码\/堆栈片段/)

    // the scored-turn override is applied through the OFFICIAL seam:
    // prompt assembly snapshots the selection, request routing applies it
    // (real cordis waterfall with the innermost next as last argument)
    const waterfall = (ctx.agentCtx as unknown as { waterfall: (n: string, ...a: unknown[]) => unknown }).waterfall
        .bind(ctx.agentCtx)
    await waterfall('system-prompt/assemble', {}, {}, async () => ({ variables: {} }))
    const resolved = await waterfall('agent/request', {}, async () => ({ model: 'default-model', reasoningEffort: 'low' }))
    assert.equal((resolved as Record<string, unknown>).model, 'deepseek-reasoner')
    assert.equal((resolved as Record<string, unknown>).provider, 'deepseek')
    assert.equal((resolved as Record<string, unknown>).reasoningEffort, undefined, 'inherited effort cleared')

    // low-complexity message uses its own tier
    await layer.hub.dispatch({
        channel: 'feishu',
        chatId: 'c1',
        chatType: 'p2p',
        messageId: 'm2',
        messageType: 'text',
        text: 'git status',
    } as InboundMessage)
    assert.match(ctx.followups[1], /执行模型: deepseek-chat/)

    layer.teardown()
})

test('scoring disabled → turns are unscored and unannotated', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-'))
    const ctx = new FakeContext(tmp)
    const layer = apply(ctx, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        channels: { feishu: { appId: 'x', appSecret: 'y' } },
    } as never) as DshChatLayer
    await layer.hub.dispatch({
        channel: 'feishu',
        chatId: 'c1',
        chatType: 'p2p',
        messageId: 'm3',
        messageType: 'text',
        text: '你好',
    } as InboundMessage)
    assert.doesNotMatch(ctx.followups[0], /消息评分/)
    layer.teardown()
})
