/**
 * Host integration test: apply() against a REAL cordis-shaped context
 * (services hang off the context: ctx.agents / ctx.tools / ctx.systemPrompt /
 * ctx.effect / ctx.on / ctx.provide) — the shape a DSH host actually passes to
 * a plugin's apply(). Guards against the flat-HarnessContext/real-ctx mismatch
 * that would silently register nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/plugin.js'
import type { DshChatLayer } from '../src/plugin.js'
import { harnessFromCordis, isHarnessContext } from '../src/harness.js'
import { BaseChannel } from '../src/channel.js'
import type { InboundMessage, SendResult } from '../src/types.js'
import type { HarnessAgent } from '../src/harness.js'

class ProbeChannel extends BaseChannel {
    readonly name = 'probe'
    readonly label = '探针'
    override readonly capabilities = { cards: false, richText: false, images: false, inbound: true }
    override async connect() {
        this.setConnected(true)
        return { ok: true, connected: true }
    }
    override async disconnect() {
        this.setConnected(false)
        return { ok: true, connected: false }
    }
    override async sendText(_chatId: string, _text: string): Promise<SendResult> {
        return { ok: true }
    }
}

/** A context shaped like a real cordis/dsh plugin context. */
function makeCordisLikeCtx(cwd: string) {
    const state = {
        tools: [] as unknown[],
        prompts: [] as Array<{ name: string; text: string }>,
        effects: [] as Array<() => unknown>,
        listeners: new Map<string, (...args: any[]) => unknown>(),
        provided: new Map<string, unknown>(),
        followups: [] as unknown[],
    }
    const agent: HarnessAgent = {
        id: 'root-1',
        followup: (m) => { state.followups.push(m) },
        session: { id: 'sess-1', header: { cwd }, events: [] },
    }
    const ctx = {
        agents: { roots: () => [agent] },
        tools: { register: (tool: unknown) => { state.tools.push(tool) } },
        systemPrompt: { section: (spec: { name: string; text: string }) => { state.prompts.push(spec) } },
        effect: (execute: () => unknown) => { state.effects.push(execute) },
        on: (event: string, listener: (...args: any[]) => unknown) => { state.listeners.set(event, listener) },
        provide: (key: string, value: unknown) => { state.provided.set(key, value) },
    }
    return { ctx, state, agent }
}

test('isHarnessContext distinguishes flat contexts from real cordis contexts', () => {
    const flat = { roots: () => [], registerTool: () => undefined, promptSection: () => undefined, onDispose: () => undefined }
    assert.equal(isHarnessContext(flat), true)
    const { ctx } = makeCordisLikeCtx('/tmp')
    assert.equal(isHarnessContext(ctx), false)
})

test('harnessFromCordis maps every host service onto the flat contract', () => {
    const { ctx, state } = makeCordisLikeCtx('/tmp/proj')
    const harness = harnessFromCordis(ctx)
    assert.equal(harness.roots().length, 1)
    harness.registerTool({ name: 't' })
    assert.equal(state.tools.length, 1)
    harness.promptSection({ name: 'x', text: 'y' })
    assert.equal(state.prompts.length, 1)
    harness.onDispose(() => undefined)
    assert.equal(state.effects.length, 1, 'teardown goes through ctx.effect (cordis v4)')
    harness.on!('tools/pre-execute', () => undefined)
    assert.equal(state.listeners.has('tools/pre-execute'), true)
    harness.provide!('chatInteraction', { ok: true }, true)
    assert.equal(state.provided.has('chatInteraction'), true)
})

test('harnessFromCordis degrades safely on a partial host context', () => {
    const harness = harnessFromCordis({})
    assert.deepEqual(harness.roots(), [])
    assert.doesNotThrow(() => harness.registerTool({}))
    assert.doesNotThrow(() => harness.promptSection({ name: 'a', text: 'b' }))
    assert.doesNotThrow(() => harness.onDispose(() => undefined))
    assert.doesNotThrow(() => harness.on!('x', () => undefined))
    assert.doesNotThrow(() => harness.provide!('k', 1))
    assert.deepEqual(harnessFromCordis(undefined).roots(), [])
})

test('apply() on a real cordis context registers tools, prompts, teardown and service', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cordis-'))
    const { ctx, state } = makeCordisLikeCtx(tmp)
    const layer = apply(ctx as never, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        channels: { feishu: { appId: 'x', appSecret: 'y', enabled: false } },
        channelFactories: { probe: () => new ProbeChannel() },
    } as never) as DshChatLayer
    assert.ok(layer, 'layer assembled from a real cordis ctx')

    const names = (state.tools as Array<{ name: string }>).map((t) => t.name)
    assert.ok(names.includes('probe_send_message'), 'tools landed on ctx.tools.register')
    assert.ok(names.includes('probe_listener'))
    assert.equal(state.prompts.length, 1, 'prompt section landed on ctx.systemPrompt.section')
    assert.equal(state.prompts[0].name, 'probe-channel')
    assert.equal(state.effects.length, 1, 'teardown registered via ctx.effect')
    assert.equal(state.provided.get('chatInteraction'), layer, 'service exported via ctx.provide')

    layer.teardown()
})

test('inbound dispatch through a real cordis ctx reaches agent.followup', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cordis-'))
    const { ctx, state } = makeCordisLikeCtx(tmp)
    const layer = apply(ctx as never, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        channelFactories: { probe: () => new ProbeChannel() },
        channels: {},
    } as never) as DshChatLayer

    await layer.hub.dispatch({
        channel: 'probe',
        chatId: 'c1',
        chatType: 'p2p',
        messageId: 'm1',
        messageType: 'text',
        text: '你好',
    } as InboundMessage)

    assert.equal(state.followups.length, 1, 'followup delivered through ctx.agents.roots()')
    const turn = state.followups[0] as { role: string; content: Array<{ text: string }> }
    assert.equal(turn.role, 'user')
    assert.match(turn.content[0].text, /^\[探针消息\] chat_id: c1/)
    layer.teardown()
})
